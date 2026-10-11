#!/usr/bin/env python3
import json
import sys

import cv2
import numpy as np


def order_points(pts):
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def _quad_area(quad):
    return float(cv2.contourArea(np.asarray(quad, dtype="float32").reshape(4, 2)))


def _is_useful_quad(quad, image_shape):
    h, w = image_shape[:2]
    image_area = float(h * w)
    area = _quad_area(quad)
    if area < image_area * 0.18 or area > image_area * 0.98:
        return False
    ordered = order_points(np.asarray(quad, dtype="float32").reshape(4, 2))
    edge_lengths = [
        np.linalg.norm(ordered[1] - ordered[0]),
        np.linalg.norm(ordered[2] - ordered[1]),
        np.linalg.norm(ordered[2] - ordered[3]),
        np.linalg.norm(ordered[3] - ordered[0]),
    ]
    return min(edge_lengths) > min(w, h) * 0.15


def detect_paper_from_light_mask(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    _h, saturation, value = cv2.split(hsv)

    # Phone photos here are usually a white/gray sheet on colored cloth.
    # This mask isolates low-saturation bright paper without using answer marks.
    mask = np.zeros(value.shape, dtype=np.uint8)
    mask[((saturation < 82) & (value > 95)) | (value > 175)] = 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8), iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8), iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    image_area = image.shape[0] * image.shape[1]
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.18:
            continue

        hull = cv2.convexHull(contour)
        perimeter = cv2.arcLength(hull, True)
        approx = cv2.approxPolyDP(hull, 0.025 * perimeter, True)
        if len(approx) == 4:
            quad = approx.reshape(4, 2).astype("float32")
        else:
            rect = cv2.minAreaRect(hull)
            quad = cv2.boxPoints(rect).astype("float32")

        if _is_useful_quad(quad, image.shape):
            candidates.append((_quad_area(quad), quad))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return order_points(candidates[0][1])


def detect_document(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 150)
    edged = cv2.dilate(edged, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.shape[0] * image.shape[1]
    candidates = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.08:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) == 4:
            candidates.append((area, approx.reshape(4, 2).astype("float32")))
    if not candidates:
        paper_quad = detect_paper_from_light_mask(image)
        if paper_quad is not None:
            return paper_quad, "paper_mask"
        h, w = image.shape[:2]
        return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype="float32"), "full_frame"
    candidates.sort(key=lambda item: item[0], reverse=True)
    edge_quad = order_points(candidates[0][1])
    if _is_useful_quad(edge_quad, image.shape):
        return edge_quad, "document_quad"
    paper_quad = detect_paper_from_light_mask(image)
    if paper_quad is not None:
        return paper_quad, "paper_mask"
    return edge_quad, "document_quad"


def _parse_bubble_probes(raw):
    """Flatten layout bubble boxes so the warp can be scored against real marks.

    A printed bubble has a visible outline whether or not the student filled it,
    so ink presence at these coordinates is a valid alignment signal that needs
    no answer key. Returns a flat list of [left, top, right, bottom].
    """
    try:
        parsed = json.loads(raw or "[]")
    except Exception:
        return []
    probes = []
    if not isinstance(parsed, list):
        return probes
    for box in parsed:
        try:
            left = float(box[0])
            top = float(box[1])
            right = float(box[2])
            bottom = float(box[3])
        except Exception:
            continue
        if right > left and bottom > top:
            probes.append([left, top, right, bottom])
    return probes


def measure_bubble_coverage(image, probes, dark_ratio=0.05):
    """Fraction of known bubble positions that actually contain ink.

    This is the ground-truth-free alignment metric. A correct warp puts printed
    bubble outlines inside their expected boxes, so coverage near 1.0 means the
    layout geometry and the physical sheet agree. Low coverage means the warp is
    wrong, which is far cheaper to detect here than to discover as a page of
    unexplained blanks later.
    """
    if not probes:
        return None
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    hits = 0
    sampled = 0
    for left, top, right, bottom in probes:
        x1 = max(0, int(round(left)))
        y1 = max(0, int(round(top)))
        x2 = min(w, int(round(right)))
        y2 = min(h, int(round(bottom)))
        if x2 <= x1 or y2 <= y1:
            continue
        sampled += 1
        patch = gray[y1:y2, x1:x2]
        if patch.size == 0:
            continue
        if float((patch < 128).mean()) > dark_ratio:
            hits += 1
    if sampled == 0:
        return None
    return round(hits / float(sampled), 4)


def _parse_layout_anchors(raw):
    try:
        parsed = json.loads(raw or "{}")
    except Exception:
        return []
    anchors = []
    if not isinstance(parsed, dict):
        return anchors
    for name, info in parsed.items():
        try:
            x = float(info.get("x"))
            y = float(info.get("y"))
            radius = float(info.get("radius") or info.get("box", {}).get("width", 21) / 2.0)
        except Exception:
            continue
        if np.isfinite(x) and np.isfinite(y):
            anchors.append({"name": str(name), "x": x, "y": y, "radius": max(4.0, radius)})
    return anchors


def _detect_source_anchor_candidates(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, dark = cv2.threshold(gray, 90, 255, cv2.THRESH_BINARY_INV)
    # NOTE: no morphological opening here. A 2x2 OPEN erodes the printed
    # registration marks, which are thin and only a few pixels across on a
    # phone photo, and can erase them outright.

    h, w = image.shape[:2]
    min_side = float(min(w, h))
    min_dim = max(4.0, min_side * 0.004)
    max_dim = max(24.0, min_side * 0.085)

    # Connected components, not findContours(RETR_EXTERNAL). RETR_EXTERNAL keeps
    # only the outermost boundary, so on any scan with a dark border or a dark
    # region touching the frame edge the entire image collapses into a single
    # contour. Measured on a real phone scan that yielded exactly 1 contour and
    # therefore 0 anchor candidates, which silently forced every such scan down
    # the unverified document_quad fallback. connectedComponents separates the
    # same image into thousands of discrete blobs.
    count, _labels, stats, centroids = cv2.connectedComponentsWithStats(
        (dark > 0).astype(np.uint8), 8
    )

    candidates = []
    for index in range(1, count):
        x, y, bw, bh, area = (
            int(stats[index, cv2.CC_STAT_LEFT]),
            int(stats[index, cv2.CC_STAT_TOP]),
            int(stats[index, cv2.CC_STAT_WIDTH]),
            int(stats[index, cv2.CC_STAT_HEIGHT]),
            float(stats[index, cv2.CC_STAT_AREA]),
        )
        if area <= 0:
            continue
        if bw < min_dim or bh < min_dim or bw > max_dim or bh > max_dim:
            continue
        # Printed registration marks blur and skew on phone photos, so keep a
        # wider band of shapes than a clean scan would need. RANSAC consensus in
        # _fit_anchor_homography rejects spurious matches downstream.
        aspect = bw / float(bh)
        if aspect < 0.45 or aspect > 2.2:
            continue
        fill = area / float(bw * bh)
        if fill < 0.28:
            continue
        candidates.append({
            "center": [float(centroids[index][0]), float(centroids[index][1])],
            "bbox": [int(x), int(y), int(bw), int(bh)],
            "area": round(area, 3),
            "fill": round(fill, 3)
        })

    return candidates


def _match_source_anchors_to_layout(candidates, anchors, image_shape, layout_width, layout_height, tolerance=1.0):
    if len(candidates) < 3 or len(anchors) < 3:
        return []

    centers = np.asarray([candidate["center"] for candidate in candidates], dtype=np.float32)
    min_x, min_y = np.min(centers, axis=0)
    max_x, max_y = np.max(centers, axis=0)
    source_w = max(1.0, float(max_x - min_x))
    source_h = max(1.0, float(max_y - min_y))
    h, w = image_shape[:2]
    max_distance = max(28.0, min(w, h) * 0.16) * max(1.0, float(tolerance))

    matches = []
    used = set()
    ordered_anchors = sorted(
        anchors,
        key=lambda anchor: 0 if anchor["name"] in {"top-left", "top-right", "bottom-left", "bottom-right"} else 1
    )

    for anchor in ordered_anchors:
        expected_ratio_x = float(anchor["x"]) / max(1.0, float(layout_width))
        expected_ratio_y = float(anchor["y"]) / max(1.0, float(layout_height))
        estimate = np.array([
            min_x + expected_ratio_x * source_w,
            min_y + expected_ratio_y * source_h
        ], dtype=np.float32)

        best_index = None
        best_distance = float("inf")
        for index, candidate in enumerate(candidates):
            if index in used:
                continue
            distance = float(np.linalg.norm(np.asarray(candidate["center"], dtype=np.float32) - estimate))
            if distance < best_distance:
                best_distance = distance
                best_index = index

        if best_index is not None and best_distance <= max_distance:
            used.add(best_index)
            candidate = candidates[best_index]
            matches.append({
                "name": anchor["name"],
                "observed": candidate["center"],
                "expected": [float(anchor["x"]), float(anchor["y"])],
                "bbox": candidate["bbox"],
                "dist": round(best_distance, 3)
            })

    return matches


def warp_from_source_registration_anchors(image, anchors, width, height):
    candidates = _detect_source_anchor_candidates(image)
    attempts = []
    for tolerance in ANCHOR_TOLERANCE_LADDER:
        matches = _match_source_anchors_to_layout(candidates, anchors, image.shape, width, height, tolerance)
        H, validation = _fit_anchor_homography(matches)
        attempts.append({
            "tolerance": tolerance,
            "matchCount": len(matches),
            "reason": validation.get("reason"),
            "rmsError": validation.get("rmsError")
        })
        if H is None:
            continue
        warped = cv2.warpPerspective(image, H, (width, height))
        validation["active"] = True
        validation["tolerance"] = tolerance
        validation["detectedCount"] = len(candidates)
        validation["attempts"] = attempts
        validation["matches"] = matches
        return warped, validation

    return None, {
        "active": False,
        "detectedCount": len(candidates),
        "attempts": attempts,
        "reason": "no_source_tolerance_matched"
    }


def _detect_anchor_at(gray, anchor, tolerance=1.0):
    ex = float(anchor["x"])
    ey = float(anchor["y"])
    radius = float(anchor.get("radius") or 10.5)
    scale = max(1.0, float(tolerance))
    search = int(max(42, radius * 5.5) * scale)
    h, w = gray.shape[:2]
    x1 = max(0, int(round(ex - search)))
    y1 = max(0, int(round(ey - search)))
    x2 = min(w, int(round(ex + search)))
    y2 = min(h, int(round(ey + search)))
    if x2 <= x1 or y2 <= y1:
        return None

    roi = gray[y1:y2, x1:x2]
    _, dark = cv2.threshold(roi, 120, 255, cv2.THRESH_BINARY_INV)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    best = None
    best_score = float("inf")
    kernel3 = np.ones((3, 3), np.uint8)
    expected_size = radius * 2.0
    for erode_iters in range(4):
        level = dark if erode_iters == 0 else cv2.erode(dark, kernel3, iterations=erode_iters)
        contours, _ = cv2.findContours(level, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < expected_size * expected_size * 0.20 or area > expected_size * expected_size * 4.0:
                continue
            bx, by, bw, bh = cv2.boundingRect(contour)
            if bw <= 0 or bh <= 0:
                continue
            aspect = bw / float(bh)
            if aspect < 0.55 or aspect > 1.85:
                continue
            cx = x1 + bx + bw / 2.0
            cy = y1 + by + bh / 2.0
            dist = float(np.hypot(cx - ex, cy - ey))
            size_penalty = abs(bw - expected_size) + abs(bh - expected_size)
            score = dist + size_penalty * 0.35 + abs(bw - bh) * 0.6
            if score < best_score:
                best_score = score
                best = {
                    "name": anchor["name"],
                    "observed": [float(cx), float(cy)],
                    "expected": [ex, ey],
                    "bbox": [int(x1 + bx), int(y1 + by), int(bw), int(bh)],
                    "score": round(score, 3),
                    "dist": round(dist, 3)
                }
    if best is None:
        return None

    # A registration anchor may sit further from its nominal position when the
    # initial page quad is imperfect. Loosening this gate is safe because the
    # caller validates the resulting homography globally via RANSAC inlier
    # reprojection error, which is far stronger than a per-anchor distance cap.
    max_dist = max(30.0, radius * 3.0) * scale
    if float(best["dist"]) > max_dist:
        best["rejected"] = True
        best["rejectionReason"] = "too_far_from_expected"
        best["maxDistance"] = round(float(max_dist), 3)
        return None
    return best


def _fit_anchor_homography(detections, min_inliers=4, ransac_threshold=6.0, max_rms_error=8.0):
    """Fit observed->expected homography and validate it globally.

    Individual anchor distances are unreliable on real phone photos, so instead
    of rejecting anchors that sit far from their nominal spot we let RANSAC
    find the consensus and then validate the fit by reprojection error. A bad
    quad produces scattered anchors with high RMS and is rejected here; a merely
    offset quad still yields a tight, low-error fit and is accepted.

    OpenCV requires at least 4 correspondences for a homography, so 4 is also
    the hard floor for min_inliers.
    """
    # cv2.findHomography requires >= 4 points; never call it with fewer.
    min_inliers = max(4, int(min_inliers))
    if not detections or len(detections) < min_inliers:
        return None, {"reason": "insufficient_detections", "detectedCount": len(detections or [])}

    src = np.asarray([item["observed"] for item in detections], dtype=np.float32)
    dst = np.asarray([item["expected"] for item in detections], dtype=np.float32)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, ransac_threshold)
    if H is None:
        return None, {"reason": "homography_failed", "detectedCount": len(detections)}

    inlier_mask = mask.ravel().astype(bool) if mask is not None else np.ones(len(detections), dtype=bool)
    inlier_count = int(np.count_nonzero(inlier_mask))
    if inlier_count < min_inliers:
        return None, {
            "reason": "insufficient_inliers",
            "detectedCount": len(detections),
            "inlierCount": inlier_count
        }

    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inlier_errors = errors[inlier_mask]
    rms_error = float(np.sqrt(np.mean(np.square(inlier_errors))))
    max_error = float(np.max(inlier_errors))
    if rms_error > max_rms_error:
        return None, {
            "reason": "reprojection_error_too_high",
            "detectedCount": len(detections),
            "inlierCount": inlier_count,
            "rmsError": round(rms_error, 3),
            "maxError": round(max_error, 3)
        }

    return H, {
        "reason": None,
        "detectedCount": len(detections),
        "inlierCount": inlier_count,
        "rmsError": round(rms_error, 3),
        "maxError": round(max_error, 3),
        "matches": detections
    }


# Progressive relaxation. Tight enough first to avoid matching stray text,
# loose enough to recover real anchors on imperfect photos.
ANCHOR_TOLERANCE_LADDER = (1.0, 1.75, 2.5, 3.5)

# Fraction of known bubble positions that must contain printed ink for the warp
# to be trusted. Measured 0.63 on a real phone scan whose layout predated a
# generator geometry change, which is exactly the silent-misalignment case this
# guards against. A correct warp lands outlines in their expected boxes.
MIN_BUBBLE_COVERAGE = 0.80


def refine_with_registration_anchors(warped, anchors):
    if not anchors:
        return warped, {"active": False, "detectedCount": 0}

    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    attempts = []
    for tolerance in ANCHOR_TOLERANCE_LADDER:
        detections = []
        for anchor in anchors:
            detected = _detect_anchor_at(gray, anchor, tolerance)
            if detected is not None:
                detections.append(detected)
        H, validation = _fit_anchor_homography(detections)
        attempts.append({
            "tolerance": tolerance,
            "detectedCount": len(detections),
            "reason": validation.get("reason"),
            "rmsError": validation.get("rmsError")
        })
        if H is None:
            continue
        refined = cv2.warpPerspective(warped, H, (warped.shape[1], warped.shape[0]))
        validation["active"] = True
        validation["tolerance"] = tolerance
        validation["attempts"] = attempts
        validation["anchors"] = detections
        return refined, validation

    return warped, {
        "active": False,
        "attempts": attempts,
        "reason": "no_tolerance_matched"
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: pagePrepWorker.py WIDTH HEIGHT")
    width = int(float(sys.argv[1]))
    height = int(float(sys.argv[2]))
    anchors = _parse_layout_anchors(sys.argv[3] if len(sys.argv) >= 4 else "{}")
    probes = _parse_bubble_probes(sys.argv[4] if len(sys.argv) >= 5 else "[]")
    raw = sys.stdin.buffer.read()
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit("invalid image")

    source_anchor_info = {"active": False, "reason": "not_attempted"}
    warped, source_anchor_info = warp_from_source_registration_anchors(image, anchors, width, height)
    quad = None
    if warped is not None:
        mode = "source_registration_anchors"
        coverage = measure_bubble_coverage(warped, probes)
        source_anchor_info["bubbleCoverage"] = coverage
        # A homography can fit the registration marks and still leave the answer
        # grid offset. Keep the document_quad alternative so the better-aligned
        # warp can be chosen on evidence rather than on which branch ran first.
        quad_alt, mode_alt = detect_document(image)
        alt_matrix = cv2.getPerspectiveTransform(
            quad_alt, np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
        )
        warped_alt = cv2.warpPerspective(image, alt_matrix, (width, height))
        coverage_alt = measure_bubble_coverage(warped_alt, probes)
        source_anchor_info["bubbleCoverageAlternative"] = coverage_alt
        source_anchor_info["alternativeMode"] = mode_alt
        if coverage is not None and coverage_alt is not None and coverage_alt > coverage:
            warped = warped_alt
            mode = mode_alt
            coverage = coverage_alt
            source_anchor_info["selectedBy"] = "bubble_coverage"
            quad = quad_alt
    else:
        quad, mode = detect_document(image)
        dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
        matrix = cv2.getPerspectiveTransform(quad, dst)
        warped = cv2.warpPerspective(image, matrix, (width, height))
        coverage = measure_bubble_coverage(warped, probes)
    warped, anchor_info = refine_with_registration_anchors(warped, anchors)
    coverage = measure_bubble_coverage(warped, probes)
    anchor_info["bubbleCoverage"] = coverage
    if coverage is not None and coverage < MIN_BUBBLE_COVERAGE:
        anchor_info["coverageWarning"] = "low_bubble_coverage"
    ok, encoded = cv2.imencode(".jpg", warped, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise SystemExit("encode failed")
    if anchor_info.get("active"):
        mode = f"{mode}_anchor_refined"
    sys.stderr.write(json.dumps({
        "mode": mode,
        "quad": quad.tolist() if quad is not None else None,
        "width": width,
        "height": height,
        "bubbleCoverage": coverage,
        "sourceAnchorAlignment": source_anchor_info,
        "anchorRefinement": anchor_info
    }) + "\n")
    sys.stdout.buffer.write(encoded.tobytes())


if __name__ == "__main__":
    main()
