"""Forensic OMR debug/trace support.

Observational only: this module never changes recognition behavior. It wraps
the existing layout_worker.py pipeline and records, for a given scan:

  - a scan manifest (layout, input, alignment, counts)
  - an events.jsonl correlation log
  - pipeline stage images (rectified, grayscale, threshold, contours, ROI,
    anchor mapping, final mapping)
  - a per-question trace for focus / auto-flagged questions, including
    per-choice expected vs detected geometry, matching tolerances, ROI
    sampling, and an explicit machine-readable rejection reason for every
    rejected candidate.

Enable via worker option ``forensicDebug: true`` or the environment variable
``SCANCHECK_FORENSIC_DEBUG=1``.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path

import cv2
import numpy as np

DEFAULT_FOCUS_QUESTIONS = set(range(76, 81)) | set(range(85, 91))
AUTO_DEBUG_CONFIDENCE = 0.60
FAR_MAPPING_DISTANCE = 8.0
NEIGHBOR_WINDOW = 150.0
SAMPLE_SEARCH_RADIUS = 3
FALLBACK_MARGIN = 0.08
FALLBACK_MIN_RATIO = 1.25
ROI_DIFFERENCE_MARGIN = 0.08
DEFAULT_FALLBACK_THRESHOLD = 0.38
DEFAULT_BUBBLE_THRESHOLD = 0.38

REASON_CONTOUR_ACCEPTED = "CONTOUR_ACCEPTED"
REASON_CONTOUR_REJECTED_NO_CONTOUR = "CONTOUR_REJECTED_NO_CONTOUR"
REASON_CONTOUR_REJECTED_LOW_DARKNESS = "CONTOUR_REJECTED_LOW_DARKNESS"
REASON_CONTOUR_REJECTED_LOW_CIRCULARITY = "CONTOUR_REJECTED_LOW_CIRCULARITY"
REASON_CONTOUR_REJECTED_BAD_AREA = "CONTOUR_REJECTED_BAD_AREA"
REASON_CONTOUR_REJECTED_BAD_RADIUS = "CONTOUR_REJECTED_BAD_RADIUS"
REASON_CONTOUR_REJECTED_BAD_ASPECT = "CONTOUR_REJECTED_BAD_ASPECT"
REASON_CONTOUR_REJECTED_BAD_OCCUPANCY = "CONTOUR_REJECTED_BAD_OCCUPANCY"
REASON_ROI_REJECT_OUTSIDE_REGION = "ROI_REJECT_OUTSIDE_REGION"
REASON_MAP_REJECT_NO_QUESTION = "MAP_REJECT_NO_QUESTION"
REASON_MAP_REJECT_ROW_TOLERANCE = "MAP_REJECT_ROW_TOLERANCE"
REASON_MAP_REJECT_LANE_TOLERANCE = "MAP_REJECT_LANE_TOLERANCE"
REASON_MAP_REJECT_CROSS_TOLERANCE = "MAP_REJECT_CROSS_TOLERANCE"
REASON_MAP_REJECT_TOO_FAR = "MAP_REJECT_TOO_FAR"
REASON_MAP_DUPLICATE = "MAP_DUPLICATE"
REASON_FALLBACK_ACCEPTED = "FALLBACK_ACCEPTED"
REASON_FALLBACK_REJECT_LOW_DARKNESS = "FALLBACK_REJECT_LOW_DARKNESS"
REASON_FALLBACK_REJECT_LOW_MARGIN = "FALLBACK_REJECT_LOW_MARGIN"
REASON_FALLBACK_REJECT_RATIO = "FALLBACK_REJECT_RATIO"
REASON_ROI_FILL_ACCEPTED = "ROI_FILL_ACCEPTED"
REASON_ROI_FILL_REJECT_THRESHOLD = "ROI_FILL_REJECT_THRESHOLD"
REASON_ROI_FILL_REJECT_MARGIN = "ROI_FILL_REJECT_MARGIN"
REASON_FINAL_DETECTED = "FINAL_DETECTED"
REASON_FINAL_BLANK = "FINAL_BLANK"
REASON_FINAL_MULTIPLE = "FINAL_MULTIPLE"
REASON_FINAL_REVIEW = "FINAL_REVIEW"

SEARCH_PATTERN = [
    (0, 0), (-2, -2), (2, -2), (-2, 2), (2, 2),
    (0, -2), (0, 2), (-2, 0), (2, 0),
    (-3, 0), (3, 0), (0, -3), (0, 3),
]


def _clamp(value, low, high):
    return max(low, min(high, value))


def _slug(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)[:120]


def _json_safe(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _apply_homography(H, x, y):
    if H is None:
        return float(x), float(y)
    pt = np.array([float(x), float(y), 1.0])
    projected = H @ pt
    if projected[2] == 0:
        return float(x), float(y)
    return float(projected[0] / projected[2]), float(projected[1] / projected[2])


def _sample_circle_fallback(gray, cx, cy, r):
    h, w = gray.shape[:2]
    cx = int(round(_clamp(cx, 0, w - 1)))
    cy = int(round(_clamp(cy, 0, h - 1)))
    y1 = max(0, cy - r)
    y2 = min(h, cy + r + 1)
    x1 = max(0, cx - r)
    x2 = min(w, cx + r + 1)
    region = gray[y1:y2, x1:x2]
    if region.size == 0:
        return 0.0
    local_cx = cx - x1
    local_cy = cy - y1
    mask = np.zeros(region.shape, dtype=np.uint8)
    cv2.circle(mask, (local_cx, local_cy), r, 255, -1)
    pixels = region[mask == 255]
    if pixels.size == 0:
        return 0.0
    return float(1.0 - (np.mean(pixels) / 255.0))


def sample_choice_darkness(gray, x, y, radius, H=None, search_radius=SAMPLE_SEARCH_RADIUS):
    """Sample bubble darkness replicating layout_worker.circle_darkness_best.

    Returns center darkness, best darkness over the search pattern, the best
    search offset, the sample radius and the per-offset readings.
    """
    h, w = gray.shape[:2]
    px, py = x, y
    if H is not None:
        px, py = _apply_homography(H, x, y)
    r = max(2, int(round(radius * 0.85)))
    cy_base = int(round(_clamp(py, 0, h - 1)))
    cx_base = int(round(_clamp(px, 0, w - 1)))
    y1 = max(0, cy_base - r - search_radius)
    y2 = min(h, cy_base + r + search_radius + 1)
    x1 = max(0, cx_base - r - search_radius)
    x2 = min(w, cx_base + r + search_radius + 1)
    region = gray[y1:y2, x1:x2]
    if region.size == 0:
        return {
            "centerDarkness": 0.0,
            "bestDarkness": 0.0,
            "bestOffsetX": 0,
            "bestOffsetY": 0,
            "sampleRadius": r,
            "offsets": {},
        }
    local_cx = cx_base - x1
    local_cy = cy_base - y1
    best = 0.0
    best_off = (0, 0)
    center = 0.0
    offsets = {}
    for dy, dx in SEARCH_PATTERN:
        lx = local_cx + dx
        ly = local_cy + dy
        if lx - r < 0 or ly - r < 0 or lx + r >= region.shape[1] or ly + r >= region.shape[0]:
            darkness = _sample_circle_fallback(gray, cx_base + dx, cy_base + dy, r)
        else:
            mask = np.zeros(region.shape, dtype=np.uint8)
            cv2.circle(mask, (lx, ly), r, 255, -1)
            pixels = region[mask == 255]
            if pixels.size == 0:
                offsets["%d,%d" % (dx, dy)] = None
                continue
            darkness = float(1.0 - (np.mean(pixels) / 255.0))
        offsets["%d,%d" % (dx, dy)] = round(float(darkness), 4)
        if dx == 0 and dy == 0:
            center = float(darkness)
        if darkness > best:
            best = float(darkness)
            best_off = (dx, dy)
    return {
        "centerDarkness": round(center, 4),
        "bestDarkness": round(best, 4),
        "bestOffsetX": int(best_off[0]),
        "bestOffsetY": int(best_off[1]),
        "sampleRadius": int(r),
        "offsets": offsets,
    }


def fallback_reason(scores, threshold):
    if not scores:
        return REASON_FALLBACK_REJECT_LOW_DARKNESS, None
    ranked = sorted(scores, key=lambda item: item.get("darkness", 0), reverse=True)
    best = ranked[0]
    second = ranked[1]["darkness"] if len(ranked) > 1 else 0.0
    ft = max(0.34, float(threshold) * 0.85)
    if best["darkness"] < ft:
        return REASON_FALLBACK_REJECT_LOW_DARKNESS, best
    if best["darkness"] - second < FALLBACK_MARGIN:
        return REASON_FALLBACK_REJECT_LOW_MARGIN, best
    if second > 0 and best["darkness"] / second < FALLBACK_MIN_RATIO:
        return REASON_FALLBACK_REJECT_RATIO, best
    return REASON_FALLBACK_ACCEPTED, best


def roi_reason(answer, state, ratios, threshold):
    if state == "detected":
        return REASON_ROI_FILL_ACCEPTED
    if not ratios:
        return REASON_ROI_FILL_REJECT_THRESHOLD
    max_ratio = max(ratios.values())
    if max_ratio < float(threshold):
        return REASON_ROI_FILL_REJECT_THRESHOLD
    return REASON_ROI_FILL_REJECT_MARGIN


class ForensicDebug:
    def __init__(self, scan_id, request_id, layout_id, bundle_root,
                 focus_questions=None):
        self.enabled = True
        self.scan_id = str(scan_id or "")
        self.request_id = str(request_id or "")
        self.layout_id = str(layout_id or "")
        self.bundle_root = Path(bundle_root)
        self.bundle_dir = self.bundle_root / self.scan_id
        self.focus_questions = set(focus_questions or DEFAULT_FOCUS_QUESTIONS)
        self.threshold_mask = None
        self.question_records = []
        self._events_path = self.bundle_dir / "events.jsonl"
        self._events_handle = None
        self._manifest = {
            "scanId": self.scan_id,
            "requestId": self.request_id,
            "layoutId": self.layout_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "bundleVersion": 1,
        }
        self._summary = {}

    # ---------------------------------------------------------------- setup
    def begin(self):
        (self.bundle_dir / "stages").mkdir(parents=True, exist_ok=True)
        (self.bundle_dir / "questions").mkdir(parents=True, exist_ok=True)
        self._events_handle = open(str(self._events_path), "a", encoding="utf-8")
        self.log_event({"event": "scan.started"})

    def log_event(self, event):
        if not self.enabled:
            return
        payload = {
            "scanId": self.scan_id,
            "requestId": self.request_id,
            "layoutId": self.layout_id,
            **event,
        }
        line = json.dumps(payload, sort_keys=True, default=str)
        if self._events_handle is not None:
            self._events_handle.write(line + "\n")
            self._events_handle.flush()

    def _set_manifest(self, key, value):
        self._manifest[key] = _json_safe(value)

    # ---------------------------------------------------------------- inputs
    def record_input(self, **kwargs):
        self._set_manifest("input", kwargs)

    def record_working_image(self, width, height):
        self._set_manifest("workingImage", {"width": width, "height": height})

    def record_alignment(self, **kwargs):
        self._set_manifest("alignment", kwargs)

    def record_counts(self, **kwargs):
        self._set_manifest("counts", kwargs)

    def record_transforms(self, **kwargs):
        self._set_manifest("transforms", kwargs)

    def record_scan_summary(self, summary):
        self._summary = _json_safe(summary)

    # ---------------------------------------------------------------- stages
    def save_stage_image(self, name, image):
        if image is None:
            return None
        path = self.bundle_dir / "stages" / name
        try:
            cv2.imwrite(str(path), image)
            self.log_event({"event": "stage.saved", "stage": name, "path": str(path)})
            return str(path)
        except Exception:
            self.log_event({"event": "stage.save_failed", "stage": name})
            return None

    def draw_candidate_overlay(self, image, bubbles, title="candidates", with_ids=True):
        """Draw every candidate bubble (center + radius + contourId) on an image."""
        if image is None:
            return None
        if len(image.shape) == 2:
            img = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        else:
            img = image.copy()
        green = (40, 180, 40)
        red = (0, 0, 255)
        white = (255, 255, 255)
        for b in bubbles or []:
            bx = int(round(float(b.get("x") or 0)))
            by = int(round(float(b.get("y") or 0)))
            br = int(round(float(b.get("radius") or 5)))
            if bx < -br or by < -br or bx > img.shape[1] + br or by > img.shape[0] + br:
                continue
            cv2.circle(img, (bx, by), max(2, br), green, 1)
            cv2.circle(img, (bx, by), 2, red, -1)
            cid = b.get("contourId")
            if with_ids and cid is not None:
                cv2.putText(img, "#%s" % cid, (bx + br + 2, by - 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, red, 1, cv2.LINE_AA)
        cv2.putText(img, str(title), (6, 16),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, white, 1, cv2.LINE_AA)
        return img

    def draw_anchor_overlay(self, image, anchor_info):
        """Draw expected vs detected registration anchors with residual lines."""
        if image is None:
            return None
        if len(image.shape) == 2:
            img = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        else:
            img = image.copy()
        cyan = (255, 255, 0)
        orange = (0, 165, 255)
        red = (0, 0, 255)
        white = (255, 255, 255)
        for a in (anchor_info or {}).get("anchors") or []:
            ex = float((a.get("expected") or {}).get("x") or 0)
            ey = float((a.get("expected") or {}).get("y") or 0)
            dx = float((a.get("detected") or {}).get("x") or 0)
            dy = float((a.get("detected") or {}).get("y") or 0)
            cv2.drawMarker(img, (int(round(ex)), int(round(ey))), cyan, cv2.MARKER_SQUARE, 14, 1)
            cv2.drawMarker(img, (int(round(dx)), int(round(dy))), orange, cv2.MARKER_CROSS, 10, 1)
            cv2.line(img, (int(round(ex)), int(round(ey))), (int(round(dx)), int(round(dy))), red, 1)
            residual = a.get("residual") or {}
            label = "%s dx=%.1f dy=%.1f d=%.1f" % (
                a.get("anchor") or "?",
                float(residual.get("dx") or 0),
                float(residual.get("dy") or 0),
                float(residual.get("distance") or 0),
            )
            cv2.putText(img, label, (int(round(ex)) + 4, int(round(ey)) - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, white, 1, cv2.LINE_AA)
        return img

    def log_raw_contours(self, bubbles):
        for b in bubbles or []:
            self.log_event({
                "event": "contour.detected",
                "contourId": b.get("contourId"),
                "x": b.get("x"),
                "y": b.get("y"),
                "radius": b.get("radius"),
                "darkness": b.get("darkness"),
                "area": b.get("area"),
                "circularity": b.get("circularity"),
                "occupancy": b.get("occupancy"),
                "confidence": b.get("confidence"),
            })

    def record_roi_filter(self, all_bubbles, kept_bubbles):
        kept = {
            (int(b.get("x") or -1), int(b.get("y") or -1))
            for b in kept_bubbles or []
        }
        for b in all_bubbles or []:
            key = (int(b.get("x") or -1), int(b.get("y") or -1))
            if key not in kept:
                self.log_event({
                    "event": "contour.rejected",
                    "contourId": b.get("contourId"),
                    "x": b.get("x"),
                    "y": b.get("y"),
                    "radius": b.get("radius"),
                    "darkness": b.get("darkness"),
                    "reason": REASON_ROI_REJECT_OUTSIDE_REGION,
                })

    # ---------------------------------------------------------------- anchors
    def record_anchor_transform(self, anchor_info, H, H_inv):
        anchor_payload = {
            "active": bool(anchor_info and anchor_info.get("active")),
            "success": bool(anchor_info and anchor_info.get("success")),
            "method": (anchor_info or {}).get("method"),
            "anchorCount": (anchor_info or {}).get("anchorCount"),
            "detectedCount": (anchor_info or {}).get("detectedCount"),
            "confidence": (anchor_info or {}).get("confidence"),
            "meanError": (anchor_info or {}).get("meanError"),
            "inlierFraction": (anchor_info or {}).get("inlierFraction"),
        }
        anchors = []
        for a in (anchor_info or {}).get("anchors") or []:
            expected = a.get("expected") or {}
            detected = a.get("detected") or {}
            dx = detected.get("x", 0) - expected.get("x", 0)
            dy = detected.get("y", 0) - expected.get("y", 0)
            anchors.append({
                "anchor": a.get("label"),
                "expected": {"x": expected.get("x"), "y": expected.get("y")},
                "detected": {"x": detected.get("x"), "y": detected.get("y")},
                "residual": {
                    "dx": round(dx, 3),
                    "dy": round(dy, 3),
                    "distance": round(math.hypot(dx, dy), 3),
                },
                "area": a.get("area"),
                "size": a.get("size"),
            })
        anchor_payload["anchors"] = anchors
        anchor_payload["homographyMatrix"] = _json_safe(H)
        anchor_payload["inverseHomographyMatrix"] = _json_safe(H_inv)
        self._set_manifest("transforms", {
            "anchor": anchor_payload,
            "section": self._manifest.get("transforms", {}).get("section"),
        })
        for a in anchors:
            self.log_event({
                "event": "anchor.detected",
                "anchor": a["anchor"],
                "residual": a["residual"],
            })

    def record_section_transform(self, H, info, accepted, rejection_reason=None):
        payload = {
            "active": bool(accepted),
            "proposedMatrix": _json_safe(H),
            "confidence": (info or {}).get("confidence"),
            "pointCount": (info or {}).get("point_count"),
            "inliers": (info or {}).get("inliers"),
            "inlierRatio": (info or {}).get("inlier_ratio"),
            "meanError": (info or {}).get("mean_error"),
            "maxError": (info or {}).get("max_error"),
            "error": (info or {}).get("error"),
            "rejectionReason": rejection_reason,
        }
        current = self._manifest.get("transforms", {})
        current["section"] = payload
        self._set_manifest("transforms", current)
        self.log_event({
            "event": "section.transform",
            "active": bool(accepted),
            "confidence": payload["confidence"],
            "pointCount": payload["pointCount"],
            "rejectionReason": rejection_reason,
        })

    # ---------------------------------------------------------------- questions
    def add_question_record(self, record):
        self.question_records.append(record)

    def _same_row_groups(self):
        groups = {}
        for rec in self.question_records:
            key = (str(rec.get("subject") or ""), round(float(rec.get("rowY") or 0), 1))
            groups.setdefault(key, []).append(rec)
        return groups

    def _flag_reason(self, rec):
        reasons = []
        state = rec.get("state")
        if state in ("blank", "multiple"):
            reasons.append("STATE_%s" % (state or "UNKNOWN").upper())
        if float(rec.get("confidence") or 0) < AUTO_DEBUG_CONFIDENCE:
            reasons.append("LOW_CONFIDENCE")
        source = rec.get("detectionSource") or state
        if source in ("fallback_sampled", "roi_fill"):
            reasons.append("SOURCE_%s" % str(source).upper())
        assigned = rec.get("assigned") or []
        if any(float(item.get("distance") or 0) > FAR_MAPPING_DISTANCE for item in assigned):
            reasons.append("FAR_MAPPING_DISTANCE")
        return reasons

    def _build_focus_set(self):
        focus = set(self.focus_questions)
        groups = self._same_row_groups()
        for rec in self.question_records:
            if not self._flag_reason(rec):
                continue
            gno = int(rec.get("globalNo") or 0)
            focus.add(gno)
            focus.add(gno - 1)
            focus.add(gno + 1)
            for member in groups.get((str(rec.get("subject") or ""), round(float(rec.get("rowY") or 0), 1)), []):
                focus.add(int(member.get("globalNo") or 0))
        return focus

    def finalize_questions(self, gray, fallback_H, fallback_threshold):
        if not self.question_records:
            return
        focus = self._build_focus_set()
        groups = self._same_row_groups()
        for rec in self.question_records:
            gno = int(rec.get("globalNo") or 0)
            if gno not in focus:
                continue
            trace = self._build_question_trace(
                rec, gray, fallback_H, fallback_threshold, groups
            )
            self._write_question_bundle(rec, trace, gray)

    def _nearest_contour(self, rec, choice, bubbles):
        best = None
        best_dist = None
        for b in bubbles or []:
            bx = float(b.get("x") or 0)
            by = float(b.get("y") or 0)
            dist = math.hypot(bx - float(choice["x"]), by - float(choice["y"]))
            if best_dist is None or dist < best_dist:
                best = b
                best_dist = dist
        if best is None or best_dist is None:
            return None, None
        return best, best_dist

    def _build_question_trace(self, rec, gray, fallback_H, fallback_threshold, groups):
        gno = int(rec.get("globalNo") or 0)
        orientation = rec.get("orientation") or "horizontal"
        row_y = float(rec.get("rowY") or 0)
        row_left = float(rec.get("rowLeft") or 0)
        row_right = float(rec.get("rowRight") or 0)
        row_top = float(rec.get("rowTop") or 0)
        row_bottom = float(rec.get("rowBottom") or 0)
        row_y_tol = float(rec.get("rowYTol") or 10.0)
        lane_tol = float(rec.get("laneTol") or 15.0)
        cross_tol = float(rec.get("crossTol") or 10.0)
        bubbles = rec.get("subjectBubbles") or []

        same_row = sorted(
            m.get("globalNo") for m in groups.get(
                (str(rec.get("subject") or ""), round(row_y, 1)), []
            )
        )
        state = rec.get("state")
        source = rec.get("detectionSource") or state
        trace = {
            "scanId": self.scan_id,
            "requestId": self.request_id,
            "layoutId": self.layout_id,
            "globalQuestion": gno,
            "subject": rec.get("subject"),
            "subjectName": rec.get("subjectName"),
            "localQuestion": rec.get("localNo"),
            "rowY": round(row_y, 2),
            "orientation": orientation,
            "state": state,
            "answer": rec.get("displayAnswer"),
            "detectionSource": source,
            "confidence": round(float(rec.get("confidence") or 0), 4),
            "neighbors": {
                "previousGlobal": gno - 1 if gno - 1 >= 1 else None,
                "nextGlobal": gno + 1,
                "sameRowGlobal": same_row,
            },
            "expectedChoices": {
                str(c["label"]): {
                    "layoutX": round(float(c["x"]), 2),
                    "layoutY": round(float(c["y"]), 2),
                    "radius": round(float(c["radius"]), 2),
                }
                for c in rec.get("choices") or []
            },
            "choices": [],
            "detectedContours": [],
            "decision": {},
        }

        for choice in rec.get("choices") or []:
            trace["choices"].append(
                self._trace_choice(choice, rec, bubbles, gray, fallback_H,
                                   fallback_threshold, orientation, row_y,
                                   row_left, row_right, row_top, row_bottom,
                                   row_y_tol, lane_tol, cross_tol)
            )

        for item in rec.get("assigned") or []:
            dup = False
            winner = (rec.get("bestByChoice") or {}).get(item.get("choice"))
            if winner is not None and winner is not item:
                dup = True
            trace["detectedContours"].append({
                "contourId": item.get("contourId"),
                "choice": item.get("choice"),
                "layoutX": item.get("x"),
                "layoutY": item.get("y"),
                "rawX": item.get("rawX"),
                "rawY": item.get("rawY"),
                "darkness": item.get("darkness"),
                "distance": item.get("distance"),
                "source": item.get("source"),
                "reason": REASON_MAP_DUPLICATE if dup else REASON_CONTOUR_ACCEPTED,
            })
            self.log_event({
                "event": "contour.mapped",
                "globalQuestion": gno,
                "subject": rec.get("subject"),
                "localQuestion": rec.get("localNo"),
                "contourId": item.get("contourId"),
                "choice": item.get("choice"),
                "reason": REASON_MAP_DUPLICATE if dup else REASON_CONTOUR_ACCEPTED,
            })

        fallback_scores = rec.get("fallbackScores") or []
        fallback_threshold_used = float(fallback_threshold)
        if fallback_scores:
            fbk_reason, _ = fallback_reason(fallback_scores, fallback_threshold_used)
        else:
            fbk_reason = None
        roi_ratios = rec.get("roiRatios") or {}
        if rec.get("roiOverride"):
            roi_reason_val = REASON_ROI_FILL_ACCEPTED
        elif roi_ratios:
            roi_reason_val = roi_reason(rec.get("answer"), state, roi_ratios, fallback_threshold_used)
        else:
            roi_reason_val = None

        if state == "detected":
            final_reason = REASON_FINAL_DETECTED
        elif state == "multiple":
            final_reason = REASON_FINAL_MULTIPLE
        else:
            final_reason = REASON_FINAL_BLANK
        decision_parts = [final_reason]
        if fbk_reason:
            decision_parts.append(fbk_reason)
        if roi_reason_val:
            decision_parts.append(roi_reason_val)
        decision_reason = " | ".join(decision_parts)

        trace["decision"] = {
            "state": state,
            "selectedChoice": rec.get("displayAnswer") if state == "detected" else None,
            "detectionSource": source,
            "confidence": round(float(rec.get("confidence") or 0), 4),
            "reason": decision_reason,
            "fallback": {
                "attempted": bool(fallback_scores),
                "scores": [
                    {
                        "choice": item.get("choice", {}).get("label") if isinstance(item.get("choice"), dict) else item.get("choice"),
                        "darkness": item.get("darkness"),
                    }
                    for item in fallback_scores
                ],
                "threshold": round(fallback_threshold_used, 3),
                "reason": fbk_reason,
            },
            "roi": {
                "attempted": rec.get("roiRatios") is not None,
                "ratios": roi_ratios,
                "threshold": round(fallback_threshold_used, 3),
                "margin": round(ROI_DIFFERENCE_MARGIN, 3),
                "reason": roi_reason_val,
            },
            "flagReasons": self._flag_reason(rec),
        }
        self.log_event({
            "event": "question.final",
            "globalQuestion": gno,
            "subject": rec.get("subject"),
            "localQuestion": rec.get("localNo"),
            "state": state,
            "answer": rec.get("displayAnswer"),
            "confidence": trace["confidence"],
            "reason": decision_reason,
        })
        return trace

    def _trace_choice(self, choice, rec, bubbles, gray, fallback_H,
                      fallback_threshold, orientation, row_y, row_left,
                      row_right, row_top, row_bottom, row_y_tol, lane_tol,
                      cross_tol):
        cx = float(choice["x"])
        cy = float(choice["y"])
        cr = float(choice["radius"])
        gno = int(rec.get("globalNo") or 0)

        expected = {
            "layoutX": round(cx, 2),
            "layoutY": round(cy, 2),
            "radius": round(cr, 2),
        }
        proj_x, proj_y = _apply_homography(fallback_H, cx, cy)
        projected = {
            "imageX": round(proj_x, 2),
            "imageY": round(proj_y, 2),
            "transformSource": "anchor_inverse" if fallback_H is not None else "identity",
        }

        nearest, nearest_dist = self._nearest_contour(rec, choice, bubbles)
        nearest_info = {
            "found": False,
            "reason": REASON_MAP_REJECT_NO_QUESTION,
        }
        matching = {}
        if nearest is not None and nearest_dist is not None:
            found = nearest_dist <= NEIGHBOR_WINDOW
            if found:
                bx = float(nearest.get("x") or 0)
                by = float(nearest.get("y") or 0)
                if orientation == "horizontal":
                    in_row_box = (
                        row_left - lane_tol <= bx <= row_right + lane_tol
                        and row_top - row_y_tol <= by <= row_bottom + row_y_tol
                    )
                    row_passed = in_row_box and abs(by - row_y) <= row_y_tol
                    axis_dist = abs(bx - cx)
                    cross_dist = abs(by - cy)
                else:
                    in_row_box = (
                        row_top - lane_tol <= by <= row_bottom + lane_tol
                        and row_left - row_y_tol <= bx <= row_right + row_y_tol
                    )
                    row_passed = in_row_box
                    axis_dist = abs(by - cy)
                    cross_dist = abs(bx - cx)
                lane_passed = axis_dist <= lane_tol
                cross_passed = cross_dist <= cross_tol
                dx = bx - cx
                dy = by - cy
                reasons = []
                if not row_passed:
                    reasons.append(REASON_MAP_REJECT_ROW_TOLERANCE)
                if not lane_passed:
                    reasons.append(REASON_MAP_REJECT_LANE_TOLERANCE)
                if not cross_passed:
                    reasons.append(REASON_MAP_REJECT_CROSS_TOLERANCE)
                if not reasons:
                    reasons = [REASON_CONTOUR_ACCEPTED]
                nearest_info = {
                    "found": True,
                    "contourId": nearest.get("contourId"),
                    "rawX": nearest.get("rawX"),
                    "rawY": nearest.get("rawY"),
                    "layoutX": round(bx, 2),
                    "layoutY": round(by, 2),
                    "dx": round(dx, 2),
                    "dy": round(dy, 2),
                    "distance": round(math.hypot(dx, dy), 2),
                    "area": nearest.get("area"),
                    "radius": nearest.get("radius"),
                    "circularity": nearest.get("circularity"),
                    "occupancy": nearest.get("occupancy"),
                    "darkness": nearest.get("darkness"),
                    "confidence": nearest.get("confidence"),
                    "reason": " | ".join(reasons),
                }
                matching = {
                    "rowTolerance": round(row_y_tol, 2),
                    "laneTolerance": round(lane_tol, 2),
                    "crossTolerance": round(cross_tol, 2),
                    "rowPassed": bool(row_passed),
                    "lanePassed": bool(lane_passed),
                    "crossPassed": bool(cross_passed),
                    "rowDistance": round(by - row_y, 2),
                    "laneDistance": round(axis_dist, 2),
                    "crossDistance": round(cross_dist, 2),
                }
                for r in reasons:
                    if r != REASON_CONTOUR_ACCEPTED:
                        self.log_event({
                            "event": "contour.rejected",
                            "globalQuestion": gno,
                            "subject": rec.get("subject"),
                            "localQuestion": rec.get("localNo"),
                            "contourId": nearest.get("contourId"),
                            "choice": choice["label"],
                            "reason": r,
                        })
            else:
                nearest_info = {
                    "found": False,
                    "distance": round(float(nearest_dist), 2),
                    "reason": REASON_MAP_REJECT_TOO_FAR,
                }

        sampling = sample_choice_darkness(gray, cx, cy, cr, H=fallback_H)
        ft = max(0.34, float(fallback_threshold) * 0.85)
        second_best = sorted(
            [v for v in (sampling.get("offsets") or {}).values() if v is not None],
            reverse=True,
        )
        second_darkness = float(second_best[1]) if len(second_best) > 1 else 0.0
        sampling["secondBestDarkness"] = second_darkness
        sampling["threshold"] = round(ft, 3)
        sampling["margin"] = round(sampling["bestDarkness"] - second_darkness, 4)

        sample_reason = REASON_FALLBACK_ACCEPTED
        if sampling["bestDarkness"] < ft:
            sample_reason = REASON_FALLBACK_REJECT_LOW_DARKNESS
        elif sampling["bestDarkness"] - second_darkness < FALLBACK_MARGIN:
            sample_reason = REASON_FALLBACK_REJECT_LOW_MARGIN
        elif second_darkness > 0 and sampling["bestDarkness"] / second_darkness < FALLBACK_MIN_RATIO:
            sample_reason = REASON_FALLBACK_REJECT_RATIO

        self.log_event({
            "event": "question.choice.sample",
            "globalQuestion": gno,
            "subject": rec.get("subject"),
            "localQuestion": rec.get("localNo"),
            "choice": choice["label"],
            "darkness": sampling["bestDarkness"],
            "threshold": ft,
        })

        return {
            "choice": choice["label"],
            "expected": expected,
            "projected": projected,
            "nearestContour": nearest_info,
            "matching": matching,
            "sampling": sampling,
            "decision": {
                "reason": nearest_info.get("reason") if nearest_info.get("found") else sample_reason,
            },
        }

    def _write_question_bundle(self, rec, trace, gray):
        gno = int(rec.get("globalNo") or 0)
        qdir = self.bundle_dir / "questions" / ("Q%03d" % gno)
        qdir.mkdir(parents=True, exist_ok=True)
        with open(str(qdir / "trace.json"), "w", encoding="utf-8") as handle:
            json.dump(trace, handle, indent=2, sort_keys=True)

        row_y = float(rec.get("rowY") or 0)
        row_top = float(rec.get("rowTop") or row_y - 8)
        row_bottom = float(rec.get("rowBottom") or row_y + 8)
        choices = rec.get("choices") or []
        min_x = min(float(c["x"]) for c in choices) if choices else row_y
        max_x = max(float(c["x"]) for c in choices) if choices else row_y
        pad = 24.0
        x1 = int(max(0, min_x - pad))
        x2 = int(min(gray.shape[1], max_x + pad))
        y1 = int(max(0, row_top - pad))
        y2 = int(min(gray.shape[0], row_bottom + pad))
        if x2 <= x1 or y2 <= y1:
            x1, y1 = 0, 0
            x2, y2 = gray.shape[1], gray.shape[0]

        gray_crop = gray[y1:y2, x1:x2]
        cv2.imwrite(str(qdir / "gray.png"), gray_crop)

        if self.threshold_mask is not None:
            try:
                thr_crop = self.threshold_mask[y1:y2, x1:x2]
                cv2.imwrite(str(qdir / "threshold.png"), thr_crop)
            except Exception:
                self.log_event({"event": "question.threshold.unavailable",
                                "globalQuestion": gno})
        else:
            self.log_event({"event": "question.threshold.unavailable",
                            "globalQuestion": gno,
                            "reason": "NOT_AVAILABLE_AT_THIS_STAGE"})

        contours_img = self._draw_contours_image(gray_crop, rec, x1, y1)
        cv2.imwrite(str(qdir / "contours.png"), contours_img)

        roi_img = self._draw_roi_image(gray_crop, trace, x1, y1)
        cv2.imwrite(str(qdir / "roi.png"), roi_img)

        self.log_event({"event": "question.bundle.saved",
                        "globalQuestion": gno,
                        "path": str(qdir)})

    def _draw_contours_image(self, gray_crop, rec, x1, y1):
        img = cv2.cvtColor(gray_crop, cv2.COLOR_GRAY2BGR)
        cyan = (255, 255, 0)
        green = (40, 180, 40)
        red = (0, 0, 255)
        for c in rec.get("choices") or []:
            px = int(round(float(c["x"]) - x1))
            py = int(round(float(c["y"]) - y1))
            pr = int(round(float(c["radius"])))
            cv2.circle(img, (px, py), max(3, pr), cyan, 1)
            cv2.putText(img, str(c["label"]), (px - 12, py - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, cyan, 1, cv2.LINE_AA)
        for b in rec.get("subjectBubbles") or []:
            bx = int(round(float(b.get("rawX") or b.get("x") or 0) - x1))
            by = int(round(float(b.get("rawY") or b.get("y") or 0) - y1))
            br = int(round(float(b.get("radius") or 5)))
            if bx < -br or by < -br or bx > img.shape[1] + br or by > img.shape[0] + br:
                continue
            cv2.circle(img, (bx, by), max(2, br), green, 1)
            cv2.circle(img, (bx, by), 2, green, -1)
            cid = b.get("contourId")
            if cid is not None:
                cv2.putText(img, "#%s" % cid, (bx + br + 2, by - 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, red, 1, cv2.LINE_AA)
        return img

    def _draw_roi_image(self, gray_crop, trace, x1, y1):
        img = cv2.cvtColor(gray_crop, cv2.COLOR_GRAY2BGR)
        cyan = (255, 255, 0)
        orange = (0, 165, 255)
        green = (40, 180, 40)
        red = (0, 0, 255)
        white = (255, 255, 255)
        label_y = 14
        for c in trace.get("choices") or []:
            expected = c.get("expected") or {}
            projected = c.get("projected") or {}
            ex = int(round(float(expected.get("layoutX", 0)) - x1))
            ey = int(round(float(expected.get("layoutY", 0)) - y1))
            er = int(round(float(expected.get("radius", 6))))
            sx = int(round(float(projected.get("imageX", expected.get("layoutX", 0))) - x1))
            sy = int(round(float(projected.get("imageY", expected.get("layoutY", 0))) - y1))
            cv2.circle(img, (ex, ey), max(3, er), cyan, 1)
            cv2.putText(img, "E", (ex - 12, ey + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, cyan, 1, cv2.LINE_AA)
            cv2.drawMarker(img, (sx, sy), orange, cv2.MARKER_CROSS, 8, 1)
            nearest = c.get("nearestContour") or {}
            if nearest.get("found"):
                nx = int(round(float(nearest.get("rawX", 0)) - x1))
                ny = int(round(float(nearest.get("rawY", 0)) - y1))
                color = red
                for r in str(nearest.get("reason") or "").split(" | "):
                    if r == "CONTOUR_ACCEPTED":
                        color = green
                cv2.drawMarker(img, (nx, ny), color, cv2.MARKER_TILTED_CROSS, 10, 1)
                cv2.line(img, (sx, sy), (nx, ny), color, 1)
                sampling = c.get("sampling") or {}
                text = "%s dx=%.1f dy=%.1f d=%.1f dark=%.2f th=%.2f m=%.3f state=%s" % (
                    c.get("choice"),
                    float(nearest.get("dx") or 0),
                    float(nearest.get("dy") or 0),
                    float(nearest.get("distance") or 0),
                    float(sampling.get("bestDarkness") or 0),
                    float(sampling.get("threshold") or 0),
                    float(sampling.get("margin") or 0),
                    trace.get("state"),
                )
                cv2.putText(img, text, (4, label_y),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, white, 1, cv2.LINE_AA)
                label_y += 12
        return img

    # ---------------------------------------------------------------- close
    def close(self, result=None):
        self.log_event({"event": "scan.finished"})
        if self._events_handle is not None:
            self._events_handle.close()
            self._events_handle = None
        manifest_path = self.bundle_dir / "manifest.json"
        with open(str(manifest_path), "w", encoding="utf-8") as handle:
            json.dump(self._manifest, handle, indent=2, sort_keys=True)
        summary_path = self.bundle_dir / "scan-summary.json"
        with open(str(summary_path), "w", encoding="utf-8") as handle:
            json.dump(self._summary, handle, indent=2, sort_keys=True)
        return str(self.bundle_dir)
