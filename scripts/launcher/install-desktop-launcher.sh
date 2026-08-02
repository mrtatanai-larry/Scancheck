#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DESKTOP_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${DESKTOP_DIR}/scancheck.desktop"

mkdir -p "${DESKTOP_DIR}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=ScanCheck
Comment=Start ScanCheck server and open dashboard
Exec=${ROOT_DIR}/scripts/launcher/start-scancheck.sh
Terminal=true
Categories=Education;Utility;
StartupNotify=true
EOF

chmod +x "${ROOT_DIR}/scripts/launcher/start-scancheck.sh" \
         "${ROOT_DIR}/scripts/launcher/stop-scancheck.sh" \
         "${ROOT_DIR}/scripts/launcher/status-scancheck.sh"

echo "[ScanCheck] Desktop launcher installed:"
echo "  ${DESKTOP_FILE}"
echo "[ScanCheck] You can now search for 'ScanCheck' in your app launcher."
