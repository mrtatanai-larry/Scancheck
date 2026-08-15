#!/usr/bin/env bash
# ==============================================================================
# ScanCheck Launcher — start-scancheck.sh
# ==============================================================================
# This script starts the ScanCheck OMR server on the current machine.
# It:
#   1. Checks system dependencies (bash, python, curl, xdg-open, tar)
#   2. Selects a Node.js runtime (system or cached local LTS)
#   3. Installs/verifies Python + Node dependencies
#   4. Syncs the OMR template file
#   5. Starts the server on port 3000 (or $SCANCHECK_PORT)
#   6. Waits for the server to become healthy
#   7. Opens the browser
#
# Environment variables:
#   SCANCHECK_PORT         — port to listen on (default: 3000)
#   SCANCHECK_NODE_MAJOR   — preferred Node major version (default: 22)
#   SCANCHECK_NODE_VERSION — exact Node version to fetch (e.g. v22.11.0)
#   SCANCHECK_NPM_REGISTRY — npm registry URL
#   SCANCHECK_TEMPLATE_SOURCE — 'runtime' or 'repo' (default: runtime)
#   SCANCHECK_RUNTIME_ROOT — custom .runtime directory
#   SCANCHECK_SKIP_DEPS    — set to 1 to skip dependency installation
# ==============================================================================

set -euo pipefail

# ---- Paths ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
LOG_DIR="${RUNTIME_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/scancheck.pid"
PORT_FILE="${RUNTIME_DIR}/current_port.txt"
SERVER_LOG="${LOG_DIR}/launcher_server.log"
VENV_DIR="${ROOT_DIR}/.venv"
NODE_RUNTIME_DIR="${RUNTIME_DIR}/tools/node"

mkdir -p "${RUNTIME_DIR}" "${LOG_DIR}" "${RUNTIME_DIR}/data" "${RUNTIME_DIR}/tmp"

# ---- Helpers ----
echo_bold() { printf "\033[1m%s\033[0m\n" "$*"; }

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "[ScanCheck] Missing command: $1"
        exit 1
    fi
}

port_in_use() {
    local port="${1:-3000}"
    # Try ss (modern), then netstat (older), then /proc/net/tcp (fallback)
    if command -v ss >/dev/null 2>&1; then
        ss -tlnp 2>/dev/null | grep -qP ":$port\s"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tlnp 2>/dev/null | grep -qP ":$port\s"
    else
        # Read /proc/net/tcp for listening sockets on this port
        # The hex port is at position 2 (local_address). Port 3000 = 0x0BB8
        local hex_port
        hex_port="$(printf "%04X" "${port}")"
        grep -qi ":$hex_port" /proc/net/tcp 2>/dev/null
    fi
    return $?
}

find_pid_on_port() {
    local port="${1:-3000}"
    local pid=""
    if command -v ss >/dev/null 2>&1; then
        pid="$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1)"
    elif command -v netstat >/dev/null 2>&1; then
        pid="$(netstat -tlnp 2>/dev/null | grep ":${port} " | grep -oP '([0-9]+)/' | tr -d '/' | head -1)"
    elif [ -d /proc ] && command -v fuser >/dev/null 2>&1; then
        pid="$(fuser "${port}/tcp" 2>/dev/null | head -1)"
    fi
    echo "${pid}"
}

is_process_alive() {
    kill -0 "$1" 2>/dev/null
}

# ---- System dependency check ----
ensure_system_dependencies() {
    local missing=()
    for cmd in bash python curl xdg-open tar; do
        command -v "${cmd}" >/dev/null 2>&1 || missing+=("${cmd}")
    done

    if [ "${#missing[@]}" -eq 0 ]; then
        return 0
    fi

    echo "[ScanCheck] Missing system commands: ${missing[*]}"
    if command -v pacman >/dev/null 2>&1; then
        echo "[ScanCheck] Installing required Arch packages..."
        sudo pacman -Syu --needed nodejs npm python python-pip python-setuptools \
            base-devel zbar tesseract xdg-utils curl tar
    elif command -v apt-get >/dev/null 2>&1; then
        echo "[ScanCheck] Installing required Debian/Ubuntu packages..."
        sudo apt-get update -qq
        sudo apt-get install -y -qq curl python3 python3-pip python3-venv \
            python3-setuptools xdg-utils tar
    else
        echo "[ScanCheck] Unsupported package manager. Install missing commands manually:"
        echo "  ${missing[*]}"
        exit 1
    fi

    for cmd in bash python curl xdg-open tar; do
        require_cmd "${cmd}"
    done
}

# ---- Port & process management ----
free_port() {
    local port="${1:-3000}"
    local pid

    if ! port_in_use "${port}"; then
        return 0
    fi

    echo "[ScanCheck] Port ${port} is already in use."

    # First, check if our own PID file points to the active process
    if [ -f "${PID_FILE}" ]; then
        local our_pid
        our_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
        if [ -n "${our_pid}" ] && is_process_alive "${our_pid}" 2>/dev/null; then
            echo "[ScanCheck] Our tracked server (PID ${our_pid}) is already running on port ${port}."
            return 0
        fi
    fi

    # Find what's holding the port
    pid="$(find_pid_on_port "${port}")"
    if [ -n "${pid}" ]; then
        local cmd_name
        cmd_name="$(ps -p "${pid}" -o comm= 2>/dev/null || echo 'unknown')"
        echo "[ScanCheck] Stopping existing process on port ${port}: PID=${pid} (${cmd_name})"
        kill "${pid}" 2>/dev/null || true

        # Wait up to 5 seconds for the port to free
        for _ in $(seq 1 5); do
            if ! port_in_use "${port}"; then
                break
            fi
            sleep 1
        done

        if port_in_use "${port}"; then
            echo "[ScanCheck] Force killing PID ${pid}..."
            kill -9 "${pid}" 2>/dev/null || true
            sleep 1
        fi
    fi

    # Final check
    if port_in_use "${port}"; then
        echo "[ScanCheck] Failed to free port ${port}. Please stop the other process manually."
        exit 1
    fi

    echo "[ScanCheck] Port ${port} freed successfully."
}

# ---- Node runtime management ----
node_major() {
    "$1" -p "process.versions.node.split('.')[0]"
}

repair_local_node_runtime() {
    local node_cmd="${NODE_RUNTIME_DIR}/bin/node"
    local npm_cmd="${NODE_RUNTIME_DIR}/bin/npm"
    local npm_cli="${NODE_RUNTIME_DIR}/lib/node_modules/npm/bin/npm-cli.js"

    [ -x "${node_cmd}" ] || return 1
    [ -f "${npm_cli}" ] || return 1

    "${node_cmd}" "${npm_cli}" -v >/dev/null 2>&1 || return 1

    if ! "${npm_cmd}" -v >/dev/null 2>&1; then
        echo "[ScanCheck] Repairing cached local npm launcher."
        ln -sf "../lib/node_modules/npm/bin/npm-cli.js" "${NODE_RUNTIME_DIR}/bin/npm"
        local npx_cli="${NODE_RUNTIME_DIR}/lib/node_modules/npm/bin/npx-cli.js"
        [ -f "${npx_cli}" ] && ln -sf "../lib/node_modules/npm/bin/npx-cli.js" "${NODE_RUNTIME_DIR}/bin/npx"
    fi

    "${npm_cmd}" -v >/dev/null 2>&1
}

install_local_node_lts() {
    local desired_major="${SCANCHECK_NODE_MAJOR:-22}"
    local arch
    case "$(uname -m)" in
        x86_64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            echo "[ScanCheck] Unsupported CPU architecture: $(uname -m)"
            exit 1
            ;;
    esac

    local version="${SCANCHECK_NODE_VERSION:-}"

    # Check cached version first
    if [ -x "${NODE_RUNTIME_DIR}/bin/node" ]; then
        if repair_local_node_runtime; then
            local existing_version
            local existing_major
            existing_version="$("${NODE_RUNTIME_DIR}/bin/node" -v 2>/dev/null || true)"
            existing_major="$("${NODE_RUNTIME_DIR}/bin/node" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")"

            # If an exact version was requested, check it
            if [ -n "${version}" ] && [ "${existing_version}" = "${version}" ]; then
                echo "[ScanCheck] Using cached local Node runtime ${existing_version}."
                return 0
            fi

            # If major matches but no exact version specified, OK
            if [ -z "${version}" ] && [[ "${existing_major}" =~ ^[0-9]+$ ]] && [ "${existing_major}" -eq "${desired_major}" ]; then
                echo "[ScanCheck] Using cached local Node runtime ${existing_version}."
                return 0
            fi

            # If no preference set and cache is in 18-22 range, OK
            if [ -z "${version}" ] && [ -z "${SCANCHECK_NODE_MAJOR:-}" ] && [[ "${existing_major}" =~ ^[0-9]+$ ]] && [ "${existing_major}" -ge 18 ] && [ "${existing_major}" -le 22 ]; then
                echo "[ScanCheck] Using cached local Node runtime ${existing_version}."
                return 0
            fi
        fi
        echo "[ScanCheck] Cached Node runtime is stale or incomplete; reinstalling."
    fi

    # Determine version to fetch
    if [ -z "${version}" ]; then
        local index_json
        index_json="$(mktemp)"
        if ! curl -fsSL "https://nodejs.org/dist/index.json" -o "${index_json}" 2>/dev/null; then
            rm -f "${index_json}"
            echo "[ScanCheck] Failed to fetch Node release index. Network required for first run."
            echo "[ScanCheck] Set SCANCHECK_NODE_VERSION to a pre-cached version, or connect to internet."
            exit 1
        fi
        version="$(
            python3 - "${desired_major}" "${arch}" "${index_json}" <<'PY'
import json, sys
major, arch, index_path = sys.argv[1], sys.argv[2], sys.argv[3]
needle = f"linux-{arch}"
with open(index_path) as f:
    releases = json.load(f)
for r in releases:
    v = r.get("version", "")
    if v.startswith(f"v{major}.") and needle in r.get("files", []):
        print(v)
        break
PY
        )"
        rm -f "${index_json}"
        if [ -z "${version}" ]; then
            version="v22.11.0"
        fi
    fi

    echo "[ScanCheck] Installing local Node runtime ${version}..."
    local temp_dir
    temp_dir="$(mktemp -d)"
    local tar_name="node-${version}-linux-${arch}.tar.xz"
    local tar_path="${temp_dir}/${tar_name}"
    local extract_dir="${temp_dir}/extract"
    mkdir -p "${extract_dir}"

    if ! curl -fL "https://nodejs.org/dist/${version}/${tar_name}" -o "${tar_path}"; then
        rm -rf "${temp_dir}"
        echo "[ScanCheck] Failed to download ${tar_name}."
        exit 1
    fi

    tar -xJf "${tar_path}" -C "${extract_dir}"
    rm -rf "${NODE_RUNTIME_DIR}"
    mkdir -p "${NODE_RUNTIME_DIR}"
    cp -a "${extract_dir}/node-${version}-linux-${arch}/." "${NODE_RUNTIME_DIR}/"
    rm -rf "${temp_dir}"

    if ! repair_local_node_runtime; then
        echo "[ScanCheck] Local Node installed, but npm is broken."
        exit 1
    fi
    echo "[ScanCheck] Local Node ${version} installed."
}

select_node_runtime() {
    local use_system=false

    # Check system node
    if command -v node >/dev/null 2>&1; then
        local system_major
        system_major="$(node_major "node" 2>/dev/null || echo "0")"
        if [[ "${system_major}" =~ ^[0-9]+$ ]] && [ "${system_major}" -ge 18 ] && [ "${system_major}" -le 22 ]; then
            if command -v npm >/dev/null 2>&1 && npm -v >/dev/null 2>&1; then
                use_system=true
            fi
        else
            echo "[ScanCheck] System Node $(node -v) is outside supported range (18-22) for this project."
        fi
    fi

    if [ "${use_system}" = true ]; then
        NODE_BIN="node"
        NPM_BIN="npm"
    else
        install_local_node_lts
        NODE_BIN="${NODE_RUNTIME_DIR}/bin/node"
        NPM_BIN="${NODE_RUNTIME_DIR}/bin/npm"
        if [[ ":${PATH}:" != *":${NODE_RUNTIME_DIR}/bin:"* ]]; then
            export PATH="${NODE_RUNTIME_DIR}/bin:${PATH}"
        fi
    fi

    echo "[ScanCheck] Using Node runtime: $("${NODE_BIN}" -v)"
    echo "[ScanCheck] Using npm runtime: $("${NPM_BIN}" -v)"
}

# ---- Python environment ----
setup_python_env() {
    if [ -d "${VENV_DIR}" ] && [ ! -x "${VENV_DIR}/bin/python" ]; then
        echo "[ScanCheck] Existing Python virtual environment is invalid or from another OS. Recreating..."
        rm -rf "${VENV_DIR}"
        rm -f "${RUNTIME_DIR}/.python_bootstrap_done"
    fi

    if [ ! -d "${VENV_DIR}" ]; then
        echo "[ScanCheck] Creating Python virtual environment..."
        python -m venv "${VENV_DIR}"
    fi

    # shellcheck source=/dev/null
    source "${VENV_DIR}/bin/activate"

    # Ensure setuptools/distutils
    python -c "import distutils" 2>/dev/null || pip install setuptools -q

    if [ ! -f "${RUNTIME_DIR}/.python_bootstrap_done" ]; then
        echo "[ScanCheck] Installing Python dependencies..."
        pip install --upgrade pip -q
        if [ -f "${ROOT_DIR}/requirements.txt" ]; then
            pip install -r "${ROOT_DIR}/requirements.txt" -q
        fi
        python -c "import distutils" 2>/dev/null || pip install setuptools -q
        touch "${RUNTIME_DIR}/.python_bootstrap_done"
    fi
}

# ---- Node dependencies ----
setup_node_env() {
    select_node_runtime

    local needs_install=false
    if [ ! -d "${ROOT_DIR}/apps/api/node_modules" ]; then
        needs_install=true
    else
        (cd "${ROOT_DIR}/apps/api" && "${NPM_BIN}" ls --depth=0 >/dev/null 2>&1) || needs_install=true
    fi

    if [ "${needs_install}" = false ]; then
        # Verify sqlite3 native bindings match this Node version
        (cd "${ROOT_DIR}/apps/api" && \
         export PATH="${NODE_RUNTIME_DIR}/bin:${PATH}" && \
         "${NODE_BIN}" -e "require('sqlite3')" >/dev/null 2>&1) || {
            echo "[ScanCheck] sqlite3 bindings incompatible; reinstalling Node dependencies..."
            needs_install=true
        }
    fi

    if [ "${needs_install}" = true ]; then
        echo "[ScanCheck] Installing Node dependencies..."
        (
            cd "${ROOT_DIR}/apps/api"
            export PATH="${NODE_RUNTIME_DIR}/bin:${PATH}"
            export npm_config_python="${VENV_DIR}/bin/python"
            local registry="${SCANCHECK_NPM_REGISTRY:-https://registry.npmjs.org/}"
            local cmd
            [ -f "${ROOT_DIR}/apps/api/package-lock.json" ] && cmd="ci" || cmd="install"

            if ! "${NPM_BIN}" "${cmd}" \
                --registry="${registry}" \
                --prefer-offline \
                --no-audit \
                --no-fund \
                --progress=false \
                --fetch-retries=5 \
                --fetch-retry-factor=2 \
                --fetch-retry-mintimeout=20000 \
                --fetch-retry-maxtimeout=120000; then
                echo "[ScanCheck] npm ${cmd} failed. Retrying after cache clean..."
                "${NPM_BIN}" cache clean --force 2>/dev/null || true
                "${NPM_BIN}" "${cmd}" \
                    --registry="${registry}" \
                    --no-audit \
                    --no-fund \
                    --progress=false
            fi
        )
    fi
}

# ---- Server lifecycle ----
read_port() {
    if [ -f "${PORT_FILE}" ]; then
        tr -d '[:space:]' < "${PORT_FILE}"
    else
        echo "${SCANCHECK_PORT:-3000}"
    fi
}

is_healthy() {
    local port
    port="$(read_port)"
    curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
}

start_server() {
    local port="${SCANCHECK_PORT:-3000}"

    # ---- Port & PID cleanup ----
    rm -f "${PID_FILE}"
    free_port "${port}"

    echo "[ScanCheck] Starting server..."
    (
        cd "${ROOT_DIR}/apps/api"
        export PATH="${NODE_RUNTIME_DIR}/bin:${PATH}"
        export SCANCHECK_PYTHON="${VENV_DIR}/bin/python"
        nohup "${NODE_BIN}" server.js >> "${SERVER_LOG}" 2>&1 &
        echo $! > "${PID_FILE}"
    )
    echo "[ScanCheck] Server PID: $(cat "${PID_FILE}")"
}

wait_for_server() {
    local port
    port="$(read_port)"
    local attempts=60
    local i

    echo "[ScanCheck] Waiting for server to become healthy on port ${port}..."

    for ((i=1; i<=attempts; i++)); do
        if is_healthy; then
            echo "[ScanCheck] Server is healthy after ${i}s."
            return 0
        fi
        # Show a progress dot every 5 seconds
        if [ $((i % 5)) -eq 0 ]; then
            printf "."
        fi
        sleep 1
    done
    echo ""

    echo "[ScanCheck] Server did not become healthy in time (${attempts}s)."
    echo "[ScanCheck] ---- Last 30 lines of server log ----"
    tail -30 "${SERVER_LOG}" 2>/dev/null || echo "(log not found)"
    echo "[ScanCheck] ---- Full log: ${SERVER_LOG} ----"
    exit 1
}

open_browser() {
    local port
    port="$(read_port)"
    local url="http://localhost:${port}"
    echo "[ScanCheck] Opening ${url}"
    xdg-open "${url}" >/dev/null 2>&1 &
}

# ==============================================================================
# MAIN
# ==============================================================================

echo_bold "[ScanCheck] === ScanCheck OMR Server Launcher ==="

ensure_system_dependencies
setup_python_env

if [ "${SCANCHECK_SKIP_DEPS:-0}" != "1" ]; then
    setup_node_env
else
    select_node_runtime
fi

# Sync OMR template
if [ -f "${SCRIPT_DIR}/sync-omr-template.sh" ]; then
    bash "${SCRIPT_DIR}/sync-omr-template.sh"
fi

start_server
wait_for_server
open_browser

echo ""
echo_bold "[ScanCheck] ✅ ScanCheck is running at http://localhost:$(read_port)"
echo "[ScanCheck] Stop with: ${ROOT_DIR}/scripts/launcher/stop-scancheck.sh"
