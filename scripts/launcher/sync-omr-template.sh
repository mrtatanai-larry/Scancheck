#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RUNTIME_TEMPLATE="${ROOT_DIR}/.runtime/omr-calib/input/template.json"
REPO_TEMPLATE="${ROOT_DIR}/services/omr-python/omrchecker-template/template.json"

mkdir -p "$(dirname "${RUNTIME_TEMPLATE}")"
mkdir -p "$(dirname "${REPO_TEMPLATE}")"

SOURCE="${SCANCHECK_TEMPLATE_SOURCE:-runtime}"

sync_runtime_to_repo() {
    if [ ! -f "${RUNTIME_TEMPLATE}" ]; then
        return 1
    fi

    if [ ! -f "${REPO_TEMPLATE}" ] || ! cmp -s "${RUNTIME_TEMPLATE}" "${REPO_TEMPLATE}"; then
        cp "${RUNTIME_TEMPLATE}" "${REPO_TEMPLATE}"
        echo "[ScanCheck] Synced OMR template: runtime -> repo"
    else
        echo "[ScanCheck] OMR template already in sync (runtime == repo)"
    fi
    return 0
}

sync_repo_to_runtime() {
    if [ ! -f "${REPO_TEMPLATE}" ]; then
        return 1
    fi

    if [ ! -f "${RUNTIME_TEMPLATE}" ] || ! cmp -s "${REPO_TEMPLATE}" "${RUNTIME_TEMPLATE}"; then
        cp "${REPO_TEMPLATE}" "${RUNTIME_TEMPLATE}"
        echo "[ScanCheck] Synced OMR template: repo -> runtime"
    else
        echo "[ScanCheck] OMR template already in sync (repo == runtime)"
    fi
    return 0
}

case "${SOURCE}" in
    runtime)
        if ! sync_runtime_to_repo; then
            sync_repo_to_runtime || echo "[ScanCheck] WARNING: No OMR template found to sync."
        fi
        ;;
    repo)
        if ! sync_repo_to_runtime; then
            sync_runtime_to_repo || echo "[ScanCheck] WARNING: No OMR template found to sync."
        fi
        ;;
    *)
        echo "[ScanCheck] Invalid SCANCHECK_TEMPLATE_SOURCE='${SOURCE}' (use 'runtime' or 'repo')."
        exit 1
        ;;
esac
