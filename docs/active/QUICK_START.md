# ScanCheck Quick Start

ScanCheck is an AI Vision OMR exam system. The scanner uses Gemini vision models (optional Ollama) to read answer sheets against generated layouts. See `SYSTEM_CURRENT_STATE_DETAILED.md` for the authoritative current-state description.

## 1) Install dependencies

```bash
pip install -r requirements.txt
cd apps/api
npm install
```

Python (OpenCV) is optional and only used for page preparation; the AI scanner falls back gracefully if it is unavailable.

## 2) Configure the AI scanner

Copy `.env.example` to `.env` and set a Gemini API key:

```
GEMINI_API_KEY=your-key-here
```

Key defaults (see `.env.example` for all `AI_OMR_*` variables):

- `AI_OMR_ENABLED=true`
- `AI_OMR_MODEL=gemini-3.6-flash`
- `AI_OMR_STRATEGY=auto` (`auto`, `fast`, `high_accuracy`, `custom`)
- `AI_OMR_IMAGE_DETAIL=medium` (`low`, `medium`, `high`)
- `AI_OMR_VERIFICATION_MODE=uncertain` (`uncertain`, `always`, `disabled`)

`GEMINI_API_KEY` must remain backend-only; never expose it to frontend code.

## 3) Start the API and web dashboard

```bash
cd apps/api
npm start
```

The API serves the dashboard from `apps/web`.

## 4) Open the dashboard

- `http://localhost:3000`

Default admin credentials are bootstrapped per `.env.example` (`admin` / `admin111` by default).

## 5) Generate a layout before scanning

The AI scanner reads sheets against a generated layout. In the dashboard Scan workspace (or via `POST /api/omr/layouts`), generate and save the answer-sheet layout. The printed sheet's QR code identifies the layout; the layout JSON defines every bubble and top-field region used for cropping.

Scan an image with:

- Dashboard Scan workspace (calls `POST /api/ai-omr/scan`)
- `POST /api/ai-omr/scan` directly (authenticated; body `image`, `layoutId`/`examId`, optional `quizId` for scoring)
- `POST /api/ai-omr/identify-layout` to resolve a layout from a QR

## Launcher scripts

Linux: `./scripts/launcher/start-scancheck.sh`, `stop-scancheck.sh`
Windows: `scripts\launcher\start-scancheck.ps1`, `stop-scancheck.ps1`, `status-scancheck.ps1`

## Runtime locations

Runtime data is outside source folders by default:

- DB: `.runtime/data/scancheck.db`
- Uploads: `.runtime/data/uploads/`
- Generated layouts: `.runtime/data/omr-layouts/`
- Logs: `.runtime/logs/`

You can override with environment variables in `.env.example`.

## Retired endpoints

- `POST /api/scans/process` -> HTTP `410 LEGACY_OMR_RETIRED`
- `POST /api/omr/debug-bubbles` -> HTTP `410 LEGACY_OMR_DEBUG_RETIRED`
