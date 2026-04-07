#!/usr/bin/env bash
# git-wrapper.sh — Git Gate enforcement shim
#
# VS Code sets git.path to this script so every git invocation goes through here.
#
# Priority:
#   1. If the git-gate Docker container is running, exec inside it.
#   2. Otherwise, run the Python loader directly (works without Docker).
#
# GIT_GATE_LOG_FILE is set by the VS Code extension and forwarded to the
# Python loader so activity can be written to the dashboard log.

CONTAINER="git-gate"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOADER="${SCRIPT_DIR}/loader/load_git_gate.py"
LOG_FILE="${GIT_GATE_LOG_FILE:-}"

# ── Docker path ────────────────────────────────────────────────────────────
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    if [[ -n "${LOG_FILE}" ]]; then
        exec docker exec \
            -e "GIT_GATE_LOG_FILE=${LOG_FILE}" \
            -w "$(pwd)" "${CONTAINER}" \
            python3 /loader/load_git_gate.py "$@"
    else
        exec docker exec -w "$(pwd)" "${CONTAINER}" \
            python3 /loader/load_git_gate.py "$@"
    fi
fi

# ── Local fallback ─────────────────────────────────────────────────────────
if [[ -f "${LOADER}" ]]; then
    exec python3 "${LOADER}" "$@"
fi

# ── No enforcement — warn and pass through ─────────────────────────────────
echo "git-gate: WARNING — enforcement loader not found, running git directly." >&2
REAL_GIT="$(which git || echo /usr/bin/git)"
exec "${REAL_GIT}" "$@"
