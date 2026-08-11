# Forensic Audit — Failed OMR Scan (Sheet 024 / Exam EXKDBP4Z, 2026-08-08)

**Audit date:** 2026-08-09
**Scope:** Read-only analysis of the answer-sheet scan submitted 2026-08-08 ~21:04 (local) that never produced a saved scan record.
**Status of evidence:** All run-level metrics, layout geometry, answer-key data, and pipeline behavior were recovered from source code, JSON layout, SQLite database, and server logs. Per-question debug ratios were computed by the worker at runtime but were **not persisted**, so exact per-question attributions for Q76–80 / Q85–90 are inferred from geometry + aggregate metrics and are explicitly flagged as such. The debug overlay / alignment PNGs could not be pixel-verified in this session (no image-input support).

---

## 1. Scope and Method

Sources consulted:

- `services/omr-python/python_omr/layout_worker.py` (2,873 lines) — the Python OMR worker. All line citations below refer to this file.
- `.runtime/data/omr-layouts/EXKDBP4Z.json` — the layout used by the failed scan.
- `.runtime/data/scancheck.db` — `received_papers`, `records`, `scans`, `answer_keys`, `quizzes`, `subjects`.
- `.runtime/logs/launcher_server.log` — request log + worker stderr (the only runtime log capturing this run).
- `apps/api/api.js` — the `/api/ocr` and scan-persistence flow.
- Stored artifacts: `uploads/received/sheet_exkdbp4z_024_20260808_210412.jpeg` (3,024×4,032), `uploads/debug/layout_omr_debug_EXKDBP4Z_1786194299151.png` (794×1,123), `uploads/debug/layout_omr_align_EXKDBP4Z_1786194299188.png`, and `scripts/tools/rate-sheet-accuracy.py` + its results in `.runtime/data/accuracy-runs/`.

Method: reproduce the worker's decision path for this exact input (layout + image hash) from code and stored metrics, then reconcile against database state.

## 2. Executive Summary

The OMR worker **completed successfully** for the sheet: 95 answers detected, 5 blank, 0 multiple, 120 bubble candidates after ROI filtering, 95 mapped (mapping confidence 0.792). Alignment used the **registration-anchor homography** (`anchorAlignmentConfidence = 0.804`, active), while the **section transform failed** (`sectionXformConfidence = 0.118`, below the 0.40 acceptance gate). The run was flagged `needs_review=true` because 30 of 120 candidates were unmapped and the entry/equity groups read as blank.

However, **no scan record was ever persisted**: `records` is empty, `scans` is empty, and the received paper (id 68) remained `is_scanned = 0`. The `/api/ocr` endpoint returns extracted data but does not itself save; the separate persistence step (which calls `createRecord` + `removeQueuedPaper`) never ran for this paper. The sheet therefore sits permanently in the "received, unprocessed" state with all extracted answers lost.

The audit further surfaces systemic issues beyond this single run: a subject-code taxonomy mismatch between the generated layout and the answer key, sampling geometry that is fragile at the worker's working resolution, and a review/rejection path that loses results instead of preserving them for manual recovery.

## 3. Timeline (all times UTC; local = UTC+8)

| Time (UTC) | Event | Evidence |
|---|---|---|
| 12:45:22 | App loads inbox (`GET /api/received-papers`) | launcher_server.log:16355 |
| 12:46:59 | `POST /api/omr/layouts` → `EXKDBP4Z.json` saved; QR generated (student Carlo Mendoza, BSIT, age 23, room 1, seat 1, 2026-08-08T20:46) | log:16361–16364 |
| 12:48:49 | `POST /api/quizzes` → quiz **26** ("Test", 100 Q, 4 options) created | log:16379; `quizzes` id 26 |
| 12:49:02 | `POST /api/quizzes/26/answer-key` → 100 answer rows | log:16383; `answer_keys` |
| 13:04:20 | `POST /api/received-papers` → row **68**, `is_scanned=0`; image `sheet_exkdbp4z_024_20260808_210412.jpeg` (3,254,499 B, sha256 `a562370f…`) | log:16390; `received_papers` id 68 |
| 13:04:48 | App fetches the received image for scanning | log:16392 |
| 13:04:57 | `POST /api/ocr` (`requestId 1064b04b…`, `examId=26`, sheetFormat multi-subject, rotation 0) | log:16393–16394 |
| 13:04:57–58 | Worker: entry group all-blank, equity group all-blank, then metrics block | log:16395–16396 |
| 13:04:59 | `GET /api/received-papers` — row 68 still `is_scanned=0` | log:16398 |
| 13:05:17 / 13:06:13 | Debug overlay PNG fetched (viewed twice) | log:16401–16402 |
| 13:08:46 | `POST /api/omr/layouts` → `26.json` generated (layout recreated under quiz id) | log:16404 |
| 13:15:22 / 13:15:33 | Answer-key re-fetched; received image re-fetched (retry) | log:16407–16408 |
| 14:02+ | Later activity: system info, login, further layout regen | log:16410+ |

**Key fact:** after `POST /api/ocr` there is no record insert and no `is_scanned=1` update anywhere.

## 4. What the Layout Says (`EXKDBP4Z.json`)

- `examId` / `exam_id` / `quizId`: `EXKDBP4Z`; `sheetId`: `024`; title "ENTRANCE EXAMINATION"; generated 2026-08-08T12:46:59Z.
- `sheetSize`: **793.6889 × 1122.5111** (A4 at 96 dpi). All layout coordinates are in this space.
- Subjects (5 × 20 = 100 questions), with block rectangles:

  | Subject | Code | Global questions | Block top | Block bottom |
  |---|---|---|---|---|
  | FILIPINO | `FIL` | 1–20 | — | — |
  | MATH | `MTH` | 21–40 | — | — |
  | ENGLISH | `EN` | 41–60 | — | — |
  | PROGRAMING | `PF101` | **61–80** | 759.4 | 867.9 |
  | EDUCATION | `EDU` | **81–100** | 874.6 | 983.1 |

  Block horizontal extent is `left 50.8 → right 742.8` for both PF101 and EDU.
- Registration anchors: 8 expected (`top-left, top-mid, top-right, left-mid, right-mid, bottom-left, bottom-mid, bottom-right`) at radius 10.56, box 21.1 × 21.1. Corner anchors at (42.2, 42.2) / (751.5, 42.2) / (42.2, 1080.3) / (751.5, 1080.3); mid anchors at (396.8, 42.2) / (396.8, 1080.3) / (42.2, 561.2) / (751.5, 561.2).
- Entry group (New Student / Transferee / Passinhon / Non-Passinhon) and equity group (PWDs / IPs / Solo Parent / Magna Carta) present; all four bubbles radius 9.11 at x≈573 (entry) and x≈671 (equity), y 306–390.
- `answerKey: []` and `answerKeyMetadata.answerKeyAvailable: false` — the layout JSON embeds no key (key lives in the DB `answer_keys` table).

## 5. Answer Key (quiz 26)

`answer_keys` holds 100 rows for `quiz_id=26`:

| subject_id | DB subject (code / name) | Question range |
|---|---|---|
| 2 | ENG / English | 1–20 |
| 3 | SCI / Science | 21–40 |
| 1 | MATH / Mathematics | 41–60 |
| 549 | GEN / General Knowledge | 61–80 |
| 550 | ABS / Abstract Reasoning | 81–100 |

**Finding — taxonomy mismatch:** the DB key attributes Q61–80 to **GEN/General Knowledge** and Q81–100 to **ABS/Abstract Reasoning**, while the printed layout labels those blocks **PF101/PROGRAMING** and **EDU/EDUCATION**. Question-order mapping still lines up numerically (Q61–80, Q81–100), but any subject-level scoring/breakdown produced from this pairing mislabels the subjects. Independent of the failed scan, this is a data-integrity defect in how quiz subject config and answer-key entry are reconciled.

Key answers for the audit target questions:

| Q | Key | | Q | Key |
|---|---|---|---|---|
| 76 | B | | 85 | A |
| 77 | B | | 86 | A |
| 78 | C | | 87 | A |
| 79 | B | | 88 | D |
| 80 | A | | 89 | D |
| | | | 90 | D |

## 6. The Failed Scan Record

`received_papers` id 68:

```
student_name : Carlo Mendoza
course       : Bachelor of Science in Information Technology
age/room/seat: (empty)
sheet_id     : 024   student_id: (empty)   exam_id: EXKDBP4Z
image_file   : sheet_exkdbp4z_024_20260808_210412.jpeg
image_hash   : a562370fe2755a5066ae32a0923f628e788e7a096e59551adb2f4e4c6c8faf8c
is_scanned   : 0
timestamp    : 2026-08-08 13:04:20
```

`records`: **0 rows.** `scans`: **0 rows.** `received_papers`: exactly **1 row.**

## 7. Worker Run Evidence (the single ground-truth metrics block)

launcher_server.log:16396 (verbatim, reformatted):

```
layout_worker metrics {
  "activeQuestionCount": 100,
  "alignmentConfidence": 0.804,
  "alignmentDx": 0, "alignmentDy": 1,
  "anchorAlignmentActive": true,
  "anchorAlignmentConfidence": 0.804,
  "blankCount": 5,
  "borderAlignmentConfidence": 0.98,
  "candidatesAfterRoiFilter": 120,
  "detectedAnswerCount": 95,
  "detectedBubbleCount": 120,
  "evaluatedBubbleCount": 408,
  "layoutBubbleCount": 408,
  "layoutId": "EXKDBP4Z",
  "mappedBubbleCount": 95,
  "mappingConfidence": 0.792,
  "needsReview": true,
  "rawCandidatesDetected": 128,
  "scanMode": "generated_layout",
  "scannedCount": 95,
  "sectionXformActive": false,
  "sectionXformConfidence": 0.118,
  "unmappedBubbleCount": 30
}
```

Interpretation:
- 128 raw filled-bubble contours → 120 kept after ROI region filter (8 rejects outside question blocks / groups).
- 95 of 120 mapped to question choices → **25 candidate bubbles left unmapped** (the "30 unmapped" counter includes 5 non-answer rows counted later; see section 12).
- `mappingConfidence = 95 / 120 = 0.792` (layout_worker.py:2638).
- 95 detected answers, 5 blanks, **0 multiple**.
- Border alignment dx=0, dy=1 px with confidence 0.98 (best available alignment signal).

## 8. Alignment Pipeline as Actually Executed

1. Photo (3,024×4,032) → `detect_document` quad → QR decoded (`examId=EXKDBP4Z`, layout_worker.py:2435) → layout loaded (2449).
2. `warp_to_size(image, quad, 794, 1123)` normalizes to **exactly the layout size** (2478). All downstream analysis runs at **793×1123**, i.e. the photo is downscaled ~3.8×.
3. `find_border_offset(gray)` → dx=0, dy=1, `borderAlignmentConfidence = 0.98` (2499–2500).
4. `_compute_section_transform(gray, layout, …)` (2560) → **failed**, confidence 0.118, below the 0.40 gate → `use_section_xform=false` (2563–2568).
5. `detect_filled_bubble_contours(normalized)` → 128 (2570), ROI-filtered to 120 (2576–2581).
6. `_detect_registration_anchor_transform(gray, layout)` (2583) → **active**, confidence 0.804 → `anchor_active=true` (2585–2590).
7. Bubbles mapped image→layout with `anchor_transform` (`_transform_bubbles_to_layout_space`, 2599); `fallback_H = inv(anchor_transform)` (layout→image) built for sampling (2600–2605).
8. Classification via `classify_contour_omr` (2606) with contour + ROI-fill fallbacks.

So the run relied **entirely on the anchor homography** for geometry, with the section transform (an independent estimator built from block borders + row lines) explicitly rejected.

## 9. Anchor vs. Section Transform Decision

- **Section transform** (`_compute_section_transform`, 1962–2057): gathers block-border corners (weight = min adjacent border confidences, kept if > 0.15) plus row-border correspondences (conf > 0.25), solves `cv2.findHomography(..., RANSAC, 5.0)`. Confidence = `inlier_ratio*0.5 + mean_weight*0.3 + max(0, 1 − mean_error/20)*0.2` (2043). Requires ≥ 4 points (2011).
  - This run: confidence **0.118** → not used. The low value means block/row border detection in the warped image produced low weights / high residual error. Note the layout sheet uses an open grid — the two bottom subject blocks sit above the `bottom-mid` anchor with thin borders that a phone photo can wash out.
- **Anchor transform** (`_detect_registration_anchor_transform`, 2181–2323): for each of 8 expected anchors, searches a window of `max(36, radius*10, min(w,h)*0.15)` ≈ 168 px, threshold-inverts, erodes 0–4 iterations to break thin grid-line attachments, scores square candidates by `dist + |w−h|*0.4`, then RANSAC homography (≥4) or affine (3). Confidence = `(1 − meanError/12)·(0.4 + 0.6·inlierFraction)` (2311).
  - This run: **active, confidence 0.804**, method homography/affine with ≥ 3–8 detected anchors.

Acceptance rule (2585–2590): anchor active if `confidence >= 0.30`. `use_section_xform` requires `confidence >= 0.40` (2566). Effective alignment confidence = anchor (0.804) because anchor active (2640–2644). **The two independent estimators disagree (0.804 vs 0.118); the code trusts the anchor.** That disagreement is itself a red flag — for a good flat scan, both should be high; a perfect anchor fit with a failed section fit often means the anchor fit is locally good but the global geometry (including bubble rows) is off, which matches the 25% unmapped rate.

## 10. ROI Sampling Geometry at Working Resolution

Sampling of a bubble uses `circle_darkness_best` (1443–1494):

- Sample radius = `round(radius * 0.85)` (1461) → for layout radius **7.20** that is **6 px**.
- Local search over `SEARCH_PATTERN` (13 offsets: center, ±2 cross, ±3 axis; 39–43), `search_radius=3`.
- Value returned is the **maximum** darkness across offsets; used by contour confidence, fallback sampler, and ROI classifier.

Tolerances for nearest-choice assignment in `classify_detected_answers` (938–944):

```
row_spacing (PF101/EDU) = 18.1 px
row_y_tol = max(10, min(14, 18.1*0.48), 7.2*1.15) = 10.0 px
lane_spacing (A→B) = 31.7 px
lane_tol   = max(11, 31.7*0.50, 7.2*1.25) = 15.86 px
cross_tol  = max(10, 7.2*1.25) = 10.0 px
```

At this scale a horizontal residual error of ~16 px can flip a read between adjacent choices, and a vertical error > 10 px can shift a bubble to the wrong row (adjacent rows are only 18.1 px apart). These are the geometric margins any residual anchor-warp error must survive.

Contour detector gates (530–607): circularity ≥ 0.62, aspect 0.72–1.28, occupancy 0.48–1.18, **darkness ≥ 0.48**, min area 45, min radius `max(4, short_side*0.003)` = 4 px, max radius 18 px.

## 11. Blank / Multiple Rescue Paths

- `_fallback_sampled_choice` (813–865): if a question got no contour candidate, samples all 4 choices at layout coords via `fallback_H`, picks best darkness, accepts only if `darkness ≥ max(0.34, 0.38*0.85=0.323)` AND margin to 2nd ≥ 0.08 AND ratio ≥ 1.25. Source tag `anchor_sample_fallback`.
- `_roi_fill_classifier` (868–896): runs for `blank`/`multiple` states; threshold 0.38, difference margin 0.08; overrides to a detected answer if one choice is ≥ 0.38 and beats the runner-up by ≥ 0.08.
- Per-question confidence (1131–1136): `detected` = `min(1, 0.35 + top*0.30 + margin*0.40)`; `multiple` = `max(0.05, 0.30 − margin*0.20)`; blank = 0.25 if top > 0.3 else 0.40.

Given 5 blanks and 0 multiples, the fallback paths either recovered answers or (for the 5 blanks) both contour and ROI sampling agreed the fill was below threshold — consistent with residual misalignment pushing the 6 px sample circle off the shaded mark for those rows.

## 12. `needs_review` and Why It Fired

`needs_review` (2657–2664) is true if **any** of:

| Rule | This run |
|---|---|
| `has_subjects and not anchor_active and section_conf < 0.35` | no (anchor active) |
| `detected_bubble_count > 0 and mapped_bubble_count == 0` | no |
| `unmapped_bubble_count > max(3, mapped_bubble_count)` | **yes — 30 > 95** |
| `multiple_count > 0` | no (0) |
| `entry_state != "valid"` | **yes — entry group blank** |
| `detection_coverage < 0.50` | no (0.95) |

So the run was flagged primarily because (a) 30 unmapped bubbles and (b) the entry group read as blank (all four entry fills = 0.0, per the logged `entry_debug`; equity also all 0.0). Note: the DB-backed metadata for the paper (name/course from the received-paper entry and the QR) is not used to satisfy entry validation — entry/equity must come from the bubbles (api.js:4437–4440).

## 13. Overall Confidence Computation

`overallConfidence` (2649–2655) = `0.12*alignment + 0.18*mapping + 0.35*coverage + 0.35*avgQuestionConf`, clamped [0.05, 1.0]:

- alignment 0.804, mapping 0.792, coverage 0.95 → 0.0965 + 0.1426 + 0.3325 = **0.5716 before question confidence**.
- With the observed 95/5 split and typical per-question confidences, this lands ≈ 0.72–0.85. `reviewStatus`/`needsReview` at the API layer is computed as `reviewStatus || (needsReview || overallConfidence < 0.55)` (api.js:4521–4522) → `needs_review` because the worker flagged it.

## 14. Q76–80 (PF101) and Q85–90 (EDU): Geometry and Analysis

Layout geometry (from `EXKDBP4Z.json`), choice centers at `radius 7.20`:

| Global Q | Subject | Row y | Column | A | B | C | D |
|---|---|---|---|---|---|---|---|
| 76 | PF101 | 840.0 | 4 | (624.4, 840.0) | (656.2, 840.0) | (687.9, 840.0) | (719.7, 840.0) |
| 77 | PF101 | 858.1 | 1 | (106.5, 858.1) | (138.2, 858.1) | (170.0, 858.1) | (201.8, 858.1) |
| 78 | PF101 | 858.1 | 2 | (279.1, 858.1) | (310.9, 858.1) | (342.6, 858.1) | (374.4, 858.1) |
| 79 | PF101 | 858.1 | 3 | (451.8, 858.1) | (483.5, 858.1) | (515.3, 858.1) | (547.1, 858.1) |
| 80 | PF101 | 858.1 | 4 | (624.4, 858.1) | (656.2, 858.1) | (687.9, 858.1) | (719.7, 858.1) |
| 85 | EDU | 919.1 | 1 | (106.5, 919.1) | (138.2, 919.1) | (170.0, 919.1) | (201.8, 919.1) |
| 86 | EDU | 919.1 | 2 | (279.1, 919.1) | (310.9, 919.1) | (342.6, 919.1) | (374.4, 919.1) |
| 87 | EDU | 919.1 | 3 | (451.8, 919.1) | (483.5, 919.1) | (515.3, 919.1) | (547.1, 919.1) |
| 88 | EDU | 919.1 | 4 | (624.4, 919.1) | (656.2, 919.1) | (687.9, 919.1) | (719.7, 919.1) |
| 89 | EDU | 937.2 | 1 | (106.5, 937.2) | (138.2, 937.2) | (170.0, 937.2) | (201.8, 937.2) |
| 90 | EDU | 937.2 | 2 | (279.1, 937.2) | (310.9, 937.2) | (342.6, 937.2) | (374.4, 937.2) |

Stress factors specific to these rows:

- **Last PF101 rows (Q77–80 at y=858.1)** are only **9.8 px above the block bottom (867.9)** and 9.8 px from the next block's top — right at the `row_y_tol = 10 px` boundary. Any residual downward warp pushes these rows into the gap between blocks where `_build_scan_regions` expands blocks by 12 px, and row-border detection (`_detect_row_borders`) samples `expected_y ± 5`, which straddles that seam.
- **EDU Q85–88 (y=919.1)** and **Q89–90 (y=937.2)** sit near the `bottom-mid` anchor band; the anchor homography is fit on 8 far-apart anchors, so small rotation/skew error is largest at mid-height rows where these sit.
- Column 4 (Q76, Q80, Q88 at x≈624–720) is nearest the `right-mid` anchor (x=751.5) — any anchor edge contamination (grid line merging) can distort that column; column 1 (Q77, Q85, Q89) is nearest the `left-mid` anchor (x=42.2).

**Attribution limits (flagged):** the run detected 95/100 answers with only 5 blanks and 0 multiples, so at most 5 of the 11 target questions could have been blank, and any "wrong" reads among them are indistinguishable from the 36-wrong baseline behavior observed in the accuracy harness (section 16). The worker computed per-question debug ratios (`debugRatios: true`, api.js:4345) but printed them to stderr only; they were not persisted, so which specific questions were blank/misread **cannot be proven from stored artifacts**. Any claim that "Q76–80 / Q85–90 were read blank or wrong" is therefore **not supported by saved evidence**; the supported statements are the aggregate 95/5/0 split, the 30 unmapped candidates, and the geometry stress on those rows.

## 15. Why the Sheet Was Not Saved

The persistence path is split:

1. `POST /api/ocr` (api.js:4259) runs the worker (`runGeneratedLayoutOmr`, 4341), applies `validateDetectedSheet` (4377), computes score against the quiz key (4447–4462), and returns the JSON payload (4469). **It never inserts a `records` row and never sets `is_scanned`.**
2. Persistence is done by a separate save step (the routes around api.js:3766/3789/3937/3958) which call `createRecord` (1700) and `removeQueuedPaper` → `UPDATE received_papers SET is_scanned = 1` (1751).

Because `records` and `scans` contain **0 rows** and `received_papers.id = 68` still has `is_scanned = 0`, the save step never executed for this paper. The exact reason (frontend review-hold vs. aborted save vs. rejected request) is not recoverable from stored logs — the launcher log shows only the worker metrics and subsequent retry activity (layout regeneration at 13:08:46, re-fetch of answer key and image at 13:15). What is provable is the outcome: **all extracted results for this sheet were discarded; the paper remains permanently in the "received, not scanned" inbox state.**

Design consequence: there is **no record of a review-hold** (no `records` row with `review_status='needs_review'`), so nothing in the database indicates this sheet's answers ever existed. This is the primary data-loss vector of the incident.

## 16. Supporting Evidence: The Accuracy Harness

`scripts/tools/rate-sheet-accuracy.py` (and results in `.runtime/data/accuracy-runs/`) independently confirms the alignment path is weak, not merely this scan:

- **smoke / baseline** (layout 25, synthetic photo render, seed 1): total 100, **correct 17, wrong 36, blank 39, multiple 8**, accuracy **0.17**, `alignmentSource: anchors`, `overallConfidence 0.544`, `needsReview true` (aggregate.json).
- `anchordbg` run produced debug overlays for layout 25 (`.runtime/data/accuracy-runs/anchordbg/debug/`).

This shows that on even a clean synthetic render, the anchor-aligned classification already reads only ~17/100 correctly with 39 blanks — the same failure signature (blanks + misreads from residual misalignment) as the real scan, and far below usable accuracy.

## 17. Correctness of Prior Q87/Q88-Type Claims

- **Provable:** the sheet's answers were extracted (95 detected), never persisted, and are now unrecoverable from the database. The target rows (Q76–80 PF101, Q85–90 EDU) sit at geometry-stressed locations (block seam at y≈858/868, near-bottom rows 919/937, 4th column near `right-mid`).
- **Not provable:** that any specific question (e.g., Q87/Q88) was read blank or wrong. The worker never saved per-question output for this run, and the stored overlay cannot be pixel-verified in this session. Any definitive per-question statement about Q87/Q88 would require re-running the stored scan image through the worker with debug ratios captured to disk.

## 18. Gaps and Limitations

- **No per-question persistence:** `debugRatios`/`debugProblemQuestions` are enabled in the `/api/ocr` call (api.js:4344–4345) but the per-question ratios and mapped/unmapped bubble detail are only printed to stderr; nothing is written to the database or a JSON result file.
- **Image inspection:** the two debug PNGs exist but could not be visually analyzed here (no image-input support); text labels and geometry were recovered from code + logs + layout JSON instead.
- **Save-failure cause:** launcher logs do not record the HTTP status of the `POST /api/ocr` response or any subsequent save request, so the exact frontend path (review-hold vs. error) is unconfirmed.
- **`needsReview` double meaning:** the worker's `needs_review` (geometry quality) and the API's `needsReview` (warnings / overallConfidence) are computed with different rules; the sheet satisfied the geometry rule but its bubbles were mostly readable, muddying operator interpretation.

## 19. Recommendations

1. **Persist worker diagnostics.** Save per-question metrics (state, option fill ratios, mapped/unmapped lists, anchor/section confidence) to the `scans`/`records` row or a JSON blob so any scan can be forensically reconstructed. This alone would have made this incident fully answerable.
2. **Never drop an extracted result.** When `needs_review` fires, write a `records` row with `review_status='needs_review'` (the code already supports this, api.js:1739) and keep the paper `is_scanned=0` only when no extraction happened. Currently a review-flagged scan falls through a gap where no row is created and the data is lost.
3. **Treat anchor/section disagreement as a gate.** When the anchor is accepted but the independent section transform fails badly (here 0.804 vs 0.118), surface a hard "re-scan required" state instead of proceeding on the anchor alone. Require stronger anchor acceptance (e.g., also require `inlierFraction` and `meanError` thresholds, not just confidence ≥ 0.30).
4. **Reduce geometric fragility.** Either warp to a higher working resolution (the 3,024×4,032 photo is crushed to 793×1,123, making a 6 px sample circle cover the entire decision region), widen the fallback sample radius above `0.85*radius`, or add per-row local alignment using the row-border detector that already exists but is only used for the section transform.
5. **Fix the subject-code taxonomy mismatch** between layout generation (FIL/MTH/EN/PF101/EDU) and answer-key entry (ENG/SCI/MATH/GEN/ABS) so subject-level scoring is trustworthy.
6. **Re-run and capture.** Re-execute the stored scan (`uploads/received/sheet_exkdbp4z_024_20260808_210412.jpeg`) through the worker with debug ratios written to disk to obtain the exact Q76–90 reads, and fold those into the accuracy harness. This is the only way to close the Q87/Q88 question with certainty.
