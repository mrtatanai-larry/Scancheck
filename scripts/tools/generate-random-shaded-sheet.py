#!/usr/bin/env python3
import argparse
from datetime import datetime
import json
import random
from pathlib import Path

import cv2


OPTIONS = ["A", "B", "C", "D"]


def parse_question_range(label):
    text = str(label or "").strip().lower()
    if not text.startswith("q") or ".." not in text:
        return None
    left, right = text[1:].split("..", 1)
    try:
        start = int(left)
        end = int(right)
    except ValueError:
        return None
    if start <= 0 or end < start:
        return None
    return start, end


def draw_filled_bubble(img, cx, cy, radius):
    # Fill interior strongly but keep edges anti-aliased.
    cv2.circle(img, (int(cx), int(cy)), int(radius), (30, 30, 30), -1, lineType=cv2.LINE_AA)


def build_bubble_snapper(image, expected_radius):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.medianBlur(gray, 5)
    min_r = max(6, int(expected_radius * 0.65))
    max_r = max(min_r + 2, int(expected_radius * 1.45))
    circles = cv2.HoughCircles(
        blur,
        cv2.HOUGH_GRADIENT,
        1.2,
        max(8, int(expected_radius * 1.35)),
        param1=120,
        param2=18,
        minRadius=min_r,
        maxRadius=max_r,
    )
    if circles is None:
        return []

    out = []
    for c in circles[0]:
        x, y, r = float(c[0]), float(c[1]), float(c[2])
        out.append((x, y, r))
    return out


def default_sheet_id():
    return f"SH-{datetime.now().strftime('%Y%m%d')}-{random.randint(1000, 9999)}"


def resolve_default_base_image():
    candidates = [
        Path("~/Downloads/template.png").expanduser(),
        Path("~/Downloads/test.png").expanduser(),
        Path(".runtime/omr-calib/input/scan.jpg.png"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return Path(".runtime/omr-calib/input/scan.jpg.png")


def normalize_subject_code(block_name):
    name = str(block_name or "").strip().lower()
    if not name:
        return "SUB"
    if name.startswith("q"):
        return name.upper()
    return name.replace(" ", "_").upper()


def parse_subject_counts(text):
    out = {}
    raw = str(text or "").strip()
    if not raw:
        return out
    for part in raw.split(","):
        item = part.strip()
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        key = key.strip().upper()
        try:
            out[key] = max(0, int(value.strip()))
        except ValueError:
            continue
    return out


def detect_subject_spans(question_blocks):
    blocks = sorted(question_blocks, key=lambda item: item["start_q"])
    if not blocks:
        return []

    # Preferred mapping for this project: 10 blocks in order, 2 blocks per subject.
    if len(blocks) == 10:
        names = ["MATH", "ENG", "SCI", "SOC", "FIL"]
        spans = []
        for i, name in enumerate(names):
            left = blocks[i * 2]
            right = blocks[i * 2 + 1]
            spans.append((name, left["start_q"], right["end_q"]))
        return spans

    # Generic fallback for non-standard templates.
    return [("ALL", blocks[0]["start_q"], blocks[-1]["end_q"])]


def main():
    parser = argparse.ArgumentParser(description="Generate randomized shaded OMR sheet from template.")
    parser.add_argument(
        "--base-image",
        default="",
        help="Base sheet image path. If omitted, the script tries ~/Downloads/template.png first.",
    )
    parser.add_argument(
        "--source-image",
        default="",
        help="Alias for --base-image; useful when shading a specific exported template file.",
    )
    parser.add_argument("--template", default=".runtime/omr-calib/input/template.json")
    parser.add_argument("--out-dir", default="~/Downloads")
    parser.add_argument("--out-image", default="")
    parser.add_argument("--out-key", default="")
    parser.add_argument("--sheet-id", default="")
    parser.add_argument("--numbering", choices=["subject", "global"], default="subject")
    parser.add_argument("--mode", choices=["subject-random", "full"], default="subject-random")
    parser.add_argument("--subject-min", type=int, default=1, help="Minimum shaded items per subject in subject-random mode.")
    parser.add_argument("--subject-max", type=int, default=25, help="Maximum shaded items per subject in subject-random mode.")
    parser.add_argument(
        "--subject-counts",
        default="",
        help="Explicit per-subject shaded counts, e.g. MATH=15,ENG=25,SCI=10,SOC=12,FIL=18",
    )
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument(
        "--no-snap",
        action="store_true",
        help="Disable bubble-center snapping and use raw template coordinates.",
    )
    parser.add_argument(
        "--snap-max-dist",
        type=float,
        default=36.0,
        help="Maximum pixel distance to snap to detected bubble centers.",
    )
    parser.add_argument(
        "--allow-unsnapped",
        action="store_true",
        help="If set, draw marks at raw template coordinates when snapping fails.",
    )
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    preferred_base = str(args.source_image or "").strip() or str(args.base_image or "").strip()
    base_image_path = Path(preferred_base).expanduser() if preferred_base else resolve_default_base_image()
    template_path = Path(args.template)
    out_dir = Path(args.out_dir).expanduser().resolve()
    sheet_id = str(args.sheet_id or "").strip() or default_sheet_id()
    file_id = sheet_id.replace(" ", "_")
    out_image_path = (
        Path(args.out_image).expanduser().resolve()
        if str(args.out_image or "").strip()
        else out_dir / f"scancheck-random-shaded-sheet-{file_id}.png"
    )
    out_key_path = (
        Path(args.out_key).expanduser().resolve()
        if str(args.out_key or "").strip()
        else out_dir / f"scancheck-random-shaded-sheet-{file_id}.answers.json"
    )

    if not base_image_path.exists():
        raise SystemExit(f"Base image not found: {base_image_path}")
    if not template_path.exists():
        raise SystemExit(f"Template not found: {template_path}")

    image = cv2.imread(str(base_image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Failed to open base image: {base_image_path}")

    template = json.loads(template_path.read_text(encoding="utf-8"))
    page_dimensions = template.get("pageDimensions", [1000, 1400])
    template_width = float(page_dimensions[0] or 1000)
    template_height = float(page_dimensions[1] or 1400)
    image_height, image_width = image.shape[:2]
    scale_x = image_width / template_width
    scale_y = image_height / template_height

    def sx(value):
        return float(value) * scale_x

    def sy(value):
        return float(value) * scale_y

    bubble_dimensions = template.get("bubbleDimensions", [18, 18])
    bubble_w = float(bubble_dimensions[0] if len(bubble_dimensions) > 0 else 18)
    bubble_h = float(bubble_dimensions[1] if len(bubble_dimensions) > 1 else bubble_w)
    bubble_radius = max(3, int(min(bubble_dimensions) * min(scale_x, scale_y) * 0.42))
    expected_radius = max(6.0, min(bubble_w * scale_x, bubble_h * scale_y) * 0.5)
    field_blocks = template.get("fieldBlocks", {})

    snap_points = []
    if not args.no_snap:
        snap_points = build_bubble_snapper(image, expected_radius)
    snap_hits = 0
    snap_misses = 0

    def snap_point(cx, cy):
        nonlocal snap_hits, snap_misses
        if not snap_points:
            snap_misses += 1
            return cx, cy, bubble_radius, False
        best = None
        best_d2 = None
        for sx0, sy0, sr0 in snap_points:
            dx = sx0 - cx
            dy = sy0 - cy
            d2 = dx * dx + dy * dy
            if best_d2 is None or d2 < best_d2:
                best_d2 = d2
                best = (sx0, sy0, sr0)
        if best is None:
            return cx, cy, bubble_radius
        max_d2 = float(args.snap_max_dist) * float(args.snap_max_dist)
        if best_d2 is None or best_d2 > max_d2:
            snap_misses += 1
            return cx, cy, bubble_radius, False
        sx0, sy0, sr0 = best
        snap_hits += 1
        snapped_radius = max(3, int(min(sr0 * 0.78, bubble_radius)))
        return float(sx0), float(sy0), snapped_radius, True

    answers_global = {}
    answers_by_subject = {}

    # Randomly shade entry and equity group.
    metadata = {}
    for block_name in ("entry_type", "equity_group"):
        block = field_blocks.get(block_name)
        if not block:
            continue
        origin = block.get("origin", [0, 0])
        labels_gap = float(block.get("labelsGap", block.get("bubblesGap", 30)))
        values = block.get("bubbleValues", [])
        if not values:
            continue
        idx = random.randrange(len(values))
        x = sx(float(origin[0]) + (bubble_w / 2.0))
        y = sy(float(origin[1]) + idx * labels_gap + (bubble_h / 2.0))
        x, y, r, ok = snap_point(x, y)
        if not ok and not args.allow_unsnapped:
            continue
        draw_filled_bubble(image, x, y, r)
        metadata[block_name] = values[idx]

    # Build question blocks first.
    question_blocks = []
    for block_name, block in field_blocks.items():
        labels = block.get("fieldLabels") or []
        if not labels:
            continue
        q_range = parse_question_range(labels[0])
        if not q_range:
            continue

        start_q, end_q = q_range
        question_blocks.append(
            {
                "name": block_name,
                "start_q": start_q,
                "end_q": end_q,
                "origin": block.get("origin", [0, 0]),
                "bubbles_gap": float(block.get("bubblesGap", 30)),
                "labels_gap": float(block.get("labelsGap", 24)),
            }
        )

    if not question_blocks:
        raise SystemExit("No question blocks found in template fieldBlocks.")

    question_blocks.sort(key=lambda item: item["start_q"])
    all_questions = []
    for block in question_blocks:
        all_questions.extend(range(block["start_q"], block["end_q"] + 1))
    max_question = max(all_questions)

    # Decide which questions will be shaded.
    explicit_counts = parse_subject_counts(args.subject_counts)
    subject_spans = detect_subject_spans(question_blocks)
    shaded_questions = set()
    subject_targets = {}

    if args.mode == "full":
        shaded_questions = set(all_questions)
        for subject_name, start_q, end_q in subject_spans:
            subject_targets[subject_name] = end_q - start_q + 1
    else:
        min_per_subject = max(0, int(args.subject_min))
        max_per_subject = max(min_per_subject, int(args.subject_max))
        for subject_name, start_q, end_q in subject_spans:
            subject_total = max(0, end_q - start_q + 1)
            if subject_total == 0:
                subject_targets[subject_name] = 0
                continue

            if subject_name in explicit_counts:
                target = explicit_counts[subject_name]
            else:
                low = min(min_per_subject, subject_total)
                high = min(max_per_subject, subject_total)
                if high < low:
                    high = low
                target = random.randint(low, high)

            target = min(subject_total, max(0, target))
            subject_targets[subject_name] = target
            if target <= 0:
                continue
            pool = list(range(start_q, end_q + 1))
            shaded_questions.update(random.sample(pool, target))

    # Generate answers for every question (blank when unshaded).
    for q_num in all_questions:
        answers_global[f"Q{q_num}"] = ""

    for subject_name, start_q, end_q in subject_spans:
        subject_answers = {}
        local_index = 1
        for q_num in range(start_q, end_q + 1):
            subject_answers[f"Q{local_index}"] = ""
            local_index += 1
        answers_by_subject[subject_name] = {
            "range": [start_q, end_q],
            "count": end_q - start_q + 1,
            "shadedCount": subject_targets.get(subject_name, 0),
            "answers": subject_answers,
        }

    # Shade selected questions.
    for block in question_blocks:
        start_q = block["start_q"]
        end_q = block["end_q"]
        origin = block["origin"]
        bubbles_gap = block["bubbles_gap"]
        labels_gap = block["labels_gap"]

        for offset, q_num in enumerate(range(start_q, end_q + 1)):
            if q_num not in shaded_questions:
                continue
            option_idx = random.randrange(len(OPTIONS))
            option = OPTIONS[option_idx]
            cx = sx(float(origin[0]) + option_idx * bubbles_gap + (bubble_w / 2.0))
            cy = sy(float(origin[1]) + offset * labels_gap + (bubble_h / 2.0))
            cx, cy, r, ok = snap_point(cx, cy)
            if not ok and not args.allow_unsnapped:
                continue
            draw_filled_bubble(image, cx, cy, r)
            answers_global[f"Q{q_num}"] = option

            for subject_name, subject_info in answers_by_subject.items():
                start_s, end_s = subject_info["range"]
                if start_s <= q_num <= end_s:
                    local_q = q_num - start_s + 1
                    subject_info["answers"][f"Q{local_q}"] = option
                    break

    out_image_path.parent.mkdir(parents=True, exist_ok=True)
    out_key_path.parent.mkdir(parents=True, exist_ok=True)

    if not cv2.imwrite(str(out_image_path), image):
        raise SystemExit(f"Failed to save output image: {out_image_path}")

    numbering_mode = str(args.numbering or "subject").strip().lower()
    if numbering_mode == "global":
        primary_answers = answers_global
    else:
        primary_answers = {
            subject: block_info["answers"]
            for subject, block_info in answers_by_subject.items()
        }

    payload = {
        "sheetId": sheet_id,
        "numberingMode": numbering_mode,
        "generationMode": args.mode,
        "entry_type": metadata.get("entry_type", ""),
        "equity_group": metadata.get("equity_group", ""),
        "subjectTargets": subject_targets,
        "answers": primary_answers,
        "answers_global": answers_global,
        "answers_by_subject": answers_by_subject,
    }
    out_key_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    preview = ", ".join(f"Q{i}:{answers_global.get(f'Q{i}', '-') or '-'}" for i in range(1, 21))
    print(f"Generated image: {out_image_path}")
    print(f"Generated key:   {out_key_path}")
    print(f"Sheet ID: {sheet_id}")
    print(f"Entry: {metadata.get('entry_type', '-')}, Equity: {metadata.get('equity_group', '-')}")
    print(f"Mode: {args.mode}, Numbering: {numbering_mode}")
    print(f"Subject targets: {subject_targets}")
    if args.no_snap:
        print("Snap mode: disabled")
    else:
        print(f"Snap mode: enabled (detected circles={len(snap_points)}, hits={snap_hits}, misses={snap_misses}, maxDist={args.snap_max_dist}px)")
    print(f"Preview answers: {preview}")


if __name__ == "__main__":
    main()
