#!/usr/bin/env python3
"""
Rate answer-sheet detection accuracy of the OMR engine.

Renders synthetic answer sheets directly from a generated layout JSON,
simulates a matrix of real-world capture degradations (camera perspective,
rotation, resolution, JPEG compression, blur, exposure, shadow), runs the
real layout_worker.py pipeline, and scores detected answers against the
known ground truth.

Usage:
    .venv/bin/python scripts/tools/rate-sheet-accuracy.py \
        --layout .runtime/data/omr-layouts/25.json \
        --out .runtime/data/accuracy-runs/25 \
        --report docs/active/ANSWERSHEET_ACCURACY_RATING.md

    .venv/bin/python scripts/tools/rate-sheet-accuracy.py \
        --layout .runtime/data/omr-layouts/18.json \
        --out .runtime/data/accuracy-runs/18

Output:
    - JSON results per run (out-dir/run-*.json)
    - per-case + overall aggregate JSON (out-dir/aggregate.json)
    - optional markdown report (--report)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PYTHON = os.environ.get("SCANCHECK_PYTHON") or str(ROOT / ".venv/bin/python")
WORKER = ROOT / "services" / "omr-python" / "python_omr" / "layout_worker.py"
DEFAULT_LAYOUTS_DIR = ROOT / ".runtime" / "data" / "omr-layouts"

# Photo/background palette (simulating a light scanner bed around the sheet).
BG = (212, 210, 205)
SHEET_WHITE = (255, 255, 255)
BORDER = (30, 30, 34)
ANCHOR_BLACK = (22, 22, 26)
RING = (52, 52, 58)
FILL = (62, 62, 68)
DENSITY = (198, 198, 204)
TIMING = (34, 34, 38)

# Format variants: bubble rendering scale vs. the recorded layout radius.
# 1.0 = bubbles printed at exactly the size captured in the layout JSON.
# 1.13 = bubbles printed ~13% larger (0.17in vs 0.15in) — print-time mismatch.
BUBBLE_SCALES = [1.0, 1.13]

NOMINAL = dict(
    photo_width=2200,
    persp=10,
    rot=0,
    blur=0.4,
    brightness=0,
    contrast=1.0,
    shadow=0.0,
    shadow_axis="top",
    jpeg_q=75,
    bg_dark=False,
    noise=4.0,
)


def build_cases():
    cases = [
        ("baseline", dict(NOMINAL, photo_width=3000, persp=6, blur=0.0, jpeg_q=90)),
        ("persp-10", dict(NOMINAL, persp=10)),
        ("persp-15", dict(NOMINAL, persp=15)),
        ("persp-20", dict(NOMINAL, persp=20)),
        ("persp-25", dict(NOMINAL, persp=25)),
        ("persp-30", dict(NOMINAL, persp=30)),
        ("rot--1", dict(NOMINAL, rot=-1)),
        ("rot-+1", dict(NOMINAL, rot=1)),
        ("rot--3", dict(NOMINAL, rot=-3)),
        ("rot-+3", dict(NOMINAL, rot=3)),
        ("width-1800", dict(NOMINAL, photo_width=1800)),
        ("width-1100", dict(NOMINAL, photo_width=1100)),
        ("width-800", dict(NOMINAL, photo_width=800)),
        ("jpeg-90", dict(NOMINAL, jpeg_q=90)),
        ("jpeg-60", dict(NOMINAL, jpeg_q=60)),
        ("jpeg-45", dict(NOMINAL, jpeg_q=45)),
        ("blur-0.5", dict(NOMINAL, blur=0.5)),
        ("blur-1.0", dict(NOMINAL, blur=1.0)),
        ("blur-1.5", dict(NOMINAL, blur=1.5)),
        ("bright+40", dict(NOMINAL, brightness=40)),
        ("bright-40", dict(NOMINAL, brightness=-40)),
        ("contrast-0.7", dict(NOMINAL, contrast=0.7)),
        ("contrast-0.55", dict(NOMINAL, contrast=0.55)),
        ("shadow-0.2-top", dict(NOMINAL, shadow=0.2, shadow_axis="top")),
        ("shadow-0.3-left", dict(NOMINAL, shadow=0.3, shadow_axis="left")),
        ("shadow-0.35-diag", dict(NOMINAL, shadow=0.35, shadow_axis="diag")),
        ("bg-dark", dict(NOMINAL, bg_dark=True)),
    ]
    return cases


def slug(exam_id):
    return "".join(c for c in str(exam_id or "") if c.isalnum() or c in "-_.")


def flat_questions(layout):
    """Iterate (flat_q_no, subject_code, question) in worker iteration order."""
    out = []
    n = 0
    for subject in layout.get("subjects") or []:
        code = subject.get("code") or subject.get("subject_code") or subject.get("name") or ""
        for question in subject.get("questions") or []:
            n += 1
            out.append((n, code, question))
    return out


def build_ground_truth(layout, seed):
    rng = random.Random(f"gt-{seed}")
    gt = {}
    for flat_no, code, question in flat_questions(layout):
        letters = sorted((question.get("choices") or {}).keys())
        answer = rng.choice(letters) if letters else ""
        gt[flat_no] = {"subject": code, "answer": answer, "choices": sorted((question.get("choices") or {}).keys())}
    return gt


def draw_ring(img, x, y, radius, border=2, fill=None):
    """Bubble ring: dark outline with white interior; optional filled interior."""
    c = (int(round(x)), int(round(y)))
    r = max(2, int(round(radius)))
    cv2.circle(img, c, r, RING, -1)
    if fill is not None:
        cv2.circle(img, c, max(2, r - 1), FILL, -1)
    else:
        cv2.circle(img, c, max(2, r - border), SHEET_WHITE, -1)


def qr_image(payload_json, modules_per_cell=4):
    import qrcode
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=modules_per_cell,
        border=4,
    )
    qr.add_data(payload_json)
    qr.make(fit=True)
    return np.array(qr.make_image(fill_color="black", back_color="white").convert("L"))


def render_sheet(layout, gt, bubble_scale=1.0, payload_json=None, render_scale=1.0):
    sheet = layout.get("sheetSize") or layout.get("sheet_size") or {}
    S = render_scale
    W = int(round(float(sheet.get("width") or 794) * S))
    H = int(round(float(sheet.get("height") or 1122) * S))
    img = np.full((H, W, 3), SHEET_WHITE, np.uint8)

    cv2.rectangle(img, (0, 0), (W - 1, H - 1), BORDER, max(2, int(round(4 * S))))

    qr_area = layout.get("qrArea") or layout.get("qr_area")
    if qr_area and payload_json:
        qr = qr_image(payload_json)
        box = qr_area.get("box") or qr_area
        left = int(round(float(qr_area.get("left") or box.get("left") or 0) * S))
        top = int(round(float(qr_area.get("top") or box.get("top") or 0) * S))
        width = int(round(float(qr_area.get("width") or box.get("width") or 0) * S))
        height = int(round(float(qr_area.get("height") or box.get("height") or 0) * S))
        pad = max(4, int(round(min(width, height) * 0.06)))
        inner_w, inner_h = max(8, width - 2 * pad), max(8, height - 2 * pad)
        img[top:top + height, left:left + width] = SHEET_WHITE
        scaled = cv2.resize(qr, (inner_w, inner_h), interpolation=cv2.INTER_AREA)
        img[top + pad:top + pad + inner_h, left + pad:left + pad + inner_w] = cv2.cvtColor(scaled, cv2.COLOR_GRAY2BGR)

    anchors = layout.get("registrationAnchors") or layout.get("registration_anchors") or {}

    for subject in layout.get("subjects") or []:
        block = subject.get("block") or {}
        if block:
            x0 = int(round(float(block.get("left") or 0) * S))
            y0 = int(round(float(block.get("top") or 0) * S))
            x1 = int(round(float(block.get("right") or (x0 + block.get("width", 0))) * S))
            y1 = int(round(float(block.get("bottom") or (y0 + block.get("height", 0))) * S))
            cv2.rectangle(img, (x0, y0), (x1, y1), RING, max(2, int(round(3 * S))))

    density = layout.get("densityRefs") or layout.get("density_refs") or {}
    for strip in density.values():
        box = strip.get("box") or strip
        x0 = int(round(float(box.get("left") or 0) * S))
        y0 = int(round(float(box.get("top") or 0) * S))
        x1 = int(round(float(box.get("right") or x0) * S))
        y1 = int(round(float(box.get("bottom") or y0) * S))
        cv2.rectangle(img, (x0, y0), (x1, y1), DENSITY, -1)

    for mark in layout.get("timingMarks") or layout.get("timing_marks") or []:
        rect = mark.get("rect") or mark
        x0 = int(round(float(rect.get("left") or 0) * S))
        y0 = int(round(float(rect.get("top") or 0) * S))
        x1 = int(round(float(rect.get("right") or x0) * S))
        y1 = int(round(float(rect.get("bottom") or y0) * S))
        cv2.rectangle(img, (x0, y0), (x1, y1), TIMING, -1)

    entry_selected = {"New Student"}
    for group_key in ("entryGroup", "equityGroup"):
        group = layout.get(group_key) or {}
        selected = entry_selected if group_key == "entryGroup" else set()
        for label, item in group.items():
            x = float(item.get("x") or 0) * S
            y = float(item.get("y") or 0) * S
            radius = float(item.get("radius") or 9.1) * S
            draw_ring(img, x, y, radius, border=max(2, int(round(2 * S))), fill=(label in selected))

    for flat_no, code, question in flat_questions(layout):
        answer = gt[flat_no]["answer"]
        for letter, choice in (question.get("choices") or {}).items():
            x = float(choice.get("x") or 0) * S
            y = float(choice.get("y") or 0) * S
            radius = float(choice.get("radius") or 7.2) * bubble_scale * S
            draw_ring(img, x, y, radius, border=max(2, int(round(2 * S))), fill=(letter == answer))

    for anchor in anchors.values():
        box = anchor.get("box") or {}
        if box:
            x0 = int(round(float(box.get("left") or 0) * S))
            y0 = int(round(float(box.get("top") or 0) * S))
            w0 = max(4, int(round(float(box.get("width") or 21) * S)))
            h0 = max(4, int(round(float(box.get("height") or 21) * S)))
            cv2.rectangle(img, (x0, y0), (x0 + w0, y0 + h0), ANCHOR_BLACK, -1)

    return img


def make_payload(layout, urlencoded=False):
    exam_id = str(layout.get("examId") or layout.get("exam_id") or layout.get("quizId") or "").strip()
    payload = {
        "examId": exam_id,
        "sheetId": str(layout.get("sheetId") or "").strip(),
        "studentName": "ACCURACY TEST",
        "course": "HARNESS",
        "age": "",
        "roomNo": "",
        "seatNo": "",
        "dateTime": "",
    }
    text = json.dumps(payload)
    if urlencoded:
        import urllib.parse
        text = urllib.parse.quote(text, safe="!'()*-._~")
    return text


def apply_photography(reference, cfg, rng):
    bg = BG if not cfg["bg_dark"] else (52, 54, 60)
    H, W = reference.shape[:2]
    margin = int(0.02 * max(W, H))

    amp = cfg["persp"] * 0.001 * W
    def jitter():
        return rng.uniform(-amp, amp)
    src = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype=np.float32)
    dst = np.array([
        [margin + jitter(), margin + jitter()],
        [margin + W + jitter(), margin + jitter()],
        [margin + W + jitter(), margin + H + jitter()],
        [margin + jitter(), margin + H + jitter()],
    ], dtype=np.float32)
    out_w = int(W + 2 * margin)
    out_h = int(H + 2 * margin)
    matrix = cv2.getPerspectiveTransform(src, dst)
    photo = cv2.warpPerspective(reference, matrix, (out_w, out_h), borderValue=bg)

    angle = cfg["rot"]
    if angle:
        center = (photo.shape[1] / 2.0, photo.shape[0] / 2.0)
        rot = cv2.getRotationMatrix2D(center, angle, 1.0)
        cos, sin = abs(np.cos(np.radians(angle))), abs(np.sin(np.radians(angle)))
        nw = int(photo.shape[0] * sin + photo.shape[1] * cos)
        nh = int(photo.shape[0] * cos + photo.shape[1] * sin)
        rot[0, 2] += (nw - photo.shape[1]) / 2.0
        rot[1, 2] += (nh - photo.shape[0]) / 2.0
        photo = cv2.warpAffine(photo, rot, (nw, nh), borderValue=bg)

    float_img = photo.astype(np.float32)
    contrast = cfg["contrast"]
    brightness = cfg["brightness"]
    if contrast != 1.0 or brightness:
        float_img = float_img * contrast + brightness

    if cfg["shadow"]:
        h, w = float_img.shape[:2]
        axis = cfg["shadow_axis"]
        if axis == "top":
            grad = np.linspace(1.0, 1.0 - cfg["shadow"], h, dtype=np.float32)[:, None, None]
        elif axis == "left":
            grad = np.linspace(1.0, 1.0 - cfg["shadow"], w, dtype=np.float32)[None, :, None]
        else:
            row = np.linspace(1.0, 1.0 - cfg["shadow"], h, dtype=np.float32)[:, None, None]
            col = np.linspace(1.0, 1.0 - cfg["shadow"], w, dtype=np.float32)[None, :, None]
            grad = row * col
        float_img = float_img * grad

    photo = np.clip(float_img, 0, 255).astype(np.uint8)

    if cfg.get("noise"):
        noise = np.random.default_rng(rng.randrange(2 ** 31)).normal(0.0, cfg["noise"], photo.shape)
        photo = np.clip(photo.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    if cfg["blur"]:
        k = max(3, int(round(cfg["blur"] * 4)) | 1)
        photo = cv2.GaussianBlur(photo, (k, k), cfg["blur"])

    target_w = int(cfg["photo_width"])
    if photo.shape[1] != target_w:
        scale = target_w / float(photo.shape[1])
        photo = cv2.resize(photo, (target_w, max(1, int(photo.shape[0] * scale))),
                           interpolation=cv2.INTER_AREA)

    ok, buf = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, int(cfg["jpeg_q"])])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes(), photo


def run_worker(jpg_bytes, layout, case, seed, bubble_scale, out_dir, layouts_dir):
    request_id = f"acc-{slug(layout.get('examId') or 'x')}-s{seed}-{case}-b{int(bubble_scale * 100)}"
    options = {
        "layoutsDir": str(layouts_dir),
        "debugDir": str(out_dir / "debug"),
        "rotation": 0,
        "debug": False,
        "threshold": 0.38,
        "requestId": request_id,
    }
    proc = subprocess.run(
        [PYTHON, str(WORKER), "--stdin", json.dumps(options)],
        input=jpg_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ROOT),
    )
    stderr_text = proc.stderr.decode("utf-8", errors="ignore")
    if proc.returncode != 0:
        return {"success": False, "error": stderr_text.strip() or "worker exit {}".format(proc.returncode)}
    try:
        result = json.loads(proc.stdout.decode("utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return {"success": False, "error": "invalid worker stdout", "stderr": stderr_text[-2000:]}
    return result


def score_run(result, gt, layout):
    metrics = result.get("questionMetrics") or []
    total = 0
    correct = 0
    wrong = 0
    blank = 0
    multiple = 0
    detail = {}
    for m in metrics:
        flat_no = int(m.get("questionNumber"))
        if flat_no not in gt:
            continue
        total += 1
        expected = gt[flat_no]["answer"]
        answer = m.get("answer") or ""
        if answer == "multiple":
            multiple += 1
            outcome = "multiple"
        elif not answer:
            blank += 1
            outcome = "blank"
        elif answer == expected:
            correct += 1
            outcome = "correct"
        else:
            wrong += 1
            outcome = "wrong"
        detail[str(flat_no)] = {
            "subject": m.get("subject"),
            "expected": expected,
            "detected": answer,
            "state": m.get("state"),
            "confidence": m.get("confidence"),
            "outcome": outcome,
        }
    accuracy = (correct / total) if total else 0.0
    return {
        "total": total,
        "correct": correct,
        "wrong": wrong,
        "blank": blank,
        "multiple": multiple,
        "accuracy": round(accuracy, 4),
        "detectedCount": result.get("detectedCount"),
        "needsReview": result.get("needsReview"),
        "overallConfidence": result.get("overallConfidence"),
        "alignmentSource": result.get("alignmentSource"),
        "rotationCorrected": result.get("rotationCorrected"),
        "barcodeStatus": result.get("barcodeStatus"),
        "entryState": result.get("entryState"),
        "detail": detail,
        "rawSuccess": result.get("success"),
    }


def run_case(reference_by_seed, gt_by_seed, layout, case, case_cfg, seed, bubble_scale, out_dir, layouts_dir):
    rng = random.Random(f"{case}-seed-{seed}")
    ref = reference_by_seed[seed]
    jpg_bytes, photo = apply_photography(ref, case_cfg, rng)
    result = run_worker(jpg_bytes, layout, case, seed, bubble_scale, out_dir, layouts_dir)
    if not result.get("success"):
        return {
            "case": case, "seed": seed, "bubbleScale": bubble_scale,
            "success": False, "error": result.get("error"), "workerError": True,
        }
    score = score_run(result, gt_by_seed[seed], layout)
    return {"case": case, "seed": seed, "bubbleScale": bubble_scale, "success": True, **score}


def aggregate(runs):
    agg = {}
    for case, runs_for_case in runs.items():
        successes = [r for r in runs_for_case if r.get("success")]
        failures = [r for r in runs_for_case if not r.get("success")]
        n = len(runs_for_case)
        accs = [r["accuracy"] for r in successes]
        correct = sum(r["correct"] for r in successes)
        wrong = sum(r["wrong"] for r in successes)
        blank = sum(r["blank"] for r in successes)
        multiple = sum(r["multiple"] for r in successes)
        total = sum(r["total"] for r in successes)
        agg[case] = {
            "runs": n,
            "workerFailures": len(failures),
            "workerErrorMessages": sorted({r.get("error", "") for r in failures}),
            "total": total,
            "correct": correct,
            "wrong": wrong,
            "blank": blank,
            "multiple": multiple,
            "accuracy": round(correct / total, 4) if total else 0.0,
            "avgAccuracy": round(sum(accs) / len(accs), 4) if accs else 0.0,
            "avgOverallConfidence": round(sum(r["overallConfidence"] or 0 for r in successes) / len(successes), 4) if successes else 0.0,
            "needsReviewCount": sum(1 for r in successes if r.get("needsReview")),
            "wrongQuestions": sorted({int(q) for r in successes for q, d in (r.get("detail") or {}).items() if d["outcome"] in ("wrong", "blank", "multiple")}),
        }
    return agg


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout", required=True, help="Layout JSON path")
    parser.add_argument("--layouts-dir", default=str(DEFAULT_LAYOUTS_DIR), help="Directory of layout JSONs")
    parser.add_argument("--out", required=True, help="Output directory for run artifacts")
    parser.add_argument("--report", help="Markdown report path")
    parser.add_argument("--seeds", type=int, default=3, help="Random sheets per case")
    parser.add_argument("--bubble-scales", default="1.0,1.13", help="Comma list of bubble print scales")
    parser.add_argument("--urlencoded-qr", action="store_true", help="Encode QR payload URL-encoded (as the web app does)")
    parser.add_argument("--cases", help="Comma list of case names to run (default: all)")
    args = parser.parse_args()

    layout_path = Path(args.layout)
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    exam_id = str(layout.get("examId") or layout.get("exam_id") or layout_path.stem or "layout")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "debug").mkdir(parents=True, exist_ok=True)

    scales = [float(s) for s in args.bubble_scales.split(",") if s]
    seeds = list(range(1, args.seeds + 1))

    payload_json = make_payload(layout, urlencoded=args.urlencoded_qr)
    gt_by_seed = {seed: build_ground_truth(layout, seed) for seed in seeds}
    references = {seed: render_sheet(layout, gt_by_seed[seed], bubble_scale=1.0, payload_json=payload_json) for seed in seeds}

    meta = {
        "layout": str(layout_path),
        "examId": exam_id,
        "layoutBubbleCount": sum(1 for _ in (layout.get("entryGroup") or {})) + sum(1 for _ in (layout.get("equityGroup") or {})) + sum(len(q.get("choices") or {}) for _, _, q in flat_questions(layout)),
        "seeds": seeds,
        "bubbleScales": scales,
        "urlencodedQr": args.urlencoded_qr,
        "nominal": NOMINAL,
        "caseCount": 0,
    }

    cases = build_cases()
    if args.cases:
        wanted = set(args.cases.split(","))
        cases = [(name, cfg) for name, cfg in cases if name in wanted]
    meta["caseCount"] = len(cases)

    runs = {}
    for name, cfg in cases:
        for scale in scales:
            runs[f"{name}|b{int(scale * 100)}"] = []
            for seed in seeds:
                result = run_case(references, gt_by_seed, layout, name, cfg, seed, scale, out_dir, Path(args.layouts_dir))
                runs[f"{name}|b{int(scale * 100)}"].append(result)
                (out_dir / "run.json").write_text(json.dumps(result, indent=2))
                sys.stderr.write(f"{name} b{int(scale*100)} seed{seed}: acc={result.get('accuracy', 'ERR')}\n")

    agg = aggregate(runs)
    aggregate_payload = {"meta": meta, "cases": agg}
    (out_dir / "aggregate.json").write_text(json.dumps(aggregate_payload, indent=2))

    print(json.dumps(aggregate_payload, indent=2))

    if args.report:
        write_report(Path(args.report), meta, agg)

    overall_total = sum(v["total"] for v in agg.values())
    overall_correct = sum(v["correct"] for v in agg.values())
    overall = (overall_correct / overall_total) if overall_total else 0.0
    print(f"\nOVERALL accuracy across {len(agg)} case-variants: {overall:.4f} ({overall_correct}/{overall_total})")


def write_report(report_path, meta, agg):
    overall_total = sum(v["total"] for v in agg.values())
    overall_correct = sum(v["correct"] for v in agg.values())
    overall = (overall_correct / overall_total) if overall_total else 0.0

    lines = []
    lines.append("# Answer-Sheet OMR Accuracy Rating")
    lines.append("")
    lines.append(f"- Layout: `{meta['layout']}` (examId `{meta['examId']}`)")
    lines.append(f"- Synthetic sheets: {len(meta['seeds'])} per case (seeds {meta['seeds']})")
    lines.append(f"- Bubble print scales: {meta['bubbleScales']}")
    lines.append(f"- QR payload: {'URL-encoded (as web app)' if meta['urlencodedQr'] else 'raw JSON'}")
    lines.append(f"- Cases: {meta['caseCount']}")
    lines.append(f"- **Overall accuracy: {overall:.3f} ({overall_correct}/{overall_total})**")
    lines.append("")

    lines.append("| case | runs | accuracy | correct | wrong | blank | multiple | avg conf | needs review |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for name in sorted(agg):
        v = agg[name]
        lines.append(
            f"| {name} | {v['runs']} | {v['accuracy']:.3f} | {v['correct']} | {v['wrong']} | "
            f"{v['blank']} | {v['multiple']} | {v['avgOverallConfidence']:.2f} | {v['needsReviewCount']} |"
        )
    lines.append("")
    for name in sorted(agg):
        v = agg[name]
        if v["wrongQuestions"]:
            lines.append(f"- `{name}` wrong/blank/multiple questions: {v['wrongQuestions']}")
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append("- All runs use the production `layout_worker.py --stdin` pipeline with default options.")
    lines.append("- Ground truth is generated deterministically per seed from the layout's own question/choice structure.")
    lines.append("- Perspective magnitude `persp=N` is a per-corner displacement in units of 5% of sheet width.")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Report written to {report_path}")


if __name__ == "__main__":
    main()
