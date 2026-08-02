# Scripts

- `maintenance/` - one-off maintenance and verification scripts
- `dev/` - local development helpers and ad-hoc tests
- `launcher/` - desktop-friendly start/stop/status helpers

Most maintenance scripts now target `.runtime/data/scancheck.db`.

## Launcher Usage

Launchers include dependency checks and can auto-install missing system dependencies:
- Linux: uses official Arch repositories via `pacman`
- Windows: uses official winget sources

From project root:

```bash
./scripts/launcher/start-scancheck.sh
```

Stop:

```bash
./scripts/launcher/stop-scancheck.sh
```

Status:

```bash
./scripts/launcher/status-scancheck.sh
```

### Windows

Start (PowerShell):

```powershell
.\scripts\launcher\start-scancheck.ps1
```

Start (double-click):

`scripts\launcher\start-scancheck.bat`

Stop:

```powershell
.\scripts\launcher\stop-scancheck.ps1
```

Status:

```powershell
.\scripts\launcher\status-scancheck.ps1
```

Create a desktop shortcut:

```powershell
.\scripts\launcher\install-windows-shortcut.ps1
```
