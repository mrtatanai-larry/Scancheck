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


def _detect_anchor_at(gray, anchor):
    ex = float(anchor["x"])
    ey = float(anchor["y"])
    radius = float(anchor.get("radius") or 10.5)
    search = int(max(42, radius * 5.5))
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

    # A registration anchor may be missing after a loose page crop. Do not let
    # nearby text, page edges, or background texture become a control point.
    max_dist = max(30.0, radius * 3.0)
    if float(best["dist"]) > max_dist:
        best["rejected"] = True
        best["rejectionReason"] = "too_far_from_expected"
        return None
    return best


def refine_with_registration_anchors(warped, anchors):
    if not anchors:
        return warped, {"active": False, "detectedCount": 0}

    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    detections = []
    for anchor in anchors:
        detected = _detect_anchor_at(gray, anchor)
        if detected is not None:
            detections.append(detected)

    if len(detections) < 5:
        return warped, {
            "active": False,
            "detectedCount": len(detections),
            "anchors": detections,
            "reason": "insufficient_anchors"
        }

    src = np.array([item["observed"] for item in detections], dtype=np.float32)
    dst = np.array([item["expected"] for item in detections], dtype=np.float32)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if H is None:
        return warped, {
            "active": False,
            "detectedCount": len(detections),
            "anchors": detections,
            "reason": "homography_failed"
        }

    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inlier_mask = mask.ravel().astype(bool) if mask is not None else np.ones(len(detections), dtype=bool)
    inlier_count = int(np.count_nonzero(inlier_mask))
    if inlier_count < 5:
        return warped, {
            "active": False,
            "detectedCount": len(detections),
            "anchors": detections,
            "reason": "insufficient_inliers"
        }
    prefit_distances = np.array([float(item.get("dist", 9999.0)) for item in detections], dtype=np.float32)
    inlier_prefit = prefit_distances[inlier_mask]
    if float(np.mean(inlier_prefit)) > 18.0 or float(np.max(inlier_prefit)) > 32.0:
        return warped, {
            "active": False,
            "detectedCount": len(detections),
            "inlierCount": inlier_count,
            "anchors": detections,
            "reason": "anchors_too_far_from_expected",
            "meanObservedDistance": round(float(np.mean(inlier_prefit)), 3),
            "maxObservedDistance": round(float(np.max(inlier_prefit)), 3)
        }

    refined = cv2.warpPerspective(warped, H, (warped.shape[1], warped.shape[0]))
    return refined, {
        "active": True,
        "detectedCount": len(detections),
        "inlierCount": inlier_count,
        "meanError": round(float(np.mean(errors[inlier_mask])), 3),
        "maxError": round(float(np.max(errors[inlier_mask])), 3),
        "anchors": detections
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: pagePrepWorker.py WIDTH HEIGHT")
    width = int(float(sys.argv[1]))
    height = int(float(sys.argv[2]))
    anchors = _parse_layout_anchors(sys.argv[3] if len(sys.argv) >= 4 else "{}")
    raw = sys.stdin.buffer.read()
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit("invalid image")

    quad, mode = detect_document(image)
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
    matrix = cv2.getPerspectiveTransform(quad, dst)
    warped = cv2.warpPerspective(image, matrix, (width, height))
    warped, anchor_info = refine_with_registration_anchors(warped, anchors)
    ok, encoded = cv2.imencode(".jpg", warped, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise SystemExit("encode failed")
    if anchor_info.get("active"):
        mode = f"{mode}_anchor_refined"
    sys.stderr.write(json.dumps({
        "mode": mode,
        "quad": quad.tolist(),
        "width": width,
        "height": height,
        "anchorRefinement": anchor_info
    }) + "\n")
    sys.stdout.buffer.write(encoded.tobytes())


if __name__ == "__main__":
    main()
