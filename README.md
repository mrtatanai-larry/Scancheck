# ScanCheck System

ScanCheck is an OMR examination processing system with:
- `apps/api` - Node.js API + SQLite persistence
- `apps/web` - Web dashboard (served by API)
- `services/omr-python` - Python OCR/OMR workers and model assets
- `services/omrchecker` - OMRChecker engine source

## Repository Structure

```text
scancheck-system/
  apps/
    api/
    web/
  services/
    omr-python/
    omrchecker/
  docs/
    active/
    archive/
  legacy/
    xampp/
  scripts/
  infra/
  .runtime/        # runtime data (db/uploads/logs/tmp)
```

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

3. Start API + Web

```bash
npm start
```

4. Open dashboard

- `http://localhost:3000`

## One-Click Launcher (Linux/Desktop)

Start the system and open browser automatically:

```bash
./scripts/launcher/start-scancheck.sh
```

Notes:
- If your system Node is not compatible (this project expects Node 18-22), the launcher auto-downloads and uses a local Node 22 runtime from `nodejs.org` under `.runtime/tools/node`.
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

Notes:
- If global Node is outside `18-22`, the launcher auto-downloads and uses a local Node 22 runtime from `nodejs.org` under `.runtime\tools\node`.

Stop:

```powershell
.\scripts\launcher\stop-scancheck.ps1
```

Status:

```powershell
.\scripts\launcher\status-scancheck.ps1
```

## Runtime Paths

Runtime state is written to `.runtime/` by default:
- DB: `.runtime/data/scancheck.db`
- Uploads: `.runtime/data/uploads/*`
- Logs: `.runtime/logs/*`

Override paths using environment variables in `.env.example`.

## Notes

- Legacy PHP/XAMPP path is archived under `legacy/xampp` and not used by active runtime.
- Android app remains in `android/` and was not refactored in this cleanup.
