import json
import math
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np

try:
    from pyzbar import pyzbar
    HAS_PYZBAR = True
except ImportError:
    HAS_PYZBAR = False

# Optional: CNN-based bubble fill classifier
try:
    from bubble_cnn_classifier import (
        predict as cnn_predict,
        classify as cnn_classify,
        is_model_available as cnn_model_available,
        get_cnn_fused_darkness,
    )
    HAS_CNN_CLASSIFIER = cnn_model_available()
except Exception:
    HAS_CNN_CLASSIFIER = False


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_ROOT = Path(os.getenv("SCANCHECK_RUNTIME_ROOT", REPO_ROOT / ".runtime"))
if not RUNTIME_ROOT.is_absolute():
    RUNTIME_ROOT = REPO_ROOT / RUNTIME_ROOT

DEBUG_DIR = Path(os.getenv("SCANCHECK_UPLOADS_DEBUG_DIR", RUNTIME_ROOT / "data" / "uploads" / "debug"))
LAYOUT_DIR = Path(os.getenv("SCANCHECK_OMR_LAYOUT_DIR", RUNTIME_ROOT / "data" / "omr-layouts"))

SEARCH_PATTERN = [
    (0, 0), (-2, -2), (2, -2), (-2, 2), (2, 2),
    (0, -2), (0, 2), (-2, 0), (2, 0),
    (-3, 0), (3, 0), (0, -3), (0, 3),
]


def clamp(value, low, high):
    return max(low, min(high, value))


def slug_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)[:120]


def order_points(pts):
    pts = np.array(pts, dtype=np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    return np.array(
        [
            pts[np.argmin(s)],
            pts[np.argmin(diff)],
            pts[np.argmax(s)],
            pts[np.argmax(diff)],
        ],
        dtype=np.float32,
    )


def _compute_content_offset(gray, layout):
    """
    Compute the (dx, dy) offset between where content actually appears in
    the warped image and where the layout expects it.

    This is used as a fallback when find_border_offset cannot detect the
    4 px sheet border (e.g. because the border was cropped or is invisible
    in the photo).

    The expected content origin is derived from the minimum x/y among all
    layout elements (bubbles, entry group, equity group).  The actual
    content origin is found by scanning the warped image for the first
    dense cluster of dark pixels.
    """
    h, w = gray.shape[:2]
    _, dark = cv2.threshold(gray, 60, 255, cv2.THRESH_BINARY_INV)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))

    rows = np.any(dark == 255, axis=1)
    cols = np.any(dark == 255, axis=0)
    y_idx = np.where(rows)[0]
    x_idx = np.where(cols)[0]
    if len(y_idx) < 20 or len(x_idx) < 20:
        return 0, 0

    actual_x = int(np.median(x_idx[:max(5, len(x_idx) // 20)]))
    actual_y = int(np.median(y_idx[:max(5, len(y_idx) // 20)]))

    expected_x = layout.get("_contentOriginX", 999999)
    expected_y = layout.get("_contentOriginY", 999999)
    if expected_x > w * 0.8 or expected_y > h * 0.8:
        expected_x = _min_element_x(layout, w)
        expected_y = _min_element_y(layout, h)

    dx = actual_x - expected_x
    dy = actual_y - expected_y
    return dx, dy


def _min_element_x(layout, fallback=0):
    best = 999999
    for subj in layout.get("subjects") or []:
        for q in subj.get("questions") or []:
            for b in (q.get("choices") or {}).values():
                v = float(b.get("x", 999999))
                if v < best:
                    best = v
    return best if best < 999000 else fallback


def _min_element_y(layout, fallback=0):
    best = 999999
    for subj in layout.get("subjects") or []:
        for q in subj.get("questions") or []:
            for b in (q.get("choices") or {}).values():
                v = float(b.get("y", 999999))
                if v < best:
                    best = v
    return best if best < 999000 else fallback


def _scan_sheet_boundary(image, dark_thresh=60, step=8, density_thresh=0.015, margin_frac=0.30, expand_px=40):
    """
    Find the answer sheet boundary by scanning inward from each image edge
    and locating where dense dark content begins.  The answer sheet has a
    4 px black border on a white background, with dense content (text,
    bubbles, grid lines) spread across the whole sheet.

    The returned boundary is expanded outward by *expand_px* on each side to
    include the sheet's dark border and small margins so that after the
    perspective warp the sheet edge aligns with the layout coordinate origin.

    Returns (left, top, right, bottom) in image pixel coordinates, or
    (0, 0, w-1, h-1) if no reliable boundary is found.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    h, w = image.shape[:2]

    _, dark = cv2.threshold(blur, dark_thresh, 255, cv2.THRESH_BINARY_INV)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    limit = int(min(h, w) * margin_frac)

    # top
    top = 0
    for y in range(0, limit, step):
        strip = dark[y:y + step, :]
        if np.mean(strip == 255) > density_thresh:
            top = max(0, y - step)
            break

    # bottom
    bottom = h - 1
    for y in range(h - 1, h - limit, -step):
        y_start = max(0, y - step)
        strip = dark[y_start:y, :]
        if np.mean(strip == 255) > density_thresh:
            bottom = min(h - 1, y + step)
            break

    # left
    left = 0
    for x in range(0, limit, step):
        strip = dark[:, x:x + step]
        if np.mean(strip == 255) > density_thresh:
            left = max(0, x - step)
            break

    # right
    right = w - 1
    for x in range(w - 1, w - limit, -step):
        x_start = max(0, x - step)
        strip = dark[:, x_start:x]
        if np.mean(strip == 255) > density_thresh:
            right = min(w - 1, x + step)
            break

    # Expand outward to include the dark border area
    top = max(0, top - expand_px)
    left = max(0, left - expand_px)
    bottom = min(h - 1, bottom + expand_px)
    right = min(w - 1, right + expand_px)

    return left, top, right, bottom


def _compute_adaptive_canny_thresholds(gray):
    """Compute Canny thresholds adapted to image brightness and contrast.

    Uses Otsu's method as a reference point and adjusts based on the
    median brightness of the image.
    """
    median_brightness = float(np.median(gray))
    # Compute local std as a measure of contrast
    block_size = 51
    mean = cv2.blur(gray, (block_size, block_size))
    std = cv2.blur(gray**2, (block_size, block_size)) - mean**2
    std = np.sqrt(np.maximum(std, 0))
    mean_contrast = float(np.mean(std))

    # Otsu threshold gives us a data-driven separation point
    otsu_ret, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Low-light images (< 100 median) need lower thresholds
    if median_brightness < 80:
        low = max(10, int(otsu_ret * 0.20))
        high = max(30, int(otsu_ret * 0.55))
    elif median_brightness < 130:
        low = max(15, int(otsu_ret * 0.25))
        high = max(40, int(otsu_ret * 0.65))
    else:
        low = max(20, int(otsu_ret * 0.30))
        high = max(55, int(otsu_ret * 0.75))

    # Low-contrast images: relax thresholds to find edges
    if mean_contrast < 30:
        low = max(5, low // 2)
        high = max(20, high // 2)

    return low, high


def assess_image_quality(image):
    """Assess image quality metrics: blur, contrast, brightness.

    Returns a dict with:
      - blurScore: 0 (sharp) to 1 (very blurry)
      - contrastScore: 0 (low contrast) to 1 (good)
      - brightnessScore: 0 (too dark/bright) to 1 (good)
      - overallQuality: 0-1 weighted average
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Blur detection: Laplacian variance
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    laplacian_var = float(np.var(laplacian))
    # High variance = sharp, low = blurry
    # Map: var < 100 => blurry, var > 500 => sharp
    blur_score = 1.0 - min(1.0, max(0.0, (laplacian_var - 100.0) / 400.0))

    # Contrast: std of pixel intensities
    std_val = float(np.std(gray))
    contrast_score = min(1.0, std_val / 80.0)

    # Brightness: prefer mid-range (avoid too dark or overexposed)
    mean_brightness = float(np.mean(gray))
    if mean_brightness < 50:
        brightness_score = mean_brightness / 50.0  # 0 at 0, 1 at 50
    elif mean_brightness > 220:
        brightness_score = (255.0 - mean_brightness) / 35.0  # 0 at 255, 1 at 220
    else:
        brightness_score = 1.0

    overall = 0.4 * (1.0 - blur_score) + 0.3 * contrast_score + 0.3 * brightness_score

    return {
        "blurScore": round(blur_score, 3),
        "laplacianVariance": round(laplacian_var, 1),
        "contrastScore": round(contrast_score, 3),
        "pixelStd": round(std_val, 1),
        "brightnessScore": round(brightness_score, 3),
        "meanBrightness": round(mean_brightness, 1),
        "overallQuality": round(overall, 3),
    }


def _find_best_rotation(image, layout_width, layout_height, max_angle=3.0, step=1.0):
    """Try small rotations around 0 to find the angle that gives the
    best border alignment after warp.

    Returns (best_angle, best_quad, best_border_offset) or (0, quad, 0).
    """
    h, w = image.shape[:2]
    center = (w / 2.0, h / 2.0)

    quad = detect_document(image)
    if quad is None:
        return 0.0, None, 0

    best_angle = 0.0
    best_offset = 999
    best_quad = quad

    angles = [0.0]
    angle = -max_angle
    while angle <= max_angle:
        if abs(angle) > 0.01:
            angles.append(angle)
        angle += step

    for angle in angles:
        if abs(angle) > 0.01:
            rot_matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
            rotated = cv2.warpAffine(image, rot_matrix, (w, h))
            q = detect_document(rotated)
        else:
            rotated = image
            q = quad

        if q is None:
            continue

        # Warp to layout size and check border offset
        normalized, _, _ = warp_to_size(rotated, q, layout_width, layout_height)
        if normalized is None:
            continue
        gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
        dx, dy, info = find_border_offset(gray)

        sides_detected = sum([
            1 if info.get("detectedTop") else 0,
            1 if info.get("detectedLeft") else 0,
            1 if info.get("detectedRight") else 0,
            1 if info.get("detectedBottom") else 0,
        ])

        if sides_detected >= 3:
            offset_mag = abs(dx) + abs(dy)
            if offset_mag < best_offset:
                best_offset = offset_mag
                best_angle = angle
                # Store the quad of the un-rotated image transformed back
                if abs(angle) > 0.01:
                    # Rotate quad back to original image space
                    inv_matrix = cv2.getRotationMatrix2D(center, -angle, 1.0)
                    q_h = np.array([q[0][0], q[0][1], 1.0])
                    # We can't easily de-rotate quad points, so just store
                    # the quad in the rotated frame — caller will rotate image instead
                    best_quad = q
                else:
                    best_quad = q

    return best_angle, best_quad, best_offset if best_offset < 999 else 0


def detect_document(image):
    """
    Detect the answer sheet quadrilateral in the image.
    Uses density-based scanning to find the sheet boundary, then falls back
    to contour detection for perspective-distorted images, then to the full
    image.

    Returns 4 corner points in [top-left, top-right, bottom-right,
    bottom-left] order.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    # Strategy 1: density-based boundary detection (primary)
    left, top, right, bottom = _scan_sheet_boundary(image)
    bbox_area = (right - left) * (bottom - top)
    if bbox_area > h * w * 0.30:
        quad = np.array([[left, top], [right, top], [right, bottom], [left, bottom]], dtype=np.float32)
        return order_points(quad)

    # Strategy 2: Canny + contour detection for perspective-distorted images
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(blur)
    # Use adaptive thresholds instead of hardcoded 25, 80
    low_thresh, high_thresh = _compute_adaptive_canny_thresholds(gray)
    edges = cv2.Canny(clahe, low_thresh, high_thresh)
    vclosed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((61, 3), np.uint8), iterations=2)
    hclosed = cv2.morphologyEx(vclosed, cv2.MORPH_CLOSE, np.ones((3, 61), np.uint8), iterations=2)
    contours, _ = cv2.findContours(hclosed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        min_area = h * w * 0.50
        best = None
        best_area = 0
        for c in contours:
            area = cv2.contourArea(c)
            if area < min_area or area <= best_area:
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            if len(approx) == 4:
                best = approx.reshape(4, 2)
                best_area = area
            else:
                x, y, cw, ch = cv2.boundingRect(c)
                best = np.array([[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]], dtype=np.float32)
                best_area = area
        if best is not None:
            return order_points(best)

    # Strategy 3: full image fallback
    return order_points(np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32))


def warp_to_size(image, quad, width, height):
    if quad is None:
        return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA), "direct_resize", None
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(np.array(quad, dtype=np.float32), dst)
    return cv2.warpPerspective(image, matrix, (width, height)), "warp", np.array(quad).tolist()


def decode_qr_from_image(image):
    if not HAS_PYZBAR:
        return {}, "pyzbar_missing"

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    variants = [
        gray,
        cv2.convertScaleAbs(gray, alpha=1.5, beta=0),
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
    ]

    for candidate in variants:
        for barcode in pyzbar.decode(candidate):
            if barcode.type != "QRCODE":
                continue
            data = barcode.data.decode("utf-8", errors="ignore").strip()
            if not data:
                continue
            try:
                payload = json.loads(data)
                if isinstance(payload, dict):
                    return {
                        "sheetId": str(payload.get("sheetId") or payload.get("sheet_id") or "").strip(),
                        "studentId": str(payload.get("studentId") or payload.get("student_id") or "").strip(),
                        "examId": str(payload.get("examId") or payload.get("exam_id") or payload.get("quizId") or payload.get("quiz_id") or "").strip(),
                        "exam_id": str(payload.get("exam_id") or payload.get("examId") or payload.get("quizId") or payload.get("quiz_id") or "").strip(),
                        "studentName": str(payload.get("studentName") or payload.get("student_name") or "").strip(),
                        "course": str(payload.get("course") or "").strip(),
                        "age": str(payload.get("age") or "").strip(),
                        "roomNo": str(payload.get("roomNo") or payload.get("room_no") or "").strip(),
                        "seatNo": str(payload.get("seatNo") or payload.get("seat_no") or "").strip(),
                        "dateTime": str(payload.get("dateTime") or payload.get("date_time") or "").strip(),
                    }, "qr_success"
            except Exception:
                pass

            if data.startswith("SCANCHECK|"):
                parts = data.split("|")
                return {
                    "studentId": parts[1] if len(parts) > 1 else "",
                    "sheetId": parts[1] if len(parts) > 1 else "",
                    "studentName": parts[2] if len(parts) > 2 else "",
                    "course": parts[3] if len(parts) > 3 else "",
                    "age": parts[4] if len(parts) > 4 else "",
                    "roomNo": parts[5] if len(parts) > 5 else "",
                    "seatNo": parts[6] if len(parts) > 6 else "",
                    "dateTime": parts[7] if len(parts) > 7 else "",
                    "examId": parts[10] if len(parts) > 10 else "",
                    "exam_id": parts[10] if len(parts) > 10 else "",
                }, "qr_success"

            return {"studentId": data, "sheetId": data}, "qr_success"

    return {}, "not_found"


def load_layout(exam_id, layouts_dir):
    safe = slug_id(exam_id)
    if not safe:
        raise ValueError("QR code not detected.")
    path = Path(layouts_dir) / f"{safe}.json"
    if not path.exists():
        raise FileNotFoundError("Layout not found.")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle), str(path)


def count_layout_bubbles(layout):
    count = 0
    count += len((layout.get("entryGroup") or layout.get("entry_group") or {}).keys())
    count += len((layout.get("equityGroup") or layout.get("equity_group") or {}).keys())
    for subject in layout.get("subjects") or []:
        for question in subject.get("questions") or []:
            count += len((question.get("choices") or {}).keys())
    return count


def circular_mask(shape, center, radius):
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.circle(mask, (int(round(center[0])), int(round(center[1]))), int(round(radius)), 255, -1)
    return mask


def contour_confidence(gray, dark_mask, center, radius):
    mask = circular_mask(gray.shape, center, radius)
    pixel_count = int(cv2.countNonZero(mask))
    if pixel_count == 0:
        return 0.0, 0.0

    dark_pixels = int(cv2.countNonZero(cv2.bitwise_and(dark_mask, dark_mask, mask=mask)))
    darkness = dark_pixels / float(pixel_count)
    mean_gray = float(cv2.mean(gray, mask=mask)[0])
    tone_score = max(0.0, min(1.0, (255.0 - mean_gray) / 255.0))
    return darkness, max(darkness, tone_score)


def dedupe_detected_circles(circles):
    if not circles:
        return []

    kept = []
    for circle in sorted(circles, key=lambda item: item["darkness"], reverse=True):
        cx = float(circle["x"])
        cy = float(circle["y"])
        radius = float(circle["radius"])
        duplicate = False
        for existing in kept:
            dx = cx - float(existing["x"])
            dy = cy - float(existing["y"])
            min_radius = min(radius, float(existing["radius"]))
            if math.hypot(dx, dy) <= max(4.0, min_radius * 0.75):
                duplicate = True
                break
        if not duplicate:
            kept.append(circle)
    return sorted(kept, key=lambda item: (item["y"], item["x"]))


def detect_filled_bubble_contours(image):
    """
    Find actual shaded circular marks in the normalized sheet image.
    This is intentionally detector-only: it does not know questions,
    choices, entry group labels, or equity labels.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    adaptive = cv2.adaptiveThreshold(
        blur,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        10,
    )
    dark_mask = cv2.bitwise_and(otsu, adaptive)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(dark_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape[:2]
    image_area = float(width * height)
    short_side = float(min(width, height))

    min_area = max(45.0, image_area * 0.000015)
    max_area = max(700.0, image_area * 0.0018)
    min_radius = max(4.0, short_side * 0.003)
    max_radius = max(18.0, short_side * 0.035)

    circles = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area or area > max_area:
            continue

        perimeter = float(cv2.arcLength(contour, True))
        if perimeter <= 0:
            continue

        circularity = (4.0 * math.pi * area) / (perimeter * perimeter)
        if circularity < 0.62:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if w <= 0 or h <= 0:
            continue

        aspect_ratio = w / float(h)
        if aspect_ratio < 0.72 or aspect_ratio > 1.28:
            continue

        (cx, cy), radius = cv2.minEnclosingCircle(contour)
        if radius < min_radius or radius > max_radius:
            continue

        circle_area = math.pi * radius * radius
        occupancy = area / circle_area if circle_area else 0.0
        if occupancy < 0.48 or occupancy > 1.18:
            continue

        darkness, confidence = contour_confidence(gray, dark_mask, (cx, cy), radius)
        if darkness < 0.48:
            continue

        circles.append({
            "x": int(round(cx)),
            "y": int(round(cy)),
            "radius": int(round(radius)),
            "darkness": round(float(darkness), 4),
            "confidence": round(float(confidence), 4),
            "area": round(area, 2),
            "circularity": round(float(circularity), 4),
        })

    # Optional: run CNN classifier on each detected bubble for refined scoring
    if HAS_CNN_CLASSIFIER and circles:
        for bubble in circles:
            try:
                prob = cnn_predict(
                    gray,
                    float(bubble["x"]),
                    float(bubble["y"]),
                    float(bubble["radius"]),
                )
                if prob is not None:
                    bubble["cnnProbability"] = round(float(prob), 4)
                    # Fused score: weighted combination
                    bubble["fusedScore"] = round(
                        0.35 * prob + 0.65 * bubble["darkness"], 4
                    )
                else:
                    bubble["cnnProbability"] = None
                    bubble["fusedScore"] = bubble["darkness"]
            except Exception:
                bubble["cnnProbability"] = None
                bubble["fusedScore"] = bubble["darkness"]

    return dedupe_detected_circles(circles), dark_mask


def _choice_items(choices):
    if not isinstance(choices, dict):
        return []
    out = []
    for label, bubble in choices.items():
        out.append({
            "label": str(label),
            "x": float(bubble.get("x") or 0),
            "y": float(bubble.get("y") or 0),
            "radius": float(bubble.get("radius") or 8),
        })
    return out


def _median_spacing(values, fallback):
    values = sorted(float(v) for v in values)
    if len(values) < 2:
        return fallback
    gaps = [values[i] - values[i - 1] for i in range(1, len(values)) if values[i] - values[i - 1] > 0.5]
    return float(np.median(gaps)) if gaps else fallback


def _orientation(items):
    if len(items) < 2:
        return "horizontal"
    xs = [item["x"] for item in items]
    ys = [item["y"] for item in items]
    return "horizontal" if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else "vertical"


def _bounds_from_items(items, margin=18.0):
    if not items:
        return None
    return {
        "left": min(item["x"] - item["radius"] for item in items) - margin,
        "top": min(item["y"] - item["radius"] for item in items) - margin,
        "right": max(item["x"] + item["radius"] for item in items) + margin,
        "bottom": max(item["y"] + item["radius"] for item in items) + margin,
    }


def _inside_bounds(x, y, bounds):
    if not bounds:
        return False
    return bounds["left"] <= x <= bounds["right"] and bounds["top"] <= y <= bounds["bottom"]


def _block_bounds(block, margin=14.0):
    return {
        "left": float(block.get("left", 0)) - margin,
        "top": float(block.get("top", 0)) - margin,
        "right": float(block.get("right", float(block.get("left", 0)) + float(block.get("width", 0)))) + margin,
        "bottom": float(block.get("bottom", float(block.get("top", 0)) + float(block.get("height", 0)))) + margin,
    }


def _build_scan_regions(layout):
    regions = []
    for subj in layout.get("subjects") or []:
        blk = subj.get("block")
        if blk:
            regions.append((
                float(blk.get("left", 0)) - 12.0,
                float(blk.get("top", 0)) - 12.0,
                float(blk.get("left", 0)) + float(blk.get("width", 0)) + 12.0,
                float(blk.get("top", 0)) + float(blk.get("height", 0)) + 12.0,
            ))
    for group_key in ("entryGroup", "entry_group", "equityGroup", "equity_group"):
        group = layout.get(group_key) or {}
        items = _choice_items(group)
        if items:
            xs = [item["x"] for item in items]
            ys = [item["y"] for item in items]
            max_r = max(item["radius"] for item in items)
            margin = 18.0 + max_r
            regions.append((
                min(xs) - margin, min(ys) - margin,
                max(xs) + margin, max(ys) + margin,
            ))
    return regions


def _inside_any_region(bubble, regions):
    bx, by = float(bubble["x"]), float(bubble["y"])
    for x1, y1, x2, y2 in regions:
        if x1 <= bx <= x2 and y1 <= by <= y2:
            return True
    return False


def classify_detected_group(bubbles, choices, group_name, allow_multiple=True):
    items = _choice_items(choices)
    metrics = [
        {
            "label": item["label"],
            "darkness": 0.0,
            "x": int(round(item["x"])),
            "y": int(round(item["y"])),
            "radius": item["radius"],
            "filled": False,
        }
        for item in items
    ]
    if not items:
        return {"value": None, "values": [], "status": "blank", "detected": [], "metrics": metrics, "mappedBubbles": []}

    orientation = _orientation(items)
    bounds = _bounds_from_items(items, margin=22.0)
    axis_values = [item["x"] if orientation == "horizontal" else item["y"] for item in items]
    cross_values = [item["y"] if orientation == "horizontal" else item["x"] for item in items]
    spacing = _median_spacing(axis_values, fallback=max(item["radius"] for item in items) * 2.4)
    axis_tol = max(13.0, spacing * 0.58, max(item["radius"] for item in items) * 1.45)
    cross_tol = max(16.0, _median_spacing(cross_values, fallback=0.0) * 0.35, max(item["radius"] for item in items) * 1.8)

    best_by_label = {}
    for bubble in bubbles:
        bx = float(bubble["x"])
        by = float(bubble["y"])
        if not _inside_bounds(bx, by, bounds):
            continue

        best = None
        best_score = float("inf")
        for item in items:
            axis_dist = abs((bx - item["x"]) if orientation == "horizontal" else (by - item["y"]))
            cross_dist = abs((by - item["y"]) if orientation == "horizontal" else (bx - item["x"]))
            if axis_dist > axis_tol or cross_dist > cross_tol:
                continue
            score = axis_dist + cross_dist * 0.5
            if score < best_score:
                best = item
                best_score = score

        if best is None:
            continue

        mapped = {
            **bubble,
            "target": group_name,
            "label": best["label"],
            "distance": round(float(best_score), 2),
            "expectedCenter": {"x": best["x"], "y": best["y"]},
        }
        current = best_by_label.get(best["label"])
        if current is None or mapped.get("darkness", 0) > current.get("darkness", 0):
            best_by_label[best["label"]] = mapped

    mapped_bubbles = sorted(best_by_label.values(), key=lambda item: item["distance"])
    detected_labels = [item["label"] for item in mapped_bubbles]

    for metric in metrics:
        matched = best_by_label.get(metric["label"])
        if matched:
            metric["filled"] = True
            metric["darkness"] = matched.get("darkness", 0)
            metric["detectedCenter"] = {"x": matched["x"], "y": matched["y"]}
            metric["mappingDistance"] = matched["distance"]

    if not detected_labels:
        status = "blank"
    elif not allow_multiple and len(detected_labels) > 1:
        status = "multiple"
    elif allow_multiple:
        status = "valid"
    else:
        status = "valid"

    value = detected_labels[0] if status == "valid" and detected_labels and not allow_multiple else None
    return {
        "value": value,
        "values": detected_labels if allow_multiple else ([detected_labels[0]] if status == "valid" and detected_labels else []),
        "status": status,
        "detected": mapped_bubbles,
        "metrics": metrics,
        "mappedBubbles": mapped_bubbles,
    }


def _fallback_sampled_choice(gray, entry, threshold, H=None):
    if gray is None or H is None:
        return None, []

    scores = []
    for choice in entry.get("choices") or []:
        darkness = circle_darkness_best(
            gray,
            float(choice["x"]),
            float(choice["y"]),
            float(choice.get("radius") or 8),
            search_radius=6,
            H=H,
        )
        raw_x, raw_y = _apply_point_transform(H, choice["x"], choice["y"])
        scores.append({
            "choice": choice,
            "darkness": round(float(darkness), 4),
            "rawX": raw_x,
            "rawY": raw_y,
        })

    ranked = sorted(scores, key=lambda item: item["darkness"], reverse=True)
    if not ranked:
        return None, scores

    best = ranked[0]
    second = ranked[1]["darkness"] if len(ranked) > 1 else 0.0
    fallback_threshold = max(0.34, float(threshold) * 0.85)
    if best["darkness"] < fallback_threshold:
        return None, scores
    if best["darkness"] - second < 0.08:
        return None, scores
    if second > 0 and best["darkness"] / second < 1.25:
        return None, scores

    choice = best["choice"]
    return {
        "x": int(round(choice["x"])),
        "y": int(round(choice["y"])),
        "rawX": int(round(best["rawX"])),
        "rawY": int(round(best["rawY"])),
        "radius": int(round(float(choice.get("radius") or 8))),
        "darkness": best["darkness"],
        "confidence": best["darkness"],
        "area": None,
        "circularity": None,
        "source": "anchor_sample_fallback",
        "choice": choice["label"],
        "label": choice["label"],
        "distance": 0.0,
        "expectedCenter": {"x": choice["x"], "y": choice["y"]},
    }, scores


def _roi_fill_classifier(gray, choices, fallback_H=None, fill_threshold=0.38, difference_margin=0.08):
    """Classify question by ROI fill-ratio sampling only.

    Returns (answer, state, ratios) where:
    - answer: single letter, '' (blank), or 'multiple'
    - state: 'detected', 'blank', or 'multiple'
    - ratios: dict mapping label -> fill_ratio
    """
    if gray is None:
        return "", "blank", {}

    ratios = {}
    for ch in choices:
        cx, cy, cr = ch["x"], ch["y"], ch["radius"]
        darkness = circle_darkness_best(gray, cx, cy, cr, H=fallback_H)
        ratios[ch["label"]] = round(darkness, 3)

    sorted_r = sorted(ratios.items(), key=lambda x: x[1], reverse=True)
    if not sorted_r:
        return "", "blank", ratios

    max_ratio = sorted_r[0][1]
    second_ratio = sorted_r[1][1] if len(sorted_r) > 1 else 0

    if max_ratio < fill_threshold:
        return "", "blank", ratios
    if max_ratio - second_ratio >= difference_margin:
        return sorted_r[0][0], "detected", ratios
    return "multiple", "multiple", ratios


PROBLEM_QUESTIONS = {84, 86, 87, 90, 91}


def classify_detected_answers(bubbles, layout, gray=None, fallback_H=None, fallback_threshold=0.38, debug_dir=None, request_id="", debug_ratios=False):
    answers = []
    answers_by_subject = {}
    question_metrics = []
    mapped_bubbles = []
    flat_index = 0

    for subject in layout.get("subjects") or []:
        subject_code = str(subject.get("code") or subject.get("name") or "").strip()
        subject_name = str(subject.get("name") or subject_code).strip()
        block = subject.get("block") or {}
        block_bounds = _block_bounds(block, margin=18.0)
        subject_bubbles = [
            bubble for bubble in bubbles
            if _inside_bounds(float(bubble["x"]), float(bubble["y"]), block_bounds)
        ]
        questions = subject.get("questions") or []
        row_spacing = _median_spacing(
            [float((q.get("row") or {}).get("y") or 0) for q in questions if (q.get("row") or {}).get("y")],
            fallback=23.0,
        )
        answers_by_subject[subject_code] = {}

        question_entries = []
        for question in questions:
            flat_index += 1
            q_no = str(question.get("number") or flat_index)
            row = question.get("row") or {}
            choices = _choice_items(question.get("choices") or {})
            orientation = _orientation(choices)
            max_radius = max([item["radius"] for item in choices] or [8.0])
            row_y = float(row.get("y") or (np.median([item["y"] for item in choices]) if choices else 0))
            row_left = float(row.get("left") or min([item["x"] for item in choices] or [0]))
            row_right = float(row.get("right") or max([item["x"] for item in choices] or [0]))
            row_top = float(row.get("top") or row_y - max_radius)
            row_bottom = float(row.get("bottom") or row_y + max_radius)
            row_y_tol = max(10.0, min(14.0, row_spacing * 0.48), max_radius * 1.15)
            lane_spacing = _median_spacing(
                [item["x"] if orientation == "horizontal" else item["y"] for item in choices],
                fallback=max_radius * 2.4,
            )
            lane_tol = max(11.0, lane_spacing * 0.50, max_radius * 1.25)
            cross_tol = max(10.0, max_radius * 1.25)
            question_entries.append({
                "question": question,
                "flatIndex": flat_index,
                "qNo": q_no,
                "choices": choices,
                "orientation": orientation,
                "rowY": row_y,
                "rowLeft": row_left,
                "rowRight": row_right,
                "rowTop": row_top,
                "rowBottom": row_bottom,
                "rowYTol": row_y_tol,
                "laneTol": lane_tol,
                "crossTol": cross_tol,
            })

        assigned_by_question = {entry["flatIndex"]: [] for entry in question_entries}
        for bubble in subject_bubbles:
            bx = float(bubble["x"])
            by = float(bubble["y"])
            best_entry = None
            best_choice = None
            best_score = float("inf")

            for entry in question_entries:
                orientation = entry["orientation"]
                lane_tol = entry["laneTol"]
                row_y_tol = entry["rowYTol"]
                cross_tol = entry["crossTol"]
                if orientation == "horizontal":
                    in_row_box = (
                        entry["rowLeft"] - lane_tol <= bx <= entry["rowRight"] + lane_tol
                        and entry["rowTop"] - row_y_tol <= by <= entry["rowBottom"] + row_y_tol
                    )
                    if not in_row_box or abs(by - entry["rowY"]) > row_y_tol:
                        continue
                else:
                    if not (
                        entry["rowTop"] - lane_tol <= by <= entry["rowBottom"] + lane_tol
                        and entry["rowLeft"] - row_y_tol <= bx <= entry["rowRight"] + row_y_tol
                    ):
                        continue

                for choice in entry["choices"]:
                    axis_dist = abs((bx - choice["x"]) if orientation == "horizontal" else (by - choice["y"]))
                    cross_dist = abs((by - choice["y"]) if orientation == "horizontal" else (bx - choice["x"]))
                    if axis_dist > lane_tol or cross_dist > cross_tol:
                        continue
                    score = (axis_dist / max(1.0, lane_tol)) + (cross_dist / max(1.0, cross_tol)) * 1.4
                    if score < best_score:
                        best_entry = entry
                        best_choice = choice
                        best_score = score

            if best_entry is None or best_choice is None:
                continue

            assigned_by_question[best_entry["flatIndex"]].append({
                **bubble,
                "subject": subject_code,
                "subjectName": subject_name,
                "questionNumber": best_entry["flatIndex"],
                "displayQuestionNumber": int(best_entry["question"].get("number") or best_entry["flatIndex"]),
                "choice": best_choice["label"],
                "label": best_choice["label"],
                "distance": round(float(best_score), 3),
                "expectedCenter": {"x": best_choice["x"], "y": best_choice["y"]},
            })

        for entry in question_entries:
            question = entry["question"]
            q_no = entry["qNo"]
            choices = entry["choices"]
            flat_q_no = entry["flatIndex"]

            best_by_choice = {}
            for candidate in assigned_by_question.get(flat_q_no) or []:
                current = best_by_choice.get(candidate["choice"])
                if current is None or (
                    candidate.get("darkness", 0),
                    -candidate.get("distance", 999)
                ) > (
                    current.get("darkness", 0),
                    -current.get("distance", 999)
                ):
                    best_by_choice[candidate["choice"]] = candidate

            detected = sorted(best_by_choice.values(), key=lambda item: item["distance"])
            labels = [item["choice"] for item in detected]
            fallback_scores = []
            if not labels:
                fallback_candidate, fallback_scores = _fallback_sampled_choice(
                    gray,
                    entry,
                    fallback_threshold,
                    H=fallback_H,
                )
                if fallback_candidate:
                    fallback_candidate = {
                        **fallback_candidate,
                        "subject": subject_code,
                        "subjectName": subject_name,
                        "questionNumber": flat_q_no,
                        "displayQuestionNumber": int(question.get("number") or flat_q_no),
                    }
                    best_by_choice[fallback_candidate["choice"]] = fallback_candidate
                    detected = [fallback_candidate]
                    labels = [fallback_candidate["choice"]]
                    answer = labels[0]
                    state = "detected"
                    display_answer = answer
                    selected_option = answer
                else:
                    answer = ""
                    state = "blank"
                    display_answer = "blank"
                    selected_option = None
            elif len(labels) == 1:
                answer = labels[0]
                state = "detected"
                display_answer = answer
                selected_option = answer
            else:
                answer = "multiple"
                state = "multiple"
                display_answer = "multiple"
                selected_option = None

            for item in detected:
                mapped_bubbles.append(item)

            option_metrics = []
            for choice in choices:
                matched = best_by_choice.get(choice["label"])
                fallback_score = next(
                    (item["darkness"] for item in fallback_scores if item["choice"]["label"] == choice["label"]),
                    None,
                )
                option_metrics.append({
                    "option": choice["label"],
                    "score": matched.get("darkness", 0) if matched else (fallback_score or 0),
                    "fill": matched.get("darkness", 0) if matched else (fallback_score or 0),
                    "filled": bool(matched),
                    "center": {"x": matched["x"], "y": matched["y"]} if matched else {"x": choice["x"], "y": choice["y"]},
                    "expectedCenter": {"x": choice["x"], "y": choice["y"]},
                    "mappingDistance": matched.get("distance") if matched else None,
                    "source": matched.get("source") if matched else None,
                })

            contour_answer = answer
            contour_state = state

            # --- ROI fill-ratio fallback for blank/multiple ---
            roi_override = False
            roi_old_answer = answer
            roi_ratios = None
            if gray is not None and state in ("blank", "multiple"):
                _roi_answer, _roi_state, roi_ratios = _roi_fill_classifier(
                    gray, choices, fallback_H=fallback_H,
                    fill_threshold=fallback_threshold, difference_margin=0.08
                )
                if _roi_state == "detected":
                    roi_override = True
                    answer = _roi_answer
                    state = "detected"
                    display_answer = answer
                    selected_option = answer
                    for om in option_metrics:
                        label = om["option"]
                        if label in roi_ratios:
                            om["score"] = roi_ratios[label]
                            om["fill"] = roi_ratios[label]
                            om["filled"] = (label == answer)
                            om["source"] = "roi_fallback"

            answers.append(answer)
            answers_by_subject[subject_code][q_no] = {
                "answer": display_answer,
                "detected": detected,
                "metrics": option_metrics,
            }
            used_fallback = roi_override or any(item.get("source") == "anchor_sample_fallback" for item in detected)
            # Real confidence from actual fill margin
            scores = sorted([om.get("score", 0) for om in option_metrics], reverse=True)
            top_score = scores[0] if scores else 0
            margin = (scores[0] - scores[1]) if len(scores) >= 2 else top_score
            if state == "detected":
                confidence = min(1.0, 0.35 + (top_score * 0.30) + (margin * 0.40))
            elif state == "multiple":
                confidence = max(0.05, 0.30 - margin * 0.20)
            else:
                confidence = 0.25 if top_score > 0.3 else 0.40
            question_metrics.append({
                "questionNumber": flat_q_no,
                "displayQuestionNumber": int(question.get("number") or flat_q_no),
                "subject": subject_code,
                "subjectName": subject_name,
                "answer": answer,
                "state": state,
                "confidence": confidence,
                "selectedOption": selected_option,
                "detected": detected,
                "options": option_metrics,
            })

            # --- Diagnostic per-option fill ratios (all active questions) ---
            if debug_ratios and gray is not None:
                ratios = {}
                for ch in choices:
                    cx, cy, cr = ch["x"], ch["y"], ch["radius"]
                    darkness = circle_darkness_best(gray, cx, cy, cr, H=fallback_H)
                    ratios[ch["label"]] = round(darkness, 3)
                sorted_r = sorted(ratios.items(), key=lambda x: x[1], reverse=True)
                margin_val = round(sorted_r[0][1] - (sorted_r[1][1] if len(sorted_r) > 1 else 0), 3) if sorted_r else 0

                if roi_override:
                    detection_source = "roi_fill"
                elif used_fallback:
                    detection_source = "fallback_sampled"
                elif state == "detected":
                    detection_source = "contour"
                else:
                    detection_source = state

                last_metric = question_metrics[-1]
                last_metric["optionRatios"] = ratios
                last_metric["selectedAnswer"] = answer
                last_metric["thresholdUsed"] = round(fallback_threshold, 2)
                last_metric["margin"] = margin_val
                last_metric["detectionSource"] = detection_source

                last_metric["topRatioOption"] = sorted_r[0][0] if sorted_r else None
                last_metric["topRatioValue"] = sorted_r[0][1] if sorted_r else None
                last_metric["ratioSelectedOption"] = (sorted_r[0][0] if sorted_r and sorted_r[0][1] >= fallback_threshold else None)
                last_metric["contourSelectedOption"] = contour_answer if contour_state == "detected" else None
                last_metric["disagreement"] = (last_metric["contourSelectedOption"] is not None and last_metric["ratioSelectedOption"] is not None and last_metric["contourSelectedOption"] != last_metric["ratioSelectedOption"])
                last_metric["lowConfidence"] = margin_val < 0.08

            # --- Crop-image saving for PROBLEM_QUESTIONS only ---
            q_num = int(question.get("number") or flat_q_no)
            if gray is not None and debug_dir and q_num in PROBLEM_QUESTIONS:
                roi_info = {}
                for ch in choices:
                    cx, cy, cr = ch["x"], ch["y"], ch["radius"]
                    roi_info[ch["label"]] = {"cx": int(round(cx)), "cy": int(round(cy)), "radius": cr}
                    h, w = gray.shape[:2]
                    crop_margin = max(4, int(cr * 1.2))
                    y1 = max(0, int(round(cy)) - crop_margin)
                    y2 = min(h, int(round(cy)) + crop_margin + 1)
                    x1 = max(0, int(round(cx)) - crop_margin)
                    x2 = min(w, int(round(cx)) + crop_margin + 1)
                    crop = gray[y1:y2, x1:x2]
                    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '', request_id) if request_id else ""
                    prefix = f"debug_{safe_id}_" if safe_id else "debug_"
                    crop_path = debug_dir / f"{prefix}q{q_num:03d}_{ch['label']}.png"
                    cv2.imwrite(str(crop_path), crop)
                # Stderr debug info for problem questions
                metric_ratios = question_metrics[-1].get("optionRatios") or {}
                sorted_r = sorted(metric_ratios.items(), key=lambda x: x[1], reverse=True) if metric_ratios else []
                top_ratio = sorted_r[0][1] if sorted_r else 0
                second_ratio = sorted_r[1][1] if len(sorted_r) > 1 else 0
                reason = ""
                if roi_override:
                    reason = f"roi_overrode_contour_{roi_old_answer}"
                elif state == "blank":
                    reason = f"maxRatio={top_ratio} < threshold={fallback_threshold}"
                elif state == "multiple":
                    reason = f"top={sorted_r[0][0]}={top_ratio} second={sorted_r[1][0]}={second_ratio} gap={round(top_ratio - second_ratio, 3)}"
                debug_info = {
                    "type": "question_debug",
                    "question": q_num,
                    "subject": subject_code,
                    "localQuestion": q_no,
                    "ratios": metric_ratios,
                    "roi": roi_info,
                    "selected": display_answer,
                    "state": state,
                    "threshold_used": fallback_threshold,
                    "second_highest_ratio": second_ratio,
                    "reason": reason,
                    "roiOverride": roi_override,
                }
                if roi_override:
                    debug_info["sourceBefore"] = "contour"
                    debug_info["sourceAfter"] = "roi_fallback"
                    debug_info["oldAnswer"] = roi_old_answer
                    debug_info["newAnswer"] = answer
                sys.stderr.write(json.dumps(debug_info) + "\n")

            if roi_override and q_num not in PROBLEM_QUESTIONS:
                _sr = sorted(roi_ratios.items(), key=lambda x: x[1], reverse=True) if roi_ratios else []
                _gap = round(_sr[0][1] - (_sr[1][1] if len(_sr) > 1 else 0), 3) if len(_sr) > 1 else 0
                override_info = {
                    "type": "roi_override",
                    "question": q_num,
                    "subject": subject_code,
                    "localQuestion": q_no,
                    "sourceBefore": "contour",
                    "sourceAfter": "roi_fallback",
                    "oldAnswer": roi_old_answer,
                    "newAnswer": answer,
                    "ratios": roi_ratios,
                    "threshold": fallback_threshold,
                    "gap": _gap,
                    "reason": f"contour={roi_old_answer} roi_fallback=detected",
                }
                sys.stderr.write(json.dumps(override_info) + "\n")

    return answers, answers_by_subject, question_metrics, mapped_bubbles


STUDENT_TYPE_LABELS = {"New Student", "Transferee"}
RESIDENCY_TYPE_LABELS = {"Passinhon", "Non-Passinhon"}


def classify_entry_group(bubbles, choices, debug_dir=None):
    raw = classify_detected_group(bubbles, choices, "entryGroup", allow_multiple=True)
    detected_labels = [item["label"] for item in (raw.get("detected") or [])]
    student_type_labels = [l for l in detected_labels if l in STUDENT_TYPE_LABELS]
    residency_type_labels = [l for l in detected_labels if l in RESIDENCY_TYPE_LABELS]
    unrecognized = [l for l in detected_labels if l not in STUDENT_TYPE_LABELS and l not in RESIDENCY_TYPE_LABELS]

    if not detected_labels:
        state = "blank"
    elif len(student_type_labels) == 0:
        state = "missing_student_type"
    elif len(student_type_labels) > 1:
        state = "multiple_student_type"
    elif len(residency_type_labels) == 0:
        state = "missing_residency_type"
    elif len(residency_type_labels) > 1:
        state = "multiple_residency_type"
    else:
        state = "valid"

    student_type = student_type_labels[0] if len(student_type_labels) == 1 else None
    residency_type = residency_type_labels[0] if len(residency_type_labels) == 1 else None

    if debug_dir:
        metrics = raw.get("metrics") or []
        entry_debug = {
            "type": "entry_debug",
            "state": state,
            "studentType": student_type,
            "residencyType": residency_type,
            "selected": student_type_labels + residency_type_labels,
            "options": [
                {"label": m["label"], "fill": m.get("darkness", 0),
                 "selected": m.get("filled", False),
                 "roi": {"cx": m["x"], "cy": m["y"], "radius": m["radius"]}}
                for m in metrics
            ],
        }
        sys.stderr.write(json.dumps(entry_debug) + "\n")

    return {
        **raw,
        "state": state,
        "studentType": student_type,
        "residencyType": residency_type,
        "selected": student_type_labels + residency_type_labels,
        "value": student_type,
    }


def classify_contour_omr(bubbles, layout, gray=None, fallback_H=None, fallback_threshold=0.38, debug_dir=None, request_id="", debug_ratios=False):
    entry_result = classify_entry_group(
        bubbles,
        layout.get("entryGroup") or layout.get("entry_group") or {},
        debug_dir=debug_dir,
    )
    equity_result = classify_detected_group(
        bubbles,
        layout.get("equityGroup") or layout.get("equity_group") or {},
        "equityGroup",
        allow_multiple=True,
    )
    if debug_dir:
        eq_metrics = equity_result.get("metrics") or []
        eq_labels = [item["label"] for item in (equity_result.get("detected") or [])]
        equity_debug = {
            "type": "equity_debug",
            "state": equity_result.get("status", "blank"),
            "selected": eq_labels,
            "options": [
                {"label": m["label"], "fill": m.get("darkness", 0),
                 "selected": m.get("filled", False),
                 "roi": {"cx": m["x"], "cy": m["y"], "radius": m["radius"]}}
                for m in eq_metrics
            ],
        }
        sys.stderr.write(json.dumps(equity_debug) + "\n")
    answers, answers_by_subject, question_metrics, answer_mapped = classify_detected_answers(
        bubbles,
        layout,
        gray=gray,
        fallback_H=fallback_H,
        fallback_threshold=fallback_threshold,
        debug_dir=debug_dir,
        request_id=request_id,
        debug_ratios=debug_ratios,
    )

    mapped_bubbles = []
    mapped_bubbles.extend(answer_mapped)
    mapped_bubbles.extend(entry_result.get("mappedBubbles") or [])
    mapped_bubbles.extend(equity_result.get("mappedBubbles") or [])

    mapped_ids = {(int(item["x"]), int(item["y"])) for item in mapped_bubbles}
    unmapped_bubbles = [
        bubble for bubble in bubbles
        if (int(bubble["x"]), int(bubble["y"])) not in mapped_ids
    ]

    return {
        "entryResult": entry_result,
        "equityResult": equity_result,
        "answers": answers,
        "answersBySubject": answers_by_subject,
        "questionMetrics": question_metrics,
        "mappedBubbles": mapped_bubbles,
        "unmappedBubbles": unmapped_bubbles,
    }


def find_border_offset(gray):
    """
    Detect the position of the answer sheet's dark border in the warped
    image and return the fine alignment offset (dx, dy).

    The answer sheet has a ~4px black border at its outer edge.
    After a perfect warp, this border starts at pixel 0 on each edge.
    If detection was off, the border will be N pixels inward.
    Returns (dx, dy) — positive means the content is shifted right/down
    and coordinates need to be adjusted.
    """
    h, w = gray.shape[:2]
    scan_depth = 60
    threshold = 60

    top_rows = []
    for col in range(scan_depth, w - scan_depth, 2):
        profile = gray[0:scan_depth, col]
        dark_idx = np.where(profile < threshold)[0]
        if len(dark_idx) > 2:
            top_rows.append(int(dark_idx[0]))

    left_cols = []
    for row in range(scan_depth, h - scan_depth, 2):
        profile = gray[row, 0:scan_depth]
        dark_idx = np.where(profile < threshold)[0]
        if len(dark_idx) > 2:
            left_cols.append(int(dark_idx[0]))

    right_cols = []
    for row in range(scan_depth, h - scan_depth, 2):
        profile = gray[row, w - scan_depth:w]
        dark_idx = np.where(profile < threshold)[0]
        if len(dark_idx) > 2:
            right_cols.append(int(len(profile) - 1 - dark_idx[-1]))

    bottom_rows = []
    for col in range(scan_depth, w - scan_depth, 2):
        profile = gray[h - scan_depth:h, col]
        dark_idx = np.where(profile < threshold)[0]
        if len(dark_idx) > 2:
            bottom_rows.append(int(len(profile) - 1 - dark_idx[-1]))

    dy = int(round(np.median(top_rows))) if top_rows else 0
    dx = int(round(np.median(left_cols))) if left_cols else 0

    right_offset = int(round(np.median(right_cols))) if right_cols else 0
    bottom_offset = int(round(np.median(bottom_rows))) if bottom_rows else 0

    alignment_info = {
        "topOffset": dy,
        "leftOffset": dx,
        "rightOffset": right_offset,
        "bottomOffset": bottom_offset,
        "detectedTop": len(top_rows) > 20,
        "detectedLeft": len(left_cols) > 20,
        "detectedRight": len(right_cols) > 20,
        "detectedBottom": len(bottom_rows) > 20,
    }

    alignment_consistent = (
        alignment_info["detectedTop"]
        and alignment_info["detectedLeft"]
        and alignment_info["detectedRight"]
        and alignment_info["detectedBottom"]
    )

    dx_final = dx if alignment_consistent else 0
    dy_final = dy if alignment_consistent else 0

    return dx_final, dy_final, alignment_info


def circle_darkness_best(gray, x, y, radius, search_radius=3, H=None):
    """
    Sample bubble darkness with local search.
    If H (homography matrix) is provided, applies it to (x, y) first
    to map from layout coordinates to warped image coordinates.
    Checks multiple positions around the center and returns
    the best (highest) darkness value.
    """
    h, w = gray.shape[:2]

    if H is not None:
        pt = np.array([x, y, 1.0])
        projected = H @ pt
        x = float(projected[0] / projected[2])
        y = float(projected[1] / projected[2])

    best = 0.0

    r = max(2, int(round(radius * 0.85)))
    cy_base = int(round(clamp(y, 0, h - 1)))
    cx_base = int(round(clamp(x, 0, w - 1)))

    y1 = max(0, cy_base - r - search_radius)
    y2 = min(h, cy_base + r + search_radius + 1)
    x1 = max(0, cx_base - r - search_radius)
    x2 = min(w, cx_base + r + search_radius + 1)

    region = gray[y1:y2, x1:x2]
    if region.size == 0:
        return 0.0

    local_cx = cx_base - x1
    local_cy = cy_base - y1

    for dy, dx in SEARCH_PATTERN:
        lx = local_cx + dx
        ly = local_cy + dy
        if lx - r < 0 or ly - r < 0 or lx + r >= region.shape[1] or ly + r >= region.shape[0]:
            darkness = _sample_darkness_fallback(gray, cx_base + dx, cy_base + dy, r)
            if darkness > best:
                best = darkness
            continue
        mask = np.zeros(region.shape, dtype=np.uint8)
        cv2.circle(mask, (lx, ly), r, 255, -1)
        pixels = region[mask == 255]
        if pixels.size == 0:
            continue
        darkness = float(1.0 - (np.mean(pixels) / 255.0))
        if darkness > best:
            best = darkness

    return best


def _sample_darkness_fallback(gray, cx, cy, r):
    h, w = gray.shape[:2]
    cx = int(round(clamp(cx, 0, w - 1)))
    cy = int(round(clamp(cy, 0, h - 1)))
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


def is_filled_best(gray, bubble, threshold, dx=0, dy=0, H=None):
    x = float(bubble.get("x") or 0) + dx
    y = float(bubble.get("y") or 0) + dy
    radius = float(bubble.get("radius") or 8)
    darkness = circle_darkness_best(gray, x, y, radius, H=H)
    return darkness >= threshold, round(darkness, 3)


def scan_choice_group_best(gray, choices, threshold, dx=0, dy=0, H=None):
    detected = []
    metrics = []
    if not isinstance(choices, dict):
        return detected, metrics
    for label, bubble in choices.items():
        filled, darkness = is_filled_best(gray, bubble, threshold, dx, dy, H)
        item = {
            "label": str(label),
            "darkness": darkness,
            "x": int(round(float(bubble.get("x") or 0))),
            "y": int(round(float(bubble.get("y") or 0))),
            "radius": float(bubble.get("radius") or 8),
            "filled": filled,
        }
        metrics.append(item)
        if filled:
            detected.append(item)
    return detected, metrics


def scan_entry_group(gray, layout, threshold, dx=0, dy=0, H=None):
    detected, metrics = scan_choice_group_best(
        gray, layout.get("entryGroup") or layout.get("entry_group") or {}, threshold, dx, dy, H
    )
    if len(detected) == 0:
        return {"value": None, "status": "blank", "detected": [], "metrics": metrics}
    if len(detected) > 1:
        return {"value": None, "status": "multiple", "detected": detected, "metrics": metrics}
    return {"value": detected[0]["label"], "status": "valid", "detected": detected, "metrics": metrics}


def scan_equity_group(gray, layout, threshold, dx=0, dy=0, H=None):
    detected, metrics = scan_choice_group_best(
        gray, layout.get("equityGroup") or layout.get("equity_group") or {}, threshold, dx, dy, H
    )
    return {"values": [item["label"] for item in detected], "detected": detected, "metrics": metrics}


def scan_subject_answers(gray, layout, threshold, dx=0, dy=0, H=None):
    answers = []
    by_subject = {}
    question_metrics = []
    flat_index = 0

    for subject in layout.get("subjects") or []:
        subject_code = str(subject.get("code") or subject.get("name") or "").strip()
        subject_name = str(subject.get("name") or subject_code).strip()
        by_subject[subject_code] = {}
        for question in subject.get("questions") or []:
            flat_index += 1
            q_no = str(question.get("number") or flat_index)
            detected, metrics = scan_choice_group_best(gray, question.get("choices") or {}, threshold, dx, dy, H)
            if len(detected) == 0:
                answer = ""
                state = "blank"
                display_answer = "blank"
            elif len(detected) == 1:
                answer = detected[0]["label"]
                state = "detected"
                display_answer = answer
            else:
                answer = "multiple"
                state = "multiple"
                display_answer = "multiple"
            answers.append(answer)
            by_subject[subject_code][q_no] = {
                "answer": display_answer,
                "detected": detected,
                "metrics": metrics,
            }
            question_metrics.append({
                "questionNumber": flat_index,
                "displayQuestionNumber": int(question.get("number") or flat_index),
                "subject": subject_code,
                "subjectName": subject_name,
                "answer": answer,
                "state": state,
                "confidence": min(1.0, 0.35 + (max(item.get("darkness", 0) for item in detected) * 0.30 + 0.40)) if state == "detected" else (0.30 if state == "multiple" else 0.40),
                "selectedOption": answer if len(detected) == 1 else None,
                "detected": detected,
                "options": [
                    {
                        "option": item["label"],
                        "score": item["darkness"],
                        "fill": item["darkness"],
                        "center": {"x": item["x"], "y": item["y"]},
                        "expectedCenter": {"x": item["x"], "y": item["y"]},
                    }
                    for item in metrics
                ],
            })

    return answers, by_subject, question_metrics


def draw_debug_layout_overlay(
    image, layout, entry_result, equity_result, question_metrics,
    alignment_info, dx, dy, H=None, section_transform_info=None, anchor_info=None,
    fallback_H=None,
):
    """
    Draw a comprehensive debug overlay showing:
    - Expected bubble centers from layout.json (cyan circles)
    - Section-transformed bubble centers (magenta circles)
    - Detected filled bubbles (green circles) with labels like "Q3 C"
    - Blank/unfilled expected positions (yellow outline)
    - Section box borders (magenta rectangles)
    - Alignment and transform info text
    """
    overlay = image.copy()
    h, w = overlay.shape[:2]

    cyan = (255, 255, 0)
    green = (40, 180, 40)
    red = (0, 0, 255)
    yellow = (0, 220, 255)
    magenta = (255, 0, 255)
    white = (255, 255, 255)
    orange = (0, 165, 255)

    anchor_success = bool(anchor_info and anchor_info.get("success"))

    # Draw needs_review warning
    if section_transform_info and section_transform_info.get("confidence", 0) < 0.6 and not anchor_success:
        cv2.putText(
            overlay,
            "WARNING: Layout alignment confidence is low.",
            (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, red, 2, cv2.LINE_AA,
        )

    # Draw section transform info
    line_y = 45 if (section_transform_info and section_transform_info.get("confidence", 0) < 0.6 and not anchor_success) else 20
    if anchor_success:
        cv2.putText(
            overlay,
            f"AnchorAlign: ACTIVE conf={float(anchor_info.get('confidence') or 0):.2f} "
            f"anchors={anchor_info.get('detectedCount', 0)}/{anchor_info.get('anchorCount', 0)}",
            (10, line_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, green, 1, cv2.LINE_AA,
        )
        line_y += 20

    if H is not None and section_transform_info:
        info = section_transform_info
        status = "ACTIVE" if info.get("success") else "FAILED"
        conf = info.get("confidence", 0)
        pts = info.get("point_count", 0)
        inl = info.get("inliers", 0)
        err = info.get("mean_error", 0)
        cv2.putText(
            overlay,
            f"SectionXform: {status} conf={conf:.2f} pts={pts} inl={inl} err={err:.1f}px",
            (10, line_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, magenta, 1, cv2.LINE_AA,
        )
        line_y += 20
    elif H is not None:
        cv2.putText(
            overlay,
            "SectionXform: ACTIVE (no info)",
            (10, line_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, magenta, 1, cv2.LINE_AA,
        )
        line_y += 20

    cv2.putText(
        overlay,
        f"Border offset: dx={dx}, dy={dy}",
        (10, line_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, magenta, 1, cv2.LINE_AA,
    )
    line_y += 18

    if alignment_info:
        info_parts = []
        for k, v in alignment_info.items():
            info_parts.append(f"{k}={v}")
        info_text = " ".join(info_parts)
        cv2.putText(
            overlay,
            info_text[:80],
            (10, line_y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, magenta, 1, cv2.LINE_AA,
        )

    # Draw subject block borders if H is available
    if H is not None:
        for subject in layout.get("subjects") or []:
            block = subject.get("block", {})
            if not block:
                continue
            bl = int(block.get("left", 0))
            bt = int(block.get("top", 0))
            br = int(block.get("left", 0) + block.get("width", 0))
            bb = int(block.get("top", 0) + block.get("height", 0))
            corners = np.array([[bl, bt], [br, bt], [br, bb], [bl, bb]], dtype=np.float32)
            projected = cv2.perspectiveTransform(corners.reshape(-1, 1, 2), H).reshape(-1, 2)
            cv2.polylines(overlay, [np.int32(projected)], True, magenta, 2)
            cv2.putText(overlay, subject.get("code", ""),
                        (int(projected[0, 0]), int(projected[0, 1]) - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, magenta, 1, cv2.LINE_AA)

    def draw_item(item, color, label=None, radius_override=None, use_transform=False):
        cx = int(round(float(item.get("rawX") or item.get("x") or item.get("expectedCenter", {}).get("x") or item.get("center", {}).get("x") or 0)))
        cy = int(round(float(item.get("rawY") or item.get("y") or item.get("expectedCenter", {}).get("y") or item.get("center", {}).get("y") or 0)))
        if use_transform and H is not None:
            ptx, pty = _apply_homography(H, cx, cy)
            cx, cy = int(round(ptx)), int(round(pty))
        r = int(round(radius_override or float(item.get("radius") or 7)))
        cv2.circle(overlay, (cx, cy), max(3, r), color, 2)
        cv2.circle(overlay, (cx, cy), 2, color, -1)
        if label:
            cv2.putText(
                overlay, label, (cx + r + 3, cy + 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA,
            )

    for item in entry_result.get("metrics") or []:
        color = green if item.get("filled") else yellow
        draw_item(item, color, f"ENTRY {item['label']}" if item.get("filled") else None)

    for item in equity_result.get("metrics") or []:
        color = green if item.get("filled") else yellow
        draw_item(item, color, f"EQ {item['label']}" if item.get("filled") else None)

    for metric in question_metrics:
        state = metric.get("state")
        subject = str(metric.get("subjectName") or metric.get("subject") or "")[:4]
        q_no = metric.get("displayQuestionNumber") or metric.get("questionNumber")

        for opt in metric.get("options") or []:
            # Layout (cyan) — expected position
            expected = {"x": opt.get("expectedCenter", {}).get("x", 0), "y": opt.get("expectedCenter", {}).get("y", 0), "radius": 5}
            draw_item(expected, cyan)

            # Transformed (magenta) — after section transform
            if H is not None and state != "detected":
                draw_item(expected, magenta, radius_override=3, use_transform=True)

            if state == "detected":
                for d in metric.get("detected") or []:
                    if d.get("label") == opt.get("option"):
                        draw_item(d, green, f"{subject} Q{q_no} {opt['option']}", radius_override=d.get("radius") or 4)

    # --- Orange ROI sample circles (after fallback_H transform) ---
    for metric in question_metrics:
        q_no = metric.get("displayQuestionNumber") or metric.get("questionNumber")
        has_ratios = "optionRatios" in metric
        is_blank = metric.get("state") == "blank"
        low_conf = metric.get("lowConfidence", False)
        is_disagreement = metric.get("disagreement", False)
        label_q = (is_blank or low_conf or is_disagreement) and has_ratios
        ratios = metric.get("optionRatios") or {}

        for opt in metric.get("options") or []:
            ex = opt.get("expectedCenter", {}).get("x", 0)
            ey = opt.get("expectedCenter", {}).get("y", 0)
            label = opt.get("option", "")
            cr = 5

            if fallback_H is not None:
                px, py = _apply_homography(fallback_H, ex, ey)
            else:
                px, py = ex, ey

            cx = int(round(px))
            cy = int(round(py))
            cv2.circle(overlay, (cx, cy), max(3, cr), orange, 2)
            cv2.circle(overlay, (cx, cy), 2, orange, -1)

            if label_q:
                ratio_val = ratios.get(label)
                ratio_str = f"{ratio_val:.2f}" if ratio_val is not None else ""
                lbl = f"Q{q_no} {label} {ratio_str}".strip()
                cv2.putText(
                    overlay, lbl, (cx + cr + 3, cy + 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, orange, 1, cv2.LINE_AA,
                )

    # --- Legend ---
    legend_y = h - 80
    legend_items = [
        (cyan, "layout expected"),
        (magenta, "transformed expected / section"),
        (green, "contour filled"),
        (orange, "ROI sample circle"),
    ]
    for color, text in legend_items:
        cv2.rectangle(overlay, (10, legend_y - 5), (20, legend_y + 5), color, -1)
        cv2.putText(
            overlay, text, (25, legend_y + 4),
            cv2.FONT_HERSHEY_SIMPLEX, 0.4, white, 1, cv2.LINE_AA,
        )
        legend_y += 16

    return overlay


def compute_alignment_confidence(alignment_info, dx, dy):
    if not alignment_info:
        return 0.5
    detected_sides = sum([
        1 if alignment_info.get("detectedTop") else 0,
        1 if alignment_info.get("detectedLeft") else 0,
        1 if alignment_info.get("detectedRight") else 0,
        1 if alignment_info.get("detectedBottom") else 0,
    ])
    if detected_sides < 2:
        return 0.5
    max_offset = max(abs(dx), abs(dy))
    if max_offset <= 1:
        return 0.98
    if max_offset <= 3:
        return 0.90
    if max_offset <= 6:
        return 0.75
    return 0.50


def _detect_block_border(gray, expected_left, expected_top, expected_right, expected_bottom, margin=20, dark_thresh=80):
    """
    Detect a subject block's border in the warped image by scanning for
    the darkest line at the expected position.
    
    Returns dict with detected (left, top, right, bottom) and confidence per side.
    """
    h, w = gray.shape[:2]
    
    x1 = max(0, expected_left - margin)
    y1 = max(0, expected_top - margin)
    x2 = min(w - 1, expected_right + margin)
    y2 = min(h - 1, expected_bottom + margin)
    
    # Top border: darkest horizontal line in strip at expected top
    top_strip = gray[y1:min(h, expected_top + margin), x1:x2]
    top_dark = 0
    top_actual = expected_top
    if top_strip.size > 0:
        row_means = np.mean(top_strip, axis=1)
        best_idx = int(np.argmin(row_means))
        top_actual = y1 + best_idx
        top_dark = 1.0 - row_means[best_idx] / 255.0
    
    # Bottom border: darkest line in strip at expected bottom
    bot_strip = gray[max(0, expected_bottom - margin):y2, x1:x2]
    bot_dark = 0
    bot_actual = expected_bottom
    if bot_strip.size > 0:
        row_means = np.mean(bot_strip, axis=1)
        best_idx = int(np.argmin(row_means))
        bot_actual = max(0, expected_bottom - margin) + best_idx
        bot_dark = 1.0 - row_means[best_idx] / 255.0
    
    # Left border: darkest vertical line
    left_strip = gray[y1:y2, x1:min(w, expected_left + margin)]
    left_dark = 0
    left_actual = expected_left
    if left_strip.size > 0:
        col_means = np.mean(left_strip, axis=0)
        best_idx = int(np.argmin(col_means))
        left_actual = x1 + best_idx
        left_dark = 1.0 - col_means[best_idx] / 255.0
    
    # Right border: darkest vertical line
    right_strip = gray[y1:y2, max(0, expected_right - margin):x2]
    right_dark = 0
    right_actual = expected_right
    if right_strip.size > 0:
        col_means = np.mean(right_strip, axis=0)
        best_idx = int(np.argmin(col_means))
        right_actual = max(0, expected_right - margin) + best_idx
        right_dark = 1.0 - col_means[best_idx] / 255.0
    
    return {
        'left': left_actual, 'top': top_actual,
        'right': right_actual, 'bottom': bot_actual,
        'conf_left': left_dark, 'conf_top': top_dark,
        'conf_right': right_dark, 'conf_bottom': bot_dark,
        'dx_left': left_actual - expected_left,
        'dy_top': top_actual - expected_top,
        'dx_right': right_actual - expected_right,
        'dy_bot': bot_actual - expected_bottom,
    }


def _detect_row_borders(gray, layout):
    """
    Detect question row borders within each subject block.
    Each question row has a horizontal border line.
    Returns list of (layout_y, detected_y, subject_code, confidence) tuples.
    """
    h, w = gray.shape[:2]
    correspondences = []
    
    for subject in layout.get("subjects") or []:
        code = subject.get("code", "")
        if not subject.get("questions"):
            continue
        
        block = subject.get("block", {})
        block_left = int(block.get("left", 0))
        block_right = int(block.get("left", 0) + block.get("width", 0))
        block_top = int(block.get("top", 0))
        block_bottom = int(block.get("top", 0) + block.get("height", 0))
        
        for question in subject["questions"]:
            row = question.get("row", {})
            expected_y = int(row.get("y", 0))
            if expected_y <= 0:
                continue
            
            y_start = max(0, expected_y - 5)
            y_end = min(h, expected_y + 5)
            x_start = max(0, block_left + 20)
            x_end = min(w, block_right - 20)
            
            if y_end <= y_start or x_end <= x_start:
                continue
            
            strip = gray[y_start:y_end, x_start:x_end]
            if strip.size == 0:
                continue
            
            row_means = np.mean(strip, axis=1)
            best_idx = int(np.argmin(row_means))
            detected_y = y_start + best_idx
            confidence = 1.0 - row_means[best_idx] / 255.0
            
            correspondences.append({
                'layout_y': expected_y,
                'detected_y': detected_y,
                'layout_x': (block_left + block_right) // 2,
                'detected_x': (block_left + block_right) // 2,
                'subject': code,
                'confidence': confidence,
            })
    
    return correspondences


def _compute_section_transform(gray, layout, width, height):
    """
    Detect subject blocks and row borders in the warped image, then
    compute a global homography that maps layout coordinates to warped
    image coordinates.
    
    Returns (H, confidence_info) where H is a 3x3 homography matrix
    or None if detection fails.
    """
    src_pts = []
    dst_pts = []
    point_weights = []
    
    # 1. Detect subject block borders
    for subject in layout.get("subjects") or []:
        block = subject.get("block", {})
        if not block:
            continue
        
        exp_l = int(block.get("left", 0))
        exp_t = int(block.get("top", 0))
        exp_r = int(block.get("left", 0) + block.get("width", 0))
        exp_b = int(block.get("top", 0) + block.get("height", 0))
        
        result = _detect_block_border(gray, exp_l, exp_t, exp_r, exp_b, margin=25)
        
        # For each corner, add correspondence if both adjacent borders are confident enough
        corners = [
            (exp_l, exp_t, result['left'], result['top'], result['conf_left'], result['conf_top']),
            (exp_r, exp_t, result['right'], result['top'], result['conf_right'], result['conf_top']),
            (exp_r, exp_b, result['right'], result['bottom'], result['conf_right'], result['conf_bottom']),
            (exp_l, exp_b, result['left'], result['bottom'], result['conf_left'], result['conf_bottom']),
        ]
        
        for ex, ey, dx, dy, cx, cy in corners:
            weight = min(cx, cy)
            if weight > 0.15:
                src_pts.append([ex, ey])
                dst_pts.append([dx, dy])
                point_weights.append(weight)
    
    # 2. Detect row borders for additional correspondences
    row_corrs = _detect_row_borders(gray, layout)
    for rc in row_corrs:
        if rc['confidence'] > 0.25:
            src_pts.append([rc['layout_x'], rc['layout_y']])
            dst_pts.append([rc['detected_x'], rc['detected_y']])
            point_weights.append(rc['confidence'])
    
    if len(src_pts) < 4:
        return None, {
            'success': False,
            'point_count': len(src_pts),
            'error': 'insufficient_points',
        }
    
    src_arr = np.array(src_pts, dtype=np.float32)
    dst_arr = np.array(dst_pts, dtype=np.float32)
    weights_arr = np.array(point_weights, dtype=np.float32)
    
    # Compute homography with RANSAC
    H, mask = cv2.findHomography(src_arr, dst_arr, cv2.RANSAC, 5.0)
    
    if H is None:
        return None, {
            'success': False,
            'point_count': len(src_pts),
            'error': 'homography_failed',
        }
    
    inliers = int(np.sum(mask)) if mask is not None else 0
    inlier_ratio = inliers / max(1, len(src_pts))
    mean_weight = float(np.mean(point_weights)) if point_weights else 0
    
    # Compute residual error
    projected = cv2.perspectiveTransform(src_arr.reshape(-1, 1, 2), H).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst_arr, axis=1)
    mean_error = float(np.mean(errors))
    max_error = float(np.max(errors))
    
    # Confidence based on inlier ratio, mean weight, and error
    confidence = inlier_ratio * 0.5 + mean_weight * 0.3 + max(0, 1.0 - mean_error / 20.0) * 0.2
    
    info = {
        'success': True,
        'point_count': len(src_pts),
        'inliers': inliers,
        'inlier_ratio': round(inlier_ratio, 3),
        'mean_weight': round(mean_weight, 3),
        'mean_error': round(mean_error, 2),
        'max_error': round(max_error, 2),
        'confidence': round(confidence, 3),
        'has_row_corrs': len(row_corrs) > 0,
    }
    
    return H, info


def _apply_homography(H, x, y):
    """Apply homography to a single point (x, y). Returns (x', y')."""
    pt = np.array([x, y, 1.0])
    projected = H @ pt
    return float(projected[0] / projected[2]), float(projected[1] / projected[2])


def _get_qr_probe_size(quad, default_w=1000):
    """
    Determine QR probe dimensions based on the detected document quad's
    aspect ratio.  This ensures QR codes remain readable for any paper size
    (8.5×13 long bond, 11×14 bond, A4, etc.).

    Args:
        quad: 4×2 array of corner points (TL, TR, BR, BL) or None.
        default_w: The width to fix for the probe (default 1000 px).

    Returns:
        (probe_width, probe_height) tuple.
    """
    if quad is not None and len(quad) == 4:
        # Estimate paper aspect ratio from quad edge lengths
        def _edge_len(p1, p2):
            return float(np.linalg.norm(np.array(p1, dtype=np.float64) - np.array(p2, dtype=np.float64)))

        # Average width from top and bottom edges
        w1 = _edge_len(quad[0], quad[1])
        w2 = _edge_len(quad[3], quad[2])
        avg_w = (w1 + w2) / 2.0
        # Average height from left and right edges
        h1 = _edge_len(quad[0], quad[3])
        h2 = _edge_len(quad[1], quad[2])
        avg_h = (h1 + h2) / 2.0

        if avg_w > 0 and avg_h > 0:
            aspect = avg_h / avg_w
            probe_w = int(default_w)
            probe_h = int(round(default_w * aspect))
            # Clamp to reasonable range
            probe_h = max(800, min(2000, probe_h))
            return probe_w, probe_h

    # Fallback: long bond (8.5×13) aspect ratio
    return default_w, int(round(default_w * 13.0 / 8.5))


def _detect_upside_down(image):
    """Detect if the image is upside-down by analyzing content density.

    Most answer sheets have dense content (header text, barcode, title) at
    the TOP and lighter content (answer bubbles, blank space) at the BOTTOM.
    If the bottom third is significantly denser than the top third, the
    image is likely upside-down.

    Returns:
        (is_upside_down: bool, confidence: float)
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    # Divide into top, middle, bottom thirds
    third = h // 3
    top_third = gray[0:third, :]
    mid_third = gray[third:2*third, :]
    bot_third = gray[2*third:h, :]

    # Compute darkness ratio (dark pixels = content)
    def _dark_ratio(region, thresh=100):
        return float(np.mean(region < thresh))

    top_dark = _dark_ratio(top_third)
    mid_dark = _dark_ratio(mid_third)
    bot_dark = _dark_ratio(bot_third)

    # Edge density: more edges = more content
    def _edge_density(region):
        edges = cv2.Canny(region, 50, 150)
        return float(np.mean(edges > 0))

    top_edges = _edge_density(top_third)
    bot_edges = _edge_density(bot_third)

    # Decision: if bottom is significantly denser than top, flip
    dark_diff = bot_dark - top_dark
    edge_diff = bot_edges - top_edges

    # Combined score
    score = dark_diff * 0.6 + edge_diff * 0.4
    confidence = min(1.0, max(0.0, abs(score) * 3.0))

    return score > 0.05, round(confidence, 3)


def auto_rotate_image(image):
    """Auto-rotate image if detected as upside-down.

    Returns (rotated_image, was_flipped, confidence).
    """
    is_upside_down, confidence = _detect_upside_down(image)
    if is_upside_down and confidence > 0.3:
        rotated = cv2.rotate(image, cv2.ROTATE_180)
        return rotated, True, confidence
    return image, False, confidence


def _layout_registration_anchors(layout):
    anchors = layout.get("registrationAnchors") or layout.get("registration_anchors") or {}
    if not isinstance(anchors, dict):
        return []
    out = []
    for label, anchor in anchors.items():
        if not isinstance(anchor, dict):
            continue
        x = float(anchor.get("x") or 0)
        y = float(anchor.get("y") or 0)
        radius = float(anchor.get("radius") or 6)
        if x > 0 and y > 0:
            out.append({"label": str(label), "x": x, "y": y, "radius": radius})
    return out


def _detect_registration_anchor_transform(gray, layout):
    """
    New sheets can include four square registration markers. After the
    coarse page warp, detect those markers near their expected layout
    positions and build a correction transform from detected image space
    back to layout space.
    """
    anchors = _layout_registration_anchors(layout)
    if len(anchors) < 3:
        return None, {
            "active": False,
            "success": False,
            "anchorCount": len(anchors),
            "detectedCount": 0,
            "error": "insufficient_layout_anchors",
        }

    h, w = gray.shape[:2]
    detected = []
    expected = []
    details = []

    for anchor in anchors:
        ex = float(anchor["x"])
        ey = float(anchor["y"])
        radius = max(5.0, float(anchor.get("radius") or 6))
        # The coarse document warp can still leave camera/background margin,
        # especially at the top edge. Search far enough to find the printed
        # registration square, then let the anchor transform correct the page.
        search = int(round(max(36.0, radius * 10.0, min(w, h) * 0.15)))
        x1 = max(0, int(round(ex)) - search)
        y1 = max(0, int(round(ey)) - search)
        x2 = min(w, int(round(ex)) + search + 1)
        y2 = min(h, int(round(ey)) + search + 1)
        roi = gray[y1:y2, x1:x2]
        if roi.size == 0:
            continue

        _, dark = cv2.threshold(roi, 140, 255, cv2.THRESH_BINARY_INV)
        dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        best = None
        best_score = float("inf")
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < max(20.0, radius * radius * 0.5) or area > max(900.0, radius * radius * 10.0):
                continue
            bx, by, bw, bh = cv2.boundingRect(contour)
            if bw <= 0 or bh <= 0:
                continue
            aspect = bw / float(bh)
            if aspect < 0.55 or aspect > 1.85:
                continue
            if bw > search * 1.5 or bh > search * 1.5:
                continue
            cx = x1 + bx + bw / 2.0
            cy = y1 + by + bh / 2.0
            dist = math.hypot(cx - ex, cy - ey)
            score = dist + abs(bw - bh) * 0.4
            if score < best_score:
                best_score = score
                best = (cx, cy, area, bw, bh, dist)

        if best is None:
            continue

        cx, cy, area, bw, bh, dist = best
        detected.append([cx, cy])
        expected.append([ex, ey])
        details.append({
            "label": anchor["label"],
            "expected": {"x": round(ex, 2), "y": round(ey, 2)},
            "detected": {"x": round(cx, 2), "y": round(cy, 2)},
            "distance": round(dist, 2),
            "area": round(area, 2),
            "size": {"width": bw, "height": bh},
        })

    if len(detected) < 3:
        return None, {
            "active": False,
            "success": False,
            "anchorCount": len(anchors),
            "detectedCount": len(detected),
            "anchors": details,
            "error": "insufficient_detected_anchors",
        }

    src = np.array(detected, dtype=np.float32)
    dst = np.array(expected, dtype=np.float32)

    H = None
    method = "homography"
    if len(detected) >= 4:
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    else:
        affine, _ = cv2.estimateAffinePartial2D(src, dst)
        if affine is not None:
            H = np.vstack([affine, [0.0, 0.0, 1.0]])
            method = "affine"

    if H is None:
        return None, {
            "active": False,
            "success": False,
            "anchorCount": len(anchors),
            "detectedCount": len(detected),
            "anchors": details,
            "error": "transform_failed",
        }

    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), H).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    mean_error = float(np.mean(errors)) if len(errors) else 999.0
    confidence = max(0.0, min(1.0, 1.0 - mean_error / 12.0))

    return H, {
        "active": True,
        "success": True,
        "method": method,
        "anchorCount": len(anchors),
        "detectedCount": len(detected),
        "meanError": round(mean_error, 2),
        "confidence": round(confidence, 3),
        "anchors": details,
    }


def _apply_point_transform(H, x, y):
    pt = np.array([float(x), float(y), 1.0])
    projected = H @ pt
    if projected[2] == 0:
        return float(x), float(y)
    return float(projected[0] / projected[2]), float(projected[1] / projected[2])


def _transform_bubbles_to_layout_space(bubbles, H):
    if H is None:
        return bubbles
    transformed = []
    for bubble in bubbles:
        tx, ty = _apply_point_transform(H, bubble["x"], bubble["y"])
        transformed.append({
            **bubble,
            "rawX": bubble["x"],
            "rawY": bubble["y"],
            "x": int(round(tx)),
            "y": int(round(ty)),
        })
    return transformed


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--stdin":
        raise RuntimeError("Usage: layout_worker.py --stdin <json-options>")

    options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    layouts_dir = Path(options.get("layoutsDir") or LAYOUT_DIR)
    debug_dir = Path(options.get("debugDir") or DEBUG_DIR)
    threshold = float(options.get("threshold") or 0.38)
    request_id = str(options.get("requestId") or "")
    debug_problem_questions = options.get("debugProblemQuestions", False)
    problem_debug_dir = debug_dir if debug_problem_questions else None
    debug_ratios = options.get("debugRatios", False) or debug_problem_questions or options.get("debug", False)
    use_cnn = options.get("useCnn", HAS_CNN_CLASSIFIER)

    image_bytes = sys.stdin.buffer.read()
    if not image_bytes:
        raise RuntimeError("No image bytes received on stdin.")

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Failed to decode input image.")

    rotation = int(options.get("rotation", 0) or 0)
    if rotation:
        center = (image.shape[1] / 2.0, image.shape[0] / 2.0)
        matrix = cv2.getRotationMatrix2D(center, rotation, 1.0)
        image = cv2.warpAffine(image, matrix, (image.shape[1], image.shape[0]))

    # --- Auto-rotate (fix upside-down images) ---
    auto_rotate_enabled = options.get("autoRotate", True)
    auto_rotated = False
    auto_rotate_confidence = 0.0
    if auto_rotate_enabled:
        image, auto_rotated, auto_rotate_confidence = auto_rotate_image(image)
        if auto_rotated:
            sys.stderr.write(
                f"layout_worker auto_rotate: flipped 180° "
                f"confidence={auto_rotate_confidence}\n"
            )

    # --- Image quality assessment ---
    quality = assess_image_quality(image)

    # --- Multi-angle rotation search (only if quality is reasonable) ---
    rotation_search_enabled = options.get("rotationSearch", True)
    best_rotation_angle = 0.0
    if rotation_search_enabled and quality.get("overallQuality", 0) >= 0.3:
        try:
            # Probe layout size for rotation search
            _temp_exam_id = str(options.get("examId") or "").strip()
            _temp_layout = None
            if _temp_exam_id:
                try:
                    _temp_layout, _ = load_layout(_temp_exam_id, layouts_dir)
                except Exception:
                    pass
            if _temp_layout:
                _ss = _temp_layout.get("sheetSize") or _temp_layout.get("sheet_size") or {}
                _lw = int(round(float(_ss.get("width") or 0)))
                _lh = int(round(float(_ss.get("height") or 0)))
                if _lw > 0 and _lh > 0:
                    best_rotation_angle, _, _ = _find_best_rotation(
                        image, _lw, _lh, max_angle=3.0, step=1.0
                    )
            # Apply best rotation if non-zero
            if abs(best_rotation_angle) > 0.5:
                sys.stderr.write(
                    f"layout_worker rotation: applying {best_rotation_angle:.1f}deg correction\n"
                )
                center = (image.shape[1] / 2.0, image.shape[0] / 2.0)
                rot_matrix = cv2.getRotationMatrix2D(center, best_rotation_angle, 1.0)
                image = cv2.warpAffine(image, rot_matrix, (image.shape[1], image.shape[0]))
        except Exception as exc:
            sys.stderr.write(f"layout_worker rotation_search error: {exc}\n")
            best_rotation_angle = 0.0

    quad = detect_document(image)
    # Smart QR probe: use the detected quad's aspect ratio to choose probe dimensions
    # This ensures QR codes are readable regardless of paper size (8.5×13, 11×14, etc.)
    qr_probe_w, qr_probe_h = _get_qr_probe_size(quad)
    qr_probe, _, _ = warp_to_size(image, quad, qr_probe_w, qr_probe_h)
    barcode_data, barcode_status = decode_qr_from_image(qr_probe)
    if not barcode_data:
        barcode_data, barcode_status = decode_qr_from_image(image)

    exam_id = str(barcode_data.get("examId") or barcode_data.get("exam_id") or options.get("examId") or "").strip()
    if not exam_id:
        sys.stdout.write(json.dumps({
            "success": False,
            "scanMode": "generated_layout",
            "workerUsed": "layout_worker",
            "layoutFound": False,
            "error": "QR code not detected.",
            "barcodeData": barcode_data or {},
            "barcodeStatus": barcode_status,
        }))
        return

    try:
        layout, layout_path = load_layout(exam_id, layouts_dir)
    except FileNotFoundError:
        sys.stdout.write(json.dumps({
            "success": False,
            "scanMode": "generated_layout",
            "workerUsed": "layout_worker",
            "layoutFound": False,
            "layoutId": slug_id(exam_id) or None,
            "examId": exam_id,
            "exam_id": exam_id,
            "error": "Layout not found.",
            "requiresLayout": True,
            "barcodeData": {
                **(barcode_data or {}),
                "examId": exam_id,
                "exam_id": exam_id,
            },
            "barcodeStatus": barcode_status,
        }))
        return

    layout_id = slug_id(exam_id)
    layout_bubble_count = count_layout_bubbles(layout)
    sheet_size = layout.get("sheetSize") or layout.get("sheet_size") or {}
    width = int(round(float(sheet_size.get("width") or 0)))
    height = int(round(float(sheet_size.get("height") or 0)))
    if width <= 0 or height <= 0:
        raise RuntimeError("Layout sheetSize.width and sheetSize.height are required.")

    normalized, alignment_mode, content_quad = warp_to_size(image, quad, width, height)

    actual_h, actual_w = normalized.shape[:2]
    size_match = (actual_w == width and actual_h == height)
    if not size_match:
        sys.stderr.write(
            f"layout_worker size_mismatch: warped=({actual_w},{actual_h}) "
            f"layout=({width},{height})\n"
        )
        sys.stderr.flush()

    gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)

    corrected_barcode_data, corrected_barcode_status = decode_qr_from_image(normalized)
    if corrected_barcode_data:
        barcode_data = {**barcode_data, **corrected_barcode_data}
        barcode_status = corrected_barcode_status
    barcode_data["examId"] = exam_id
    barcode_data["exam_id"] = exam_id

    dx, dy, alignment_info = find_border_offset(gray)
    alignment_confidence = compute_alignment_confidence(alignment_info, dx, dy)

    # --- Iterative border refinement: if offset > 2px, adjust warp and retry ---
    border_refinement_used = False
    border_refinement_iterations = 0
    max_refine_iters = 3
    if quad is not None and (abs(dx) > 2 or abs(dy) > 2):
        for refine_iter in range(max_refine_iters):
            # Adjust the destination quad by the offset
            adjusted_quad = np.array(quad, dtype=np.float32)
            adjusted_quad[:, 0] -= dx  # shift left
            adjusted_quad[:, 1] -= dy  # shift up
            normalized, alignment_mode, content_quad = warp_to_size(image, adjusted_quad, width, height)
            border_refinement_used = True
            border_refinement_iterations += 1

            actual_h, actual_w = normalized.shape[:2]
            gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
            gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)

            # Re-measure border offset
            dx_new, dy_new, alignment_info_new = find_border_offset(gray)
            sides_new = sum([
                1 if alignment_info_new.get("detectedTop") else 0,
                1 if alignment_info_new.get("detectedLeft") else 0,
                1 if alignment_info_new.get("detectedRight") else 0,
                1 if alignment_info_new.get("detectedBottom") else 0,
            ])
            offset_mag_new = abs(dx_new) + abs(dy_new)
            if sides_new >= 3 and offset_mag_new <= 2:
                dx, dy, alignment_info = dx_new, dy_new, alignment_info_new
                alignment_confidence = compute_alignment_confidence(alignment_info, dx, dy)
                sys.stderr.write(
                    f"layout_worker border_refinement: iter={refine_iter+1} "
                    f"dx={dx} dy={dy} converged\n"
                )
                break
            elif sides_new >= 3 and offset_mag_new < (abs(dx) + abs(dy)):
                dx, dy, alignment_info = dx_new, dy_new, alignment_info_new
                alignment_confidence = compute_alignment_confidence(alignment_info, dx, dy)
                sys.stderr.write(
                    f"layout_worker border_refinement: iter={refine_iter+1} "
                    f"dx={dx} dy={dy} improved\n"
                )
            else:
                sys.stderr.write(
                    f"layout_worker border_refinement: iter={refine_iter+1} "
                    f"no improvement, stopping\n"
                )
                break

    # --- Re-decode QR from refined image ---
    if border_refinement_used:
        refined_barcode_data, refined_barcode_status = decode_qr_from_image(normalized)
        if refined_barcode_data:
            barcode_data = {**barcode_data, **refined_barcode_data}
            barcode_status = refined_barcode_status

    has_subjects = bool(layout.get("subjects"))
    if has_subjects:
        H, section_transform_info = _compute_section_transform(gray, layout, width, height)
    else:
        H, section_transform_info = None, None
    use_section_xform = (
        H is not None
        and section_transform_info is not None
        and section_transform_info.get("confidence", 0) >= 0.4
        and section_transform_info.get("point_count", 0) >= 4
    )

    detected_bubbles, filled_threshold_mask = detect_filled_bubble_contours(normalized)
    raw_candidate_count = len(detected_bubbles)

    # ROI filter: only keep candidates inside known answer regions
    # (subject blocks, entry group, equity group).  This excludes QR patterns,
    # logos, corner markers, borders, header text, etc.
    scan_regions = _build_scan_regions(layout)
    if scan_regions:
        detected_bubbles = [b for b in detected_bubbles if _inside_any_region(b, scan_regions)]
    else:
        sys.stderr.write("layout_worker warning: no scan regions built; skipping ROI candidate filter\n")
    roi_candidate_count = len(detected_bubbles)

    anchor_transform, anchor_info = _detect_registration_anchor_transform(gray, layout)
    anchor_active = bool(anchor_transform is not None and anchor_info.get("success"))
    classified_bubbles = _transform_bubbles_to_layout_space(detected_bubbles, anchor_transform) if anchor_active else detected_bubbles
    fallback_H = None
    if anchor_active:
        try:
            fallback_H = np.linalg.inv(anchor_transform)
        except Exception:
            fallback_H = None
    contour_result = classify_contour_omr(
        classified_bubbles,
        layout,
        gray=gray,
        fallback_H=fallback_H,
        fallback_threshold=threshold,
        debug_dir=problem_debug_dir,
        request_id=request_id,
        debug_ratios=debug_ratios,
    )
    entry_result = contour_result["entryResult"]
    equity_result = contour_result["equityResult"]
    answers = contour_result["answers"]
    answersBySubject = contour_result["answersBySubject"]
    question_metrics = contour_result["questionMetrics"]
    mapped_bubbles = contour_result["mappedBubbles"]
    unmapped_bubbles = contour_result["unmappedBubbles"]

    detected_count = sum(1 for answer in answers if answer and answer != "multiple")
    multiple_count = sum(1 for answer in answers if answer == "multiple")
    blank_count = sum(1 for answer in answers if not answer or answer == "")
    scanned_count = detected_count + multiple_count
    mapped_bubble_count = len(mapped_bubbles)
    detected_bubble_count = len(detected_bubbles)
    unmapped_bubble_count = len(unmapped_bubbles)
    evaluated_bubble_count = 0
    evaluated_bubble_count += len(entry_result.get("metrics") or [])
    evaluated_bubble_count += len(equity_result.get("metrics") or [])
    for metric in question_metrics:
        evaluated_bubble_count += len(metric.get("options") or [])
    total = len(answers)
    section_conf = section_transform_info.get("confidence", 0) if section_transform_info else 0
    mapping_confidence = mapped_bubble_count / max(1, detected_bubble_count)
    anchor_confidence = float(anchor_info.get("confidence") or 0) if anchor_active else 0.0
    effective_alignment_confidence = (
        anchor_confidence
        if anchor_active
        else (section_conf if use_section_xform else alignment_confidence)
    )
    detection_coverage = detected_count / max(1, total)
    avg_question_confidence = (
        sum(m.get("confidence", 0) for m in question_metrics) / max(1, len(question_metrics))
    ) if question_metrics else 0
    overall_confidence = (
        effective_alignment_confidence * 0.12 +
        mapping_confidence * 0.18 +
        detection_coverage * 0.35 +
        avg_question_confidence * 0.35
    )
    overall_confidence = max(0.05, min(1.0, overall_confidence))
    entry_state = entry_result.get("state", "blank")
    needs_review = (
        (has_subjects and not anchor_active and section_conf < 0.35)
        or (detected_bubble_count > 0 and mapped_bubble_count == 0)
        or unmapped_bubble_count > max(3, mapped_bubble_count)
        or multiple_count > 0
        or entry_state != "valid"
        or detection_coverage < 0.50
    )
    warning = "Layout mapping confidence is low." if needs_review else None

    debug_path = None
    if options.get("debug", True):
        debug_dir.mkdir(parents=True, exist_ok=True)
        overlay = draw_debug_layout_overlay(
            normalized, layout, entry_result, equity_result,
            question_metrics, alignment_info, dx, dy,
            H=H, section_transform_info=section_transform_info, anchor_info=anchor_info,
            fallback_H=fallback_H,
        )
        if options.get("showRawCandidates", False):
            for bubble in unmapped_bubbles:
                draw_x = int(bubble.get("rawX", bubble["x"]))
                draw_y = int(bubble.get("rawY", bubble["y"]))
                cv2.circle(overlay, (draw_x, draw_y), int(bubble["radius"]), (0, 0, 255), 2)
                cv2.putText(
                    overlay,
                    "unmapped",
                    (draw_x + int(bubble["radius"]) + 3, draw_y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.35,
                    (0, 0, 255),
                    1,
                    cv2.LINE_AA,
                )
        filename = f"layout_omr_debug_{slug_id(exam_id) or 'unknown'}_{int(time.time() * 1000)}.png"
        full_path = debug_dir / filename
        cv2.imwrite(str(full_path), overlay)
        debug_path = f"/uploads/debug/{filename}"

        alignment_overlay = normalized.copy()
        cv2.putText(
            alignment_overlay,
            f"WarpAlign: dx={dx} dy={dy} conf={alignment_confidence:.2f} "
            f"top={alignment_info.get('topOffset', '?')} "
            f"left={alignment_info.get('leftOffset', '?')} "
            f"right={alignment_info.get('rightOffset', '?')} "
            f"bottom={alignment_info.get('bottomOffset', '?')}",
            (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1, cv2.LINE_AA,
        )
        if use_section_xform:
            cv2.putText(
                alignment_overlay,
                f"SectionXform: conf={section_conf:.2f} pts={section_transform_info.get('point_count', 0)} "
                f"err={section_transform_info.get('mean_error', 0):.1f}px active={use_section_xform}",
                (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1, cv2.LINE_AA,
            )
        if warning:
            cv2.putText(
                alignment_overlay,
                f"WARNING: {warning}",
                (10, 80 if use_section_xform else 55),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2, cv2.LINE_AA,
            )
        align_filename = f"layout_omr_align_{slug_id(exam_id) or 'unknown'}_{int(time.time() * 1000)}.png"
        align_full_path = debug_dir / align_filename
        cv2.imwrite(str(align_full_path), alignment_overlay)

    log_payload = {
        "scanMode": "generated_layout",
        "layoutId": layout_id,
        "layoutBubbleCount": layout_bubble_count,
        "evaluatedBubbleCount": evaluated_bubble_count,
        "detectedAnswerCount": detected_count,
        "detectedBubbleCount": detected_bubble_count,
        "mappedBubbleCount": mapped_bubble_count,
        "unmappedBubbleCount": unmapped_bubble_count,
        "mappingConfidence": round(mapping_confidence, 3),
        "anchorAlignmentActive": anchor_active,
        "anchorAlignmentConfidence": round(anchor_confidence, 3),
        "alignmentDx": dx,
        "alignmentDy": dy,
        "alignmentConfidence": round(effective_alignment_confidence, 3),
        "borderAlignmentConfidence": alignment_confidence,
        "sectionXformConfidence": round(section_conf, 3),
        "sectionXformActive": use_section_xform,
        "needsReview": needs_review,
        "rawCandidatesDetected": raw_candidate_count,
        "candidatesAfterRoiFilter": roi_candidate_count,
        "activeQuestionCount": total,
        "scannedCount": scanned_count,
        "blankCount": blank_count,
    }
    sys.stderr.write(f"layout_worker metrics {json.dumps(log_payload, sort_keys=True)}\n")
    sys.stderr.flush()

    result = {
        "success": True,
        "warning": warning,
        "answers": answers,
        "answersBySubject": answersBySubject,
        "confidence": {str(index): metric.get("confidence", 0) for index, metric in enumerate(question_metrics)},
        "overallConfidence": overall_confidence,
        "detectionCoverage": detected_count / max(1, total),
        "activeQuestionCount": total,
        "scannedCount": scanned_count,
        "detectedCount": detected_count,
        "multipleCount": multiple_count,
        "blankCount": blank_count,
        "scanQualityConfidence": overall_confidence,
        "imageQuality": quality,
        "rotationCorrected": round(best_rotation_angle, 1),
        "autoRotated": auto_rotated,
        "autoRotateConfidence": round(auto_rotate_confidence, 3),
        "borderRefinementUsed": border_refinement_used,
        "borderRefinementIterations": border_refinement_iterations,
        "alignmentConfidence": round(effective_alignment_confidence, 3),
        "borderAlignmentConfidence": alignment_confidence,
        "mappingConfidence": round(mapping_confidence, 3),
        "anchorAlignmentActive": anchor_active,
        "anchorAlignmentConfidence": round(anchor_confidence, 3),
        "anchorAlignmentInfo": anchor_info,
        "alignmentOffset": {"dx": dx, "dy": dy},
        "alignmentInfo": alignment_info,
        "alignmentSource": "anchors" if anchor_active else ("layout-lines" if use_section_xform else ("border" if alignment_confidence >= 0.75 else "fallback")),
        "alignmentMode": alignment_mode,
        "contentQuad": content_quad,
        "correctedSize": {"width": actual_w, "height": actual_h},
        "needsReview": needs_review,
        "sectionTransformActive": use_section_xform,
        "sectionTransformInfo": section_transform_info,
        "layoutSheetSize": {"width": width, "height": height},
        "sizeMatch": size_match,
        "templateType": "generated_layout",
        "templateConfidence": 1.0,
        "templateMetrics": {
            "engine": "generated-layout",
            "layoutPath": layout_path,
            "layoutVersion": layout.get("layoutVersion") or layout.get("layout_version"),
            "sheetSize": {"width": width, "height": height},
            "scanMode": "generated_layout",
            "layoutId": layout_id,
            "layoutBubbleCount": layout_bubble_count,
            "evaluatedBubbleCount": evaluated_bubble_count,
            "detectedAnswerCount": detected_count,
            "detectedCount": detected_count,
            "detectedBubbleCount": detected_bubble_count,
            "mappedBubbleCount": mapped_bubble_count,
            "unmappedBubbleCount": unmapped_bubble_count,
            "mappingConfidence": round(mapping_confidence, 3),
            "anchorAlignmentActive": anchor_active,
            "anchorAlignmentConfidence": round(anchor_confidence, 3),
            "multipleCount": multiple_count,
            "blankCount": blank_count,
            "scannedCount": scanned_count,
            "activeQuestionCount": total,
            "rawCandidatesDetected": raw_candidate_count,
            "candidatesAfterRoiFilter": roi_candidate_count,
        },
        "scanMode": "generated_layout",
        "workerUsed": "layout_worker",
        "layoutFound": True,
        "layoutId": layout_id,
        "examId": exam_id,
        "exam_id": exam_id,
        "layoutBubbleCount": layout_bubble_count,
        "evaluatedBubbleCount": evaluated_bubble_count,
        "detectedAnswerCount": detected_count,
        "detectedBubbleCount": detected_bubble_count,
        "mappedBubbleCount": mapped_bubble_count,
        "unmappedBubbleCount": unmapped_bubble_count,
        "rawCandidatesDetected": raw_candidate_count,
        "candidatesAfterRoiFilter": roi_candidate_count,
        "detectedBubbles": detected_bubbles,
        "mappedBubbles": mapped_bubbles,
        "unmappedBubbles": unmapped_bubbles,
        "questionMetrics": question_metrics,
        "debugThresholds": {
            "bubbleThreshold": round(threshold, 2),
            "contourDarknessThreshold": 0.48,
            "contourCircularityThreshold": 0.62,
            "contourOccupancyThreshold": 0.48,
            "fallbackSampleThreshold": round(max(0.34, threshold * 0.85), 2),
            "roiFillThreshold": round(threshold, 2),
            "cnnAvailable": HAS_CNN_CLASSIFIER,
            "cnnEnabled": use_cnn,
        },
        "debugSummary": {
            "lowConfidenceCount": sum(1 for m in question_metrics if m.get("lowConfidence")),
            "disagreementCount": sum(1 for m in question_metrics if m.get("disagreement")),
            "blankWithRatioAboveThresholdCount": sum(1 for m in question_metrics if m.get("state") == "blank" and m.get("ratioSelectedOption") is not None),
            "cnnUsed": use_cnn and HAS_CNN_CLASSIFIER,
        },
        "debugImagePath": debug_path,
        "barcodeData": barcode_data,
        "barcodeStatus": barcode_status,
        "entryGroup": entry_result,
        "equityGroupResult": equity_result,
        "equityGroup": ", ".join(equity_result.get("values") or []),
        "entryType": entry_result.get("studentType") or "",
        "entryState": entry_result.get("state", "blank"),
        "entryStudentType": entry_result.get("studentType"),
        "entryResidencyType": entry_result.get("residencyType"),
        "equityGroupValues": equity_result.get("values") or [],
        "specialEquityGroup": ", ".join(equity_result.get("values") or []),
        "proctorStatus": "Verified",
        "processedSuccessfully": True,
        "omrEngineUsed": "generated-layout",
    }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write(str(exc))
        sys.exit(1)
