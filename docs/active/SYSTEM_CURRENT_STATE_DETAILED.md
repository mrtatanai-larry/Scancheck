# ScanCheck System Current State - Detailed

Generated: 2026-08-12, Asia/Manila

This document describes what is currently going on in the ScanCheck system based on the repository source, runtime files, active SQLite database, and local server checks.

## Executive Summary

ScanCheck is currently a local/LAN OMR examination system made of three active parts:

1. A Node.js Express API in `apps/api`.
2. A static single-page web dashboard in `apps/web`, served by the API.
3. Python OMR/OCR workers in `services/omr-python`.

The server is currently running on port `3000` and the health endpoint responds successfully. Runtime state is stored under `.runtime/`, especially `.runtime/data/scancheck.db`, `.runtime/data/uploads`, `.runtime/data/omr-layouts`, and `.runtime/logs`.

The system has moved away from the older deterministic product scan endpoint. The route `POST /api/scans/process` now immediately returns `410 LEGACY_OMR_RETIRED`. The current scanner path is the AI Vision OMR flow through `POST /api/ai-omr/scan`, with generated answer-sheet layout files used to map questions and identify sheets.

## Current Runtime Status

Observed local runtime state:

- Server port file: `.runtime/current_port.txt` contains `3000`.
- Listening server: a Node process is listening on `0.0.0.0:3000`.
- Health check: `GET http://localhost:3000/api/health` returns `{"status":"OK", ...}`.
- Runtime database: `.runtime/data/scancheck.db`.
- Runtime data size: `.runtime/data` is about `1.1G`.
- Runtime logs size: `.runtime/logs` is about `1.3M`.
- Legacy database at `apps/api/scancheck.db` is present but size `0`; active paths point to `.runtime/data/scancheck.db`.

Current database counts:

| Table | Rows |
| --- | ---: |
| `subjects` | 7 |
| `quizzes` | 2 |
| `answer_keys` | 100 |
| `scans` | 0 |
| `records` | 0 |
| `subject_records` | 0 |
| `received_papers` | 1 |
| `users` | 1 |
| `ai_omr_usage` | 9 |
| `ai_layout_profiles` | 0 |

Recent quizzes:

| ID | Title | Questions | Format | Archived | Created |
| ---: | --- | ---: | --- | ---: | --- |
| 28 | `test2` | 100 | `normal` | 0 | 2026-08-11 10:56:25 |
| 27 | `Test` | 100 | `multi-subject` | 0 | 2026-08-11 04:10:20 |

Generated OMR layout files:

- `.runtime/data/omr-layouts` currently contains `117` JSON layout files.
- Layout filenames include both numeric IDs and generated exam IDs such as `EX...`.
- These layout files are central to the current scan path because they define where each bubble and top-field region exists on a generated sheet.

Upload/runtime artifacts currently exist under:

- `.runtime/data/uploads/images`
- `.runtime/data/uploads/thumbnails`
- `.runtime/data/uploads/received`
- `.runtime/data/uploads/debug`

The debug upload directory contains many layout alignment/debug artifacts, which indicates active scanner calibration and troubleshooting work has been happening recently.

## Repository Layout

Important directories:

| Path | Purpose |
| --- | --- |
| `apps/api` | Express server, API routes, SQLite database layer, AI OMR services. |
| `apps/web` | Browser dashboard, answer sheet generation, scan workspace, reports, records UI. |
| `services/omr-python` | Python workers for generated-layout OMR, bubble detection, forensic debug, calibration utilities. |
| `scripts/launcher` | Linux/Windows start, stop, status, and desktop launcher scripts. |
| `scripts/tools` | Utility scripts for generated shaded answer sheets and accuracy rating. |
| `docs/active` | Current active documentation. |
| `docs/archive` | Older docs and historical implementation notes. |
| `.runtime` | Active runtime database, uploads, logs, generated layouts, cached tools, calibration files. |
| `.runtime-backups` | Database/system backup archive location. |

There are also Android-related paths under `android/`, but the current Git status shows many Android files as deleted. Based on the active repository files and current server behavior, the web/API/Python stack is the active system.

## Server Startup

The active server entry point is `apps/api/server.js`.

Startup behavior:

1. Loads Express, CORS, body parser, database module, API router, and runtime path config.
2. Ensures runtime directories exist.
3. Configures CORS to allow localhost, loopback, LAN IP addresses, and private network ranges.
4. Skips JSON body parsing for backup upload/restore binary routes.
5. Enables large request limits for normal JSON/urlencoded routes.
6. Serves vendor assets from `apps/api/node_modules`.
7. Serves the web dashboard from `apps/web`.
8. Serves `/uploads` from runtime upload storage.
9. Mounts API routes under `/api`.
10. Serves `apps/web/index4.html` at `/`.
11. Initializes the SQLite database.
12. Listens on `SCANCHECK_PORT` or `3000`.
13. Writes the active port to `.runtime/current_port.txt`.
14. Disables server timeouts for very large transfers.
15. Handles graceful shutdown on `SIGTERM` and `SIGINT`.

The server logs print that AI Vision Scanner Mode is enabled and the legacy deterministic OMR product path is disabled.

## Configuration

Runtime configuration is documented in `.env.example`.

Important environment variables:

| Variable | Meaning |
| --- | --- |
| `SCANCHECK_HOST` | Intended host binding. Current server code binds to `0.0.0.0`. |
| `SCANCHECK_PORT` | Server port; default is `3000`. |
| `SCANCHECK_BOOTSTRAP_ADMIN` | Controls whether the first admin user is auto-created. |
| `SCANCHECK_DEFAULT_ADMIN_USERNAME` | Default bootstrap username. |
| `SCANCHECK_DEFAULT_ADMIN_PASSWORD` | Default bootstrap password. |
| `SCANCHECK_RUNTIME_ROOT` | Runtime root; default `.runtime`. |
| `SCANCHECK_DATA_DIR` | Runtime data directory; default `.runtime/data`. |
| `SCANCHECK_LOG_DIR` | Runtime logs directory; default `.runtime/logs`. |
| `SCANCHECK_TMP_DIR` | Runtime temp directory; default `.runtime/tmp`. |
| `SCANCHECK_DB_PATH` | Optional explicit SQLite database path. |
| `SCANCHECK_JWT_SECRET_FILE` | Optional explicit JWT secret file path. |
| `SCANCHECK_PYTHON` | Optional Python interpreter path for OMR workers. |
| `AI_OMR_ENABLED` | Enables/disables AI OMR service. |
| `AI_OMR_PROVIDER` | AI provider, currently supporting `gemini` and `ollama` in code. |
| `AI_OMR_MODEL` | AI model name used by the provider. |
| `GEMINI_API_KEY` | Backend-only key for Gemini provider. Must not be exposed in frontend code. |
| `AI_OMR_TIMEOUT_MS` | AI scanner timeout. |
| `AI_OMR_MAX_RETRIES` | Retry count for AI scanner sections. |
| `AI_OMR_SECTION_SIZE` | Section size for AI scanning. |
| `AI_OMR_STRATEGY` | Scan strategy profile. |
| `AI_OMR_IMAGE_DETAIL` | Image preparation quality/detail profile. |
| `AI_OMR_VERIFICATION_MODE` | Controls verification behavior for uncertain reads. |

Runtime path resolution is centralized in `apps/api/config/paths.js`. Relative paths are resolved from the repository root.

## Database

The database module is `apps/api/database.js`.

Active database behavior:

- Uses SQLite through `sqlite3`.
- Database path defaults to `.runtime/data/scancheck.db`.
- Ensures the database directory exists and is writable.
- Enables `WAL` mode.
- Sets `busy_timeout = 5000`.
- Enables foreign keys.
- Asserts the DB is writable during initialization.
- Creates tables if missing.
- Runs additive migrations with `ALTER TABLE` checks.
- Seeds default subjects.
- Bootstraps a default admin if enabled and no users exist.

Main tables:

| Table | Purpose |
| --- | --- |
| `subjects` | Subject catalog. Seeded with English, Science, Mathematics, General Knowledge, and Abstract Reasoning. Current DB has 7 rows, so extra subjects exist beyond the default seed. |
| `quizzes` | Exam definitions, question count, format, subject config, answer key linkage, archive flag. |
| `answer_keys` | Correct answers by quiz/question, with unique `(quiz_id, question_number)`. |
| `scans` | Completed scan results, scores, answers, subject score columns, image paths, metadata, pass/fail status. |
| `scan_images` | Additional image metadata linked to scans. |
| `subject_records` | Per-subject result records for reporting. |
| `records` | Student-facing record ledger. |
| `systems` | Generic system/settings entries. |
| `users` | Local login accounts with bcrypt-hashed passwords. |
| `received_papers` | Inbox queue for uploaded/captured papers awaiting processing. |
| `ai_omr_usage` | AI scan usage metrics, request counts, tokens, timing, success/error data. |
| `ai_layout_profiles` | Per-layout AI tuning/profile settings. Currently empty. |

## Authentication

Authentication is implemented in `apps/api/api.js`.

Current behavior:

- Login endpoint: `POST /api/auth/login`.
- Registration endpoint: `POST /api/register`.
- Passwords are hashed with `bcrypt`.
- Authenticated routes use JWT bearer tokens.
- JWT secret is loaded from `.runtime/data/.jwt_secret` by default.
- If the secret file does not exist, the server generates/persists one.
- Many dashboard and administration routes require `authenticateToken`.
- Some mobile/inbox scanning routes remain unauthenticated for device uploads.

## Web Dashboard

The dashboard entry file is `apps/web/index4.html`.

The frontend is a static, Bootstrap-based single-page app with custom JavaScript and CSS. It is served by the Node API server.

Major UI areas:

| Route / Page | Purpose |
| --- | --- |
| `#/dashboard` | Overview stats, score distribution, daily activity, quick actions. |
| `#/exam` | Exam workspace. |
| `#/quizzes` | Exam library management. |
| `#/answer-key` | Answer key editing and saving. |
| `#/scan` | Scan workspace for image-based processing and review. |
| `#/records` | Student record list. |
| `#/received-papers` | Inbox for papers uploaded by external/mobile devices. |
| `#/connected-devices` | Device/connectivity view. |
| `#/reports` | Reports and analytics. |
| `#/systems` | Settings, backup/restore, OMR/AI controls. |

Important frontend scripts:

| File | Role |
| --- | --- |
| `apps/web/js/app.js` | Main SPA controller, auth handling, rendering, API calls, scanning UI state. |
| `apps/web/js/config.js` | API URL resolution and request helpers. |
| `apps/web/js/answer-sheet.js` | Generated answer sheet renderer for OMR-compatible sheets. |
| `apps/web/js/answer-sheetnormal.js` | Normal answer-sheet variant. |
| `apps/web/js/subject-report.js` | Subject reporting UI logic. |
| `apps/web/js/error-handler.js` | Centralized frontend error formatting/auth response behavior. |
| `apps/web/js/input-validator.js` | Frontend validation helpers. |
| `apps/web/js/loading-state-manager.js` | Loading states. |
| `apps/web/js/modal-manager.js` | Modal handling. |
| `apps/web/js/toast-manager.js` | Toast notifications. |

The web page intentionally blocks mobile web access and tells mobile users to use the Android app. The dashboard itself is meant for desktop/laptop administration.

## Answer Sheet Generation

Answer-sheet generation is implemented in `apps/web/js/answer-sheet.js`.

Current behavior:

- Supports paper sizes:
  - A4: `210mm x 297mm`.
  - Long bond: `8.5in x 13in`.
  - 11x14 bond: `11in x 14in`.
- Default exam title: `Entrance Examination`.
- Default question count: `100`.
- Default options: `4`.
- Auto-adjusts question columns:
  - More than 120 questions: 4 columns.
  - More than 90 questions: 3 columns.
  - Otherwise: 2 columns.
- Builds a printable OMR sheet with:
  - PCC branding.
  - Student information areas.
  - QR code area.
  - Layout identifiers.
  - Registration anchors.
  - Density reference bar.
  - Bubble grids.
  - Instructions/footer.

The generated layout is saved through `POST /api/omr/layouts`. The layout JSON contains the coordinates needed by both the Python deterministic layout worker and the AI scanner cropper.

## Active Scan Architecture

There are currently multiple scan-related routes, but they do not all represent the same product path.

### Retired legacy product route

`POST /api/scans/process` now returns:

- HTTP status: `410`.
- Code: `LEGACY_OMR_RETIRED`.
- Message: the legacy deterministic OMR scan endpoint has been retired and the AI Vision path should be used.

The old code remains below the early return in the file, but it is unreachable unless the early return is removed. That means older docs describing `/api/scans/process` as the active mobile scan endpoint are out of date.

### Manual/legacy answer submission route

`POST /api/scans` still accepts already-known answers and persists score results. It calculates subject scores and inserts rows into `scans`, `subject_records`, and `records`. This route is not the main AI image-reading path.

### Active AI Vision route

`POST /api/ai-omr/scan` is the active AI image-reading endpoint.

High-level flow:

1. Accepts an image payload as `image`, `photo`, or `image_data`.
2. Reads the image from either a data URL/base64 payload or an existing upload path.
3. Identifies the layout:
   - Uses a supplied `layoutId`/`examId` if provided.
   - Attempts QR-based layout identification.
   - Falls back to the latest compatible generated layout for a selected quiz if possible.
4. Loads the generated layout JSON from `.runtime/data/omr-layouts`.
5. Loads AI OMR settings from runtime settings.
6. Runs AI OMR scanning through `runAiOmrScan`.
7. Optionally runs benchmark mode with repeat count capped between 1 and 3.
8. Records usage into `ai_omr_usage`.
9. If a quiz is provided, scores against the database answer key.
10. Returns structured answer records, scoring status, subject results when available, layout information, provider/model data, metrics, and review indicators.

The AI route is authenticated.

## AI OMR Service

The AI OMR service lives in `apps/api/services/ai-omr`.

Important files:

| File | Purpose |
| --- | --- |
| `aiOmrService.js` | Main orchestration for AI OMR scans and benchmarks. |
| `config.js` | Reads and validates AI scanner configuration. |
| `settingsStore.js` | Persists AI OMR settings under runtime data. |
| `providers/geminiProvider.js` | Gemini provider implementation. |
| `providers/ollamaProvider.js` | Ollama provider implementation. |
| `prompts.js` | Prompt construction. |
| `resultValidator.js` | Validates structured AI results and creates answer vectors. |
| `verification.js` | Verification handling for uncertain/low-confidence reads. |
| `sectionCropper.js` | Builds whole-sheet/section/top-field crops from generated layout. |
| `imagePreparation.js` | Parses, loads, hashes, and prepares images. |
| `qrDecode.js` | Decodes QR data and extracts layout IDs. |
| `schemas/omrResultSchema.js` | Structured result schema. |
| `pagePrepWorker.py` | Python page preparation helper. |

Strategies:

- `whole_sheet`: scan the whole page.
- `section_10`: scan 10-question sections.
- `section_20`: scan 20-question sections.
- `auto`: currently normalizes toward section-based scanning.
- `fast`: uses larger sections.
- `high_accuracy`: uses smaller sections.
- `custom`: uses requested strategy/settings.

The service keeps an in-memory `inFlightScans` map to avoid duplicating work for the same request/image/layout/strategy combination while a scan is already running.

## Python Generated-Layout OMR Worker

The main Python worker is `services/omr-python/python_omr/layout_worker.py`.

Current responsibilities:

- Reads image bytes from stdin.
- Decodes image with OpenCV.
- Detects document boundaries.
- Warps the sheet to layout coordinate space.
- Attempts QR/barcode decoding through `pyzbar` when available.
- Loads generated layout JSON from `.runtime/data/omr-layouts`.
- Uses layout coordinates to evaluate bubbles.
- Computes image quality metrics such as blur, contrast, and brightness.
- Produces debug/alignment artifacts under `.runtime/data/uploads/debug`.
- Supports optional forensic debug bundles through `forensic_debug.py`.
- Has optional CNN bubble classification support through `bubble_cnn_classifier.py` when model assets are present.

There is also `filled_circle_detector.py`, but the API endpoint that exposed legacy bubble debug scanning now returns `410 LEGACY_OMR_DEBUG_RETIRED`. The script still exists for debugging and development use.

## Inbox / Received Papers

The `received_papers` flow is active and stores paper images uploaded by devices or external clients.

Important routes:

- `GET /api/received-papers`: authenticated, returns inbox papers with absolute image URLs.
- `POST /api/received-papers`: unauthenticated upload endpoint for devices.
- `DELETE /api/received-papers/:id`: authenticated deletion endpoint.

Upload behavior:

1. Accepts student metadata such as sheet ID, student ID, exam ID, name, course, age, room, seat, entry type, equity group, and device ID.
2. Accepts image data as a data URL, raw base64, URL-safe base64, `image`, `photo`, or related field aliases.
3. Rejects invalid or too-small image payloads.
4. Computes a SHA-256 image hash to reject duplicate uploads.
5. Limits a device or sender IP to 50 queued papers.
6. Stores the image under `.runtime/data/uploads/received`.
7. Inserts a row into `received_papers`.

Current database state shows `1` received paper waiting or stored in the inbox.

## Reports And Records

The API supports several result and report paths:

- `GET /api/scans`
- `GET /api/scans/:id`
- `DELETE /api/scans/:id`
- `GET /api/records`
- `POST /api/records`
- `PUT /api/records/:id`
- `DELETE /api/records`
- `DELETE /api/records/:id`
- `GET /api/scores/report`
- `GET /api/reports/subjects`
- `GET /api/subject-records`
- `DELETE /api/subject-records/bulk-delete`
- `DELETE /api/subject-records/:id`

Currently the database has no completed scans, records, or subject records. That means the dashboard can load, quizzes and answer keys exist, and inbox/AI usage exists, but no finalized student result rows are currently present in the active database.

## Backup And Restore

Backup/restore is implemented in `apps/api/api.js`.

Important routes:

- `GET /api/system/backup/history`
- `GET /api/system/backup/download`
- `POST /api/system/backup/upload/start`
- `POST /api/system/backup/upload/chunk`
- `POST /api/system/backup/upload/complete`
- `POST /api/system/backup/restore`
- `POST /api/system/backup/restore-uploaded`
- `POST /api/system/backup/restore-path`
- `POST /api/system/backup/restore-history`

Runtime backup archive path:

- `.runtime-backups`

The server skips standard body parsing for binary chunk upload and direct restore routes to allow large data transfer. It also disables request/socket timeouts during startup for very large backup operations.

## API Route Map

The following route groups exist in `apps/api/api.js`.

Public or semi-public:

- `GET /api/health`
- `GET /api/qr`
- `POST /api/register`
- `POST /api/auth/login`
- `POST /api/scans/process` returns retired/410.
- `POST /api/scans` persists already-known answers and scores.
- `POST /api/received-papers` queues uploaded paper images.

Authenticated exam/key routes:

- `GET /api/quizzes`
- `POST /api/quizzes`
- `PUT /api/quizzes/:id`
- `DELETE /api/quizzes/:id`
- `POST /api/quizzes/:id/restore`
- `DELETE /api/quizzes/:id/permanent`
- `GET /api/quizzes/:quizId/answer-key`
- `POST /api/quizzes/:quizId/answer-key`
- `DELETE /api/quizzes/:quizId/answer-key`

Authenticated record/report routes:

- `GET /api/scans`
- `GET /api/scans/:id`
- `DELETE /api/scans/:id`
- `GET /api/records`
- `POST /api/records`
- `PUT /api/records/:id`
- `DELETE /api/records`
- `DELETE /api/records/:id`
- `POST /api/records/ocr`
- `GET /api/scores/report`
- `GET /api/reports/subjects`
- `GET /api/subject-records`
- `DELETE /api/subject-records/bulk-delete`
- `DELETE /api/subject-records/:id`

Authenticated system routes:

- `GET /api/system/info`
- `GET /api/systems`
- `POST /api/systems`
- `DELETE /api/systems`
- Backup and restore routes listed above.
- `POST /api/staff/bulk`
- `POST /api/admin/backfill-subject-scores`

Authenticated AI/OMR/OCR routes:

- `GET /api/ai-omr/settings`
- `POST /api/ai-omr/settings`
- `POST /api/ai-omr/test-connection`
- `GET /api/ai-omr/usage`
- `POST /api/ai-omr/identify-layout`
- `POST /api/ai-omr/scan`
- `POST /api/omr/layouts`
- `GET /api/omr/layouts/:examId`
- `POST /api/omr/debug-bubbles` returns retired/410.
- `POST /api/ocr`

## Current Git Worktree Situation

The worktree is currently dirty.

Notable observed state:

- `.env.example` is modified.
- API files are modified, including `apps/api/api.js`, `database.js`, migrations, package files, and server startup.
- Web files are modified, including `apps/web/index4.html`, CSS, answer sheet scripts, config, error handling, app controller, print page, and reports.
- Python OMR worker files are modified.
- Several AI OMR service files under `apps/api/services/ai-omr` are untracked.
- Several docs and scripts are untracked or modified.
- Many Android project files are shown as deleted in Git status.

Because of the large number of existing changes, care should be taken before committing or reverting anything. The Android deletions in particular look broad and should be reviewed intentionally before any cleanup commit.

## Important Current Risks And Notes

1. Older documentation conflicts with current source behavior.

   Some docs still describe `/api/scans/process` as the main mobile/server OMR path. In current source, that route returns `410 LEGACY_OMR_RETIRED`, so operators and Android clients should use the current AI Vision flow or the inbox upload flow depending on purpose.

2. Active scanning depends on generated layout availability.

   The AI scan path needs a layout ID from QR/manual input or a compatible generated layout for the selected quiz. If the layout file is missing from `.runtime/data/omr-layouts`, scanning fails with layout identification or layout-not-found errors.

3. AI configuration is backend-sensitive.

   `GEMINI_API_KEY` must stay backend-only. The frontend should only receive public AI settings from `publicAiOmrSettings`.

4. Completed result tables are currently empty.

   There are quizzes, answer keys, layouts, and inbox/AI usage rows, but no completed scan records. This may be expected for a fresh or recently reset runtime DB, but it means dashboard score/report data will be limited until scans are finalized.

5. Runtime data is large.

   `.runtime/data` is about `1.1G`, mostly from uploads, generated layouts, debug artifacts, database files, and calibration/test files. Debug artifacts may eventually need retention rules.

6. Server is LAN-exposed.

   The server listens on `0.0.0.0`, and CORS allows localhost and private LAN origins. This is correct for local device scanning, but the system should remain on trusted networks unless authentication and upload controls are hardened further.

7. Backup upload code has mixed comments.

   `MAX_BACKUP_UPLOAD_BYTES` is set to `100 * 1024 * 1024`, but the inline comment says "No limit as requested". The effective value should be checked before relying on unlimited backup upload behavior.

8. Android state needs review.

   The Git status shows very large Android deletions. If Android is still part of the product, the current repository state should be audited before committing.

## Operational Commands

Start the system:

```bash
cd apps/api
npm start
```

Or use the Linux launcher:

```bash
./scripts/launcher/start-scancheck.sh
```

Stop the system:

```bash
./scripts/launcher/stop-scancheck.sh
```

Check health:

```bash
curl http://localhost:3000/api/health
```

Open dashboard:

```text
http://localhost:3000
```

Check active port:

```bash
cat .runtime/current_port.txt
```

## Practical Next Steps

Recommended next technical actions:

1. Update or archive older docs that still describe retired scanner routes as active.
2. Decide whether Android is still active; if yes, inspect the current deleted-file state before committing.
3. Confirm the frontend scan workspace is calling `/api/ai-omr/scan` for image reading.
4. Add a small operator note in the UI/settings screen explaining that layout generation must happen before scanning.
5. Add debug artifact cleanup or retention settings for `.runtime/data/uploads/debug`.
6. Verify backup upload limits and comments match the intended behavior.
7. Run an end-to-end scan using an existing generated layout and confirm that `scans`, `records`, and `subject_records` populate correctly.

