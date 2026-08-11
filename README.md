# ScanCheck System

ScanCheck is an AI Vision OMR examination processing system that reads bubbled answer sheets with a vision-language model instead of the old deterministic pixel-threshold scanner.

- `apps/api` - Node.js Express API + SQLite persistence
- `apps/web` - Static web dashboard (served by the API)
- `services/omr-python` - Python helpers (page prep worker) and legacy OMR workers
- `services/omrchecker` - (empty) placeholder for the former OMRChecker engine

The active scanning engine lives in `apps/api/services/ai-omr`. It uses Gemini vision models (via `@google/genai`) — with an optional Ollama provider — to read answer bubbles and top-fields from generated answer-sheet layouts.

## Repository Structure

```text
scancheck-system/
  apps/
    api/               # Express server, API routes, SQLite, AI OMR services
    web/               # Browser dashboard (index4.html)
  services/
    omr-python/        # Python: page prep worker + legacy OMR workers
    omrchecker/        # Empty; former OMRChecker engine location
  docs/
    active/            # Current documentation
    archive/           # Older / historical docs
  scripts/
    launcher/          # start/stop/status + desktop launchers (Linux/Windows)
    tools/             # Answer-sheet and accuracy-rating utilities
  infra/
  .runtime/            # Runtime data (db/uploads/logs/layouts)
  .runtime-backups/    # Database/system backup archives
```

## Prerequisites

- Node.js 18–22 (the launcher can auto-download a local Node 22 runtime)
- Python 3 with OpenCV (optional — used only for page prep; the AI scanner falls back gracefully if unavailable)
- A Gemini API key (`GEMINI_API_KEY`) for the default AI provider, or a running Ollama instance

## Quick Start

1. Install Python dependencies

```bash
pip install -r requirements.txt
```

2. Install API dependencies

```bash
cd apps/api
npm install
```

3. Configure the AI scanner

Copy `.env.example` to `.env` (or export vars) and set `GEMINI_API_KEY`. Runtime defaults:

- `AI_OMR_ENABLED=true`
- `AI_OMR_MODEL=gemini-3.6-flash`
- `AI_OMR_STRATEGY=auto`
- `AI_OMR_IMAGE_DETAIL=medium`
- `AI_OMR_VERIFICATION_MODE=uncertain`

The full set of `AI_OMR_*` variables is documented in `.env.example`.

4. Start API + Web

```bash
cd apps/api
npm start
```

5. Open the dashboard

- `http://localhost:3000`

## One-Click Launcher (Linux/Desktop)

```bash
./scripts/launcher/start-scancheck.sh
```

Notes:
- If the system Node is not compatible (this project expects Node 18-22), the launcher auto-downloads and uses a local Node 22 runtime from `nodejs.org` under `.runtime/tools/node`.
- The launcher auto-retries dependency bootstrapping when it detects partial/incomplete `node_modules`.

Optional desktop launcher install:

```bash
./scripts/launcher/install-desktop-launcher.sh
```

Stop the system:

```bash
./scripts/launcher/stop-scancheck.sh
```

## One-Click Launcher (Windows)

PowerShell start (auto-check/install dependencies via winget):

```powershell
.\scripts\launcher\start-scancheck.ps1
```

Double-click start:

- `scripts\launcher\start-scancheck.bat`

Stop / status:

```powershell
.\scripts\launcher\stop-scancheck.ps1
.\scripts\launcher\status-scancheck.ps1
```

## Runtime Paths

Runtime state is written to `.runtime/` by default:

- DB: `.runtime/data/scancheck.db`
- Uploads: `.runtime/data/uploads/*`
- Generated layouts: `.runtime/data/omr-layouts/*`
- Logs: `.runtime/logs/*`
- Backup archives: `.runtime-backups/`

Override paths using environment variables in `.env.example`.

## Main API Endpoints

- `POST /api/ai-omr/scan` - active AI Vision scan (authenticated)
- `POST /api/ocr` - AI Vision extraction (authenticated)
- `POST /api/ai-omr/settings`, `/api/ai-omr/test-connection`, `/api/ai-omr/usage`, `/api/ai-omr/identify-layout`
- `POST /api/omr/layouts` - save a generated answer-sheet layout
- `GET /api/omr/layouts/:examId` - load a generated layout
- `POST /api/received-papers` - unauthenticated inbox upload for devices
- `POST /api/auth/login` - admin login

The generated answer sheet (see the dashboard Scan workspace and `apps/web/js/answer-sheet.js`) prints a QR code that identifies the layout; the layout JSON defines every bubble and top-field region used for cropping.

## Notes

- The legacy deterministic OMR endpoint `POST /api/scans/process` and bubble debug endpoint `POST /api/omr/debug-bubbles` are retired and return HTTP `410`.
- `GEMINI_API_KEY` must stay backend-only; the dashboard only receives public settings via `publicAiOmrSettings`.
- Old Python workers in `services/omr-python/python_omr/` (e.g. `layout_worker.py`) are no longer reachable from the product path but remain on disk for reference.
- The Android app source is no longer tracked in this repository (only Gradle caches remain under `android/`).

## Documentation

- `docs/active/SYSTEM_CURRENT_STATE_DETAILED.md` - authoritative current-state description (architecture, DB, routes, runtime status, risks)
- `docs/active/QUICK_START.md` - setup and operation quick start
- `docs/active/SYSTEM_FLOW_DIAGRAM.md` - AI Vision scanning flow
- `docs/archive/` - historical OMR-based docs
