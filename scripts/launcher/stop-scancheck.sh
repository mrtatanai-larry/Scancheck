#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/scancheck.pid"
PORT_FILE="${RUNTIME_DIR}/current_port.txt"

PORT="3000"
if [ -f "${PORT_FILE}" ]; then
    PORT="$(tr -d '[:space:]' < "${PORT_FILE}")"
fi

# Helper: find PID holding a port
find_pid_on_port() {
    local port="${1:-3000}"
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tlnp 2>/dev/null | grep ":${port} " | grep -oP '([0-9]+)/' | tr -d '/' | head -1
    elif [ -d /proc ] && command -v fuser >/dev/null 2>&1; then
        fuser "${port}/tcp" 2>/dev/null | head -1
    fi
}

PID=""
if [ -f "${PID_FILE}" ]; then
    PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
fi

# Also check port for any running server
PORT_PID="$(find_pid_on_port "${PORT}")"

if [ -n "${PID}" ]; then
    if kill -0 "${PID}" >/dev/null 2>&1; then
        echo "[ScanCheck] Stopping server PID ${PID} on port ${PORT}..."
        kill "${PID}" >/dev/null 2>&1 || true

        for _ in $(seq 1 10); do
            if ! kill -0 "${PID}" >/dev/null 2>&1; then
                break
            fi
            sleep 1
        done

        if kill -0 "${PID}" >/dev/null 2>&1; then
            echo "[ScanCheck] Force killing PID ${PID}..."
            kill -9 "${PID}" >/dev/null 2>&1 || true
        fi
        echo "[ScanCheck] Server stopped."
    else
        echo "[ScanCheck] PID ${PID} not running."
        # Maybe another process is on the port
        if [ -n "${PORT_PID}" ] && [ "${PORT_PID}" != "${PID}" ]; then
            echo "[ScanCheck] Another process (PID ${PORT_PID}) is still on port ${PORT}. Stopping it..."
            kill "${PORT_PID}" 2>/dev/null || true
            echo "[ScanCheck] Stopped."
        fi
    fi
elif [ -n "${PORT_PID}" ]; then
    echo "[ScanCheck] No PID file, but a process (PID ${PORT_PID}) is running on port ${PORT}. Stopping it..."
    kill "${PORT_PID}" 2>/dev/null || true
    for _ in $(seq 1 5); do
        if ! kill -0 "${PORT_PID}" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    kill -9 "${PORT_PID}" 2>/dev/null || true
    echo "[ScanCheck] Stopped."
else
    echo "[ScanCheck] No server appears to be running on port ${PORT}."
fi

rm -f "${PID_FILE}"
