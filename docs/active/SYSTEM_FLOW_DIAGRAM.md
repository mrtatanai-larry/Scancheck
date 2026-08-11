# ScanCheck System - AI Vision Flow Diagram

This document describes the current scan flow. The system reads bubbled answer sheets with an AI vision-language model (Gemini, optional Ollama), not the retired deterministic pixel-threshold OMR scanner.

For the complete authoritative description of the current state, see `docs/active/SYSTEM_CURRENT_STATE_DETAILED.md`.

> **Retired paths** — `POST /api/scans/process` and `POST /api/omr/debug-bubbles` return HTTP `410`. Older docs that describe them as the active product path are out of date.

---

## Main System Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SCANCHECK SYSTEM                             │
│                      AI Vision Scan Flow                             │
└─────────────────────────────────────────────────────────────────────┘

                  Generated answer sheet (dashboard)
                  - prints QR + registration anchors + bubble grid
                  - layout JSON saved via POST /api/omr/layouts
                                │
                                │ photo / scan of printed sheet
                                ↓
            ┌───────────────────────────────────────┐
            │   POST /api/ai-omr/scan (authenticated)│
            │   (also POST /api/ocr extraction path) │
            └───────────────────────────────────────┘
                                │
                                │ 1. Read image (base64 data URL or stored path)
                                ↓
                    ┌──────────────────────────┐
                    │  Identify layout          │
                    │  - supplied layoutId/examId│
                    │  - QR decode (jsQR)        │
                    │  - latest compatible layout│
                    └──────────────────────────┘
                                │
                                │ 2. Load generated layout JSON
                                │    (.runtime/data/omr-layouts)
                                ↓
                    ┌──────────────────────────┐
                    │  Prepare page (optional)  │
                    │  - pagePrepWorker.py       │
                    │    (OpenCV perspective     │
                    │     correction, graceful    │
                    │     fallback to original)   │
                    └──────────────────────────┘
                                │
                                │ 3. Crop sections via layout coords
                                │    sectionCropper.js (Jimp)
                                ↓
                    ┌──────────────────────────┐
                    │  Top-field crop            │
                    │  (student fields)          │
                    └──────────────────────────┘
                                │
                                │ 4. AI reads each crop
                                │    provider.generateOmrResult()
                                │    (Gemini / Ollama vision)
                                ↓
                    ┌──────────────────────────┐
                    │  Validate structured result│
                    │  (omrResultSchema:          │
                    │   selected / blank /         │
                    │   multiple / uncertain)      │
                    └──────────────────────────┘
                                │
                                │ 5. Confidence handling
                                │    - retry section if many unreadable
                                │    - verify low-confidence marks
                                │      (verification.js)
                                ↓
                    ┌──────────────────────────┐
                    │  Answers vector + records  │
                    │  state counts + review set │
                    └──────────────────────────┘
                                │
                                │ 6. Score (optional quizId)
                                │    against answer_keys
                                ↓
                    ┌──────────────────────────┐
                    │  Persist run + usage       │
                    │  - ai-omr/results JSON     │
                    │  - ai_omr_usage rows       │
                    └──────────────────────────┘
                                │
                                │ 7. Response
                                │    answers, questions, review,
                                │    topFields, metrics, scoring
                                ↓
                        [Dashboard / Client]
```

---

## Detailed Component Breakdown

### 1. Layout identification

- A QR code on the generated sheet encodes the layout identity (`examId`, `layoutId`, `quizId`).
- `qrDecode.js` attempts several full-image and cropped/enhanced candidates with `jsQR` and returns the layout id from the decoded payload.
- If no QR is readable, the caller can supply `layoutId`/`examId`, or the server falls back to the latest compatible generated layout for a selected quiz.
- No layout id → `AI_OMR_LAYOUT_IDENTIFICATION_FAILED` (422). No layout file → `AI_OMR_LAYOUT_NOT_FOUND` (404).

### 2. Page preparation

- `imagePreparation.js` calls `pagePrepWorker.py` (Python/OpenCV) to warp the photographed page to the sheet's expected dimensions using registration anchors.
- The worker is optional: any failure falls back to the original image (`usedWorker: false`, mode recorded in `metrics.pagePreparation`).

### 3. Cropping strategy

`sectionCropper.js` builds crops from the layout coordinates:

| Strategy | Behavior |
| --- | --- |
| `whole_sheet` | One crop of the full page |
| `section_10` | 10-question crops (higher accuracy) |
| `section_20` | 20-question crops (faster; default) |
| `auto` | Normalizes toward section-based scanning |
| `fast` | Larger sections (section_20) |
| `high_accuracy` | Smaller sections (section_10) |
| `custom` | Uses the requested strategy/settings |

The top-field region is cropped separately and read for student metadata fields.

### 4. AI reading

- Each crop is sent to the provider (`GeminiProvider` via `@google/genai`, or `OllamaProvider`).
- The prompt instructs the model to report each question's state (`selected`, `blank`, `multiple`, `uncertain`), selected options, and confidence.
- `runSectionWithValidation` retries once when the structured result fails schema validation; unrecoverable response errors mark those questions for review.

### 5. Confidence handling

- Sections with many unreadable records are retried with a wider crop; the better result wins (`preferSectionRecords`).
- When verification is enabled (`uncertain`/`always`), `verification.js` re-crops and re-reads low-confidence or uncertain questions and merges results (`ai_pass_disagreement` review flags where applicable).

### 6. Scoring

- If a `quizId` is supplied, detected answers are compared against `answer_keys`.
- Produces total score, percentage, and per-subject results for multi-subject sheets.

### 7. Output

The result includes:

- `answers` — answer vector per question
- `questions` — per-question records (state, options, confidence, review flags)
- `needsReview` — question numbers needing human review
- `topFields` — student field reads
- `metrics` — crop count, API calls, latency, token usage, page-preparation mode, verification metrics, per-section details
- `scoringStatus` / `subjectResults` — when scored

Result JSON is also persisted under `.runtime/data/ai-omr/results/` and usage is recorded in the `ai_omr_usage` table.

---

## Retired Deterministic OMR Path (historical)

The old flow (grayscale → threshold → detect document → resize to 800x1000 → pixel fill-ratio bubble detection in Python `layout_worker.py`) is **retired**:

- `POST /api/scans/process` → `410 LEGACY_OMR_RETIRED`
- `POST /api/omr/debug-bubbles` → `410 LEGACY_OMR_DEBUG_RETIRED`
- `POST /api/ocr` requires the AI scanner; without it, it returns `503 AI_OMR_REQUIRED`.

The Python workers in `services/omr-python/python_omr/` remain on disk for reference only. The only Python helper still invoked by the active path is `pagePrepWorker.py` (optional page prep).

---

## Quick Reference

- Entry: `apps/api/services/ai-omr/aiOmrService.js` → `runAiOmrScan()`
- Provider: `providers/geminiProvider.js` (default) or `providers/ollamaProvider.js`
- Layouts: `.runtime/data/omr-layouts/*.json`
- Settings: `.runtime/data/ai-omr/settings.json` (admin UI) or `AI_OMR_*` env vars
- Dashboard: `apps/web/index4.html` → Scan workspace, Systems → AI OMR settings
- Current-state reference: `docs/active/SYSTEM_CURRENT_STATE_DETAILED.md`
