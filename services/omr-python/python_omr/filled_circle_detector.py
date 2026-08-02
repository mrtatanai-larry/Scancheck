#!/usr/bin/env python3
"""Detect filled answer bubbles for ScanCheck debug visualization."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

from layout_worker import detect_document, warp_to_size


def load_image(args: argparse.Namespace) -> np.ndarray:
    if args.stdin:
        data = sys.stdin.buffer.read()
        if not data:
            raise ValueError("No image bytes received on stdin")
        encoded = np.frombuffer(data, dtype=np.uint8)
        image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    else:
        if not args.image:
            raise ValueError("Image path is required unless --stdin is used")
        image = cv2.imread(str(args.image), cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("Unable to decode image")

    return image


def circular_mask(shape: tuple[int, int], center: tuple[float, float], radius: float) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.circle(mask, (int(round(center[0])), int(round(center[1]))), int(round(radius)), 255, -1)
    return mask


def contour_confidence(
    gray: np.ndarray,
    dark_mask: np.ndarray,
    center: tuple[float, float],
    radius: float,
) -> tuple[float, float]:
    mask = circular_mask(gray.shape, center, radius)
    pixel_count = int(cv2.countNonZero(mask))
    if pixel_count == 0:
        return 0.0, 0.0

    dark_pixels = int(cv2.countNonZero(cv2.bitwise_and(dark_mask, dark_mask, mask=mask)))
    darkness = dark_pixels / float(pixel_count)

    mean_gray = float(cv2.mean(gray, mask=mask)[0])
    tone_score = max(0.0, min(1.0, (255.0 - mean_gray) / 255.0))
    confidence = max(darkness, tone_score)
    return darkness, confidence


def dedupe_circles(circles: list[dict]) -> list[dict]:
    if not circles:
        return []

    sorted_circles = sorted(circles, key=lambda item: item["darkness"], reverse=True)
    kept: list[dict] = []

    for circle in sorted_circles:
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

    return kept


def group_rows(circles: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    if not circles:
        return [], [], []

    radii = [float(circle["radius"]) for circle in circles]
    median_radius = float(np.median(radii)) if radii else 10.0
    row_tolerance = max(8.0, median_radius * 1.6)
    question_gap = max(22.0, median_radius * 4.0)

    rows: list[list[dict]] = []
    for circle in sorted(circles, key=lambda item: (item["y"], item["x"])):
        if not rows:
            rows.append([circle])
            continue

        current_row = rows[-1]
        row_y = sum(float(item["y"]) for item in current_row) / len(current_row)
        if abs(float(circle["y"]) - row_y) <= row_tolerance:
            current_row.append(circle)
        else:
            rows.append([circle])

    row_summaries: list[dict] = []
    question_groups: list[dict] = []
    grouped_circles: list[dict] = []

    for row_index, row in enumerate(rows, start=1):
        sorted_row = sorted(row, key=lambda item: item["x"])
        if not sorted_row:
            continue

        row_y = round(sum(float(item["y"]) for item in sorted_row) / len(sorted_row), 2)
        row_summaries.append(
            {
                "row": row_index,
                "y": row_y,
                "count": len(sorted_row),
                "bubble_indexes": [],
            }
        )

        groups: list[list[dict]] = []
        for circle in sorted_row:
            if not groups:
                groups.append([circle])
                continue

            previous = groups[-1][-1]
            if float(circle["x"]) - float(previous["x"]) > question_gap:
                groups.append([circle])
            else:
                groups[-1].append(circle)

        for group_index, group in enumerate(groups, start=1):
            for circle in group:
                grouped = {
                    **circle,
                    "row": row_index,
                    "question_group": group_index,
                }
                grouped_circles.append(grouped)
                row_summaries[-1]["bubble_indexes"].append(len(grouped_circles) - 1)

            question_groups.append(
                {
                    "row": row_index,
                    "question_group": group_index,
                    "count": len(group),
                    "bubbles": [
                        {
                            "x": item["x"],
                            "y": item["y"],
                            "radius": item["radius"],
                            "darkness": item["darkness"],
                        }
                        for item in group
                    ],
                }
            )

    return row_summaries, question_groups, grouped_circles


def load_layout(exam_id: str, layouts_dir: Path) -> dict | None:
    if not exam_id or not layouts_dir:
        return None
    layouts_dir = Path(layouts_dir)
    if not layouts_dir.is_dir():
        return None

    exact = layouts_dir / f"{exam_id}.json"
    if exact.is_file():
        with open(exact) as f:
            return json.load(f)

    slug = exam_id.lower().replace("-", "").replace("_", "")
    for f in layouts_dir.glob("*.json"):
        stem = f.stem.lower().replace("-", "").replace("_", "")
        if slug == stem or slug in stem or stem in slug:
            with open(f) as fh:
                return json.load(fh)

    return None


def map_bubbles_to_answers(bubbles: list, layout: dict, image_width: int, image_height: int):
    subjects = layout.get("subjects") or []
    if not subjects:
        return {}, []

    subject_blocks = []
    for s in subjects:
        block = s.get("block", {})
        subject_blocks.append({
            "name": s.get("name", s.get("code", "")),
            "code": s.get("code", ""),
            "left": block.get("left", 0),
            "top": block.get("top", 0),
            "right": block.get("left", 0) + block.get("width", 0),
            "bottom": block.get("top", 0) + block.get("height", 0),
            "questions": s.get("questions", []),
        })

    answer_top = min((sb["top"] for sb in subject_blocks), default=0)
    answer_bottom = max((sb["bottom"] for sb in subject_blocks), default=image_height)

    def get_choice_lanes(choices):
        sorted_items = sorted(choices.items(), key=lambda item: item[1].get("x", 0))
        lane_labels = ["A", "B", "C", "D", "E", "F"]
        lanes = {}
        for i, (orig_label, data) in enumerate(sorted_items):
            if i < len(lane_labels):
                lanes[lane_labels[i]] = {
                    "x": data.get("x", 0),
                    "y": data.get("y", 0),
                    "original_label": orig_label,
                }
        return lanes

    mapped_bubbles = []
    for bubble in bubbles:
        bx = bubble["x"]
        by = bubble["y"]

        if by < answer_top or by > answer_bottom:
            continue

        matched = None
        for sb in subject_blocks:
            if sb["left"] <= bx <= sb["right"] and sb["top"] <= by <= sb["bottom"]:
                matched = sb
                break

        if not matched:
            continue

        best_q = None
        best_q_dist = float('inf')
        best_q_in_bounds = False
        for q in matched["questions"]:
            row = q.get("row", {})
            qy = row.get("y", 0)
            rl = row.get("left", 0)
            rr = row.get("right", 0)
            in_bounds = rl <= bx <= rr
            dist = abs(by - qy)
            if dist > 25:
                continue
            if best_q is None:
                best_q = q; best_q_dist = dist; best_q_in_bounds = in_bounds
            elif in_bounds and not best_q_in_bounds:
                best_q = q; best_q_dist = dist; best_q_in_bounds = True
            elif in_bounds == best_q_in_bounds and dist < best_q_dist:
                best_q = q; best_q_dist = dist
            elif in_bounds == best_q_in_bounds and dist == best_q_dist and in_bounds and not best_q_in_bounds:
                best_q = q; best_q_in_bounds = True

        if best_q is None:
            continue

        lanes = get_choice_lanes(best_q.get("choices", {}))
        best_choice = None
        best_choice_dist = float('inf')
        for label, lane in lanes.items():
            dist = abs(bx - lane["x"])
            if dist < best_choice_dist:
                best_choice_dist = dist
                best_choice = label

        if best_choice is None or best_choice_dist > 15:
            continue

        mapped_bubbles.append({
            "x": bx,
            "y": by,
            "subject": matched["name"],
            "subjectCode": matched["code"],
            "question": best_q["number"],
            "choice": best_choice,
            "confidence": bubble.get("confidence", 0),
            "darkness": bubble.get("darkness", 0),
        })

    mapped_answers = {}
    for sb in subject_blocks:
        mapped_answers[sb["name"]] = {}

    q_map = defaultdict(list)
    for mb in mapped_bubbles:
        q_map[(mb["subject"], mb["question"])].append(mb)

    for (subj, qno), blist in q_map.items():
        if len(blist) > 1:
            mapped_answers[subj][str(qno)] = "multiple"
        else:
            mapped_answers[subj][str(qno)] = blist[0]["choice"]

    return mapped_answers, mapped_bubbles


def detect_filled_circles(image: np.ndarray, layout: dict = None) -> tuple[dict, np.ndarray, np.ndarray]:
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

    circles: list[dict] = []
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

        circles.append(
            {
                "x": int(round(cx)),
                "y": int(round(cy)),
                "radius": int(round(radius)),
                "darkness": round(float(darkness), 4),
                "confidence": round(float(confidence), 4),
                "area": round(area, 2),
                "circularity": round(float(circularity), 4),
            }
        )

    circles = dedupe_circles(circles)
    circles = sorted(circles, key=lambda item: (item["y"], item["x"]))
    rows, questions, grouped_circles = group_rows(circles)

    debug_image = image.copy()
    for index, circle in enumerate(grouped_circles or circles, start=1):
        center = (int(circle["x"]), int(circle["y"]))
        radius = int(circle["radius"])
        cv2.circle(debug_image, center, radius, (0, 255, 0), 3)
        cv2.circle(debug_image, center, 2, (0, 255, 0), -1)
        cv2.putText(
            debug_image,
            str(index),
            (center[0] + radius + 3, center[1] - radius - 3),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 180, 0),
            1,
            cv2.LINE_AA,
        )

    result = {
        "count": len(grouped_circles or circles),
        "bubbles": grouped_circles or circles,
        "rows": rows,
        "questions": questions,
        "image_width": width,
        "image_height": height,
    }

    if layout is not None:
        mapped_answers, mapped_bubbles = map_bubbles_to_answers(
            grouped_circles or circles, layout, width, height
        )
        result["mappedAnswers"] = mapped_answers
        result["mappedBubbles"] = mapped_bubbles

        for mb in mapped_bubbles:
            cx, cy = int(mb["x"]), int(mb["y"])
            label = f"{mb['subjectCode']} Q{mb['question']} {mb['choice']}"
            cv2.putText(
                debug_image, label,
                (cx + 5, cy + 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 0, 0), 1, cv2.LINE_AA,
            )

    return result, debug_image, dark_mask


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect filled black answer circles.")
    parser.add_argument("image", nargs="?", type=Path, help="Input image path")
    parser.add_argument("--stdin", action="store_true", help="Read encoded image bytes from stdin")
    parser.add_argument("--debug-out", type=Path, help="Write debug image with green circles")
    parser.add_argument("--threshold-out", type=Path, help="Write threshold image")
    parser.add_argument("--layout-dir", type=Path, help="Layout directory for answer mapping")
    parser.add_argument("--exam-id", type=str, help="Exam ID for layout lookup")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        image = load_image(args)
        layout = load_layout(args.exam_id, args.layout_dir) if args.layout_dir and args.exam_id else None
        result, debug_image, threshold_image = detect_filled_circles(image, layout)

        if args.debug_out:
            args.debug_out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(args.debug_out), debug_image)
            result["debug_image"] = str(args.debug_out)

        if args.threshold_out:
            args.threshold_out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(args.threshold_out), threshold_image)
            result["threshold_image"] = str(args.threshold_out)

        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
