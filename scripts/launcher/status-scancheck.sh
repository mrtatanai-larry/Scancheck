#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/scancheck.pid"
PORT_FILE="${RUNTIME_DIR}/current_port.txt"

if [ -f "${PORT_FILE}" ]; then
    PORT="$(tr -d '[:space:]' < "${PORT_FILE}")"
else
    PORT="3000"
fi

if [ -f "${PID_FILE}" ]; then
    PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
else
    PID=""
fi

if [ -n "${PID}" ] && kill -0 "${PID}" >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        echo "[ScanCheck] RUNNING | PID=${PID} | URL=http://localhost:${PORT}"
        exit 0
    fi
    echo "[ScanCheck] PROCESS UP but health check failed | PID=${PID} | PORT=${PORT}"
    exit 1
fi

echo "[ScanCheck] STOPPED"
exit 1
