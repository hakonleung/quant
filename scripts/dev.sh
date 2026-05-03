#!/usr/bin/env bash
# One-shot dev launcher — starts Python Flight RPC + NestJS API + Next.js Web together.
# Logs are prefixed and color-coded; Ctrl-C tears all three down.
#
# Usage:
#   scripts/dev.sh                 # all three
#   scripts/dev.sh --py-only       # only python rpc
#   scripts/dev.sh --ts-only       # only api + web
#   scripts/dev.sh --no-web        # py + api
#   scripts/dev.sh --no-api        # py + web
#
# Env overrides:
#   QUANT_FLIGHT_HOST   default 127.0.0.1
#   QUANT_FLIGHT_PORT   default 8815
#   API_PORT            default 3001
#   WEB_PORT            default 3000

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------- flags ----------
RUN_PY=1; RUN_API=1; RUN_WEB=1
for arg in "$@"; do
  case "$arg" in
    --py-only)  RUN_API=0; RUN_WEB=0 ;;
    --ts-only)  RUN_PY=0 ;;
    --no-web)   RUN_WEB=0 ;;
    --no-api)   RUN_API=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ---------- env ----------
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi
export QUANT_FLIGHT_HOST="${QUANT_FLIGHT_HOST:-127.0.0.1}"
export QUANT_FLIGHT_PORT="${QUANT_FLIGHT_PORT:-8815}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

# ---------- colors ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_PY=$'\033[38;5;141m'      # purple
  C_API=$'\033[38;5;208m'     # orange
  C_WEB=$'\033[38;5;39m'      # cyan-blue
  C_OK=$'\033[38;5;42m'       # green
  C_ERR=$'\033[38;5;203m'     # red
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_PY=""; C_API=""; C_WEB=""; C_OK=""; C_ERR=""
fi

# ---------- logging helpers ----------
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

# Prefix every line of a stream with a tag, mirror to stdout and to a logfile.
prefix() {
  local tag="$1" color="$2" file="$3"
  awk -v t="$tag" -v c="$color" -v r="$C_RESET" -v f="$file" '
    { line = c "[" t "]" r " " $0;
      print line;
      print $0 >> f;
      fflush();
    }'
}

# ---------- preflight ----------
have() { command -v "$1" >/dev/null 2>&1; }
miss=0
if [[ $RUN_PY -eq 1 ]]; then
  if ! have uv; then echo "${C_ERR}✗ uv not found. install: https://docs.astral.sh/uv/${C_RESET}"; miss=1; fi
fi
if [[ $RUN_API -eq 1 || $RUN_WEB -eq 1 ]]; then
  if ! have pnpm; then echo "${C_ERR}✗ pnpm not found. install: npm i -g pnpm${C_RESET}"; miss=1; fi
fi
[[ $miss -eq 1 ]] && exit 1

# ---------- pid tracking + teardown ----------
PIDS=()
cleanup() {
  local code=$?
  echo
  echo "${C_DIM}── shutting down (${#PIDS[@]} procs) ──${C_RESET}"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      # negative pid → kill the process group so child watchers go too
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    fi
  done
  # give them a moment, then SIGKILL stragglers
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "-$pid" 2>/dev/null
  done
  exit "$code"
}
trap cleanup INT TERM EXIT

# ---------- spawners ----------
spawn() {
  local tag="$1" color="$2" logfile="$3"; shift 3
  echo "${color}▶ start ${tag}${C_RESET} ${C_DIM}→ $* ${C_RESET}"
  # setsid so the process owns its own group (clean teardown of children/watchers)
  if have setsid; then
    setsid bash -c "$*" 2>&1 | prefix "$tag" "$color" "$logfile" &
  else
    # macOS: no setsid, but `set -m` + `exec` puts the child in its own pgid
    ( set -m; exec bash -c "$*" ) 2>&1 | prefix "$tag" "$color" "$logfile" &
  fi
  PIDS+=($!)
}

echo "${C_BOLD}┌── quant dev ──────────────────────────────${C_RESET}"
echo "${C_BOLD}│${C_RESET} root      ${C_DIM}$ROOT${C_RESET}"
echo "${C_BOLD}│${C_RESET} flight    ${C_DIM}${QUANT_FLIGHT_HOST}:${QUANT_FLIGHT_PORT}${C_RESET}  ${C_DIM}(py)${C_RESET}"
echo "${C_BOLD}│${C_RESET} api       ${C_DIM}127.0.0.1:${API_PORT}${C_RESET}  ${C_DIM}(nest)${C_RESET}"
echo "${C_BOLD}│${C_RESET} web       ${C_DIM}127.0.0.1:${WEB_PORT}${C_RESET}  ${C_DIM}(next)${C_RESET}"
echo "${C_BOLD}│${C_RESET} logs      ${C_DIM}${LOG_DIR}/{py,api,web}.log${C_RESET}"
echo "${C_BOLD}└───────────────────────────────────────────${C_RESET}"

# truncate previous logs
: > "$LOG_DIR/py.log"; : > "$LOG_DIR/api.log"; : > "$LOG_DIR/web.log"

if [[ $RUN_PY -eq 1 ]]; then
  spawn "py " "$C_PY" "$LOG_DIR/py.log" \
    "uv run python -m quant_rpc"
fi

if [[ $RUN_API -eq 1 ]]; then
  spawn "api" "$C_API" "$LOG_DIR/api.log" \
    "PORT=${API_PORT} pnpm --filter api dev"
fi

if [[ $RUN_WEB -eq 1 ]]; then
  spawn "web" "$C_WEB" "$LOG_DIR/web.log" \
    "PORT=${WEB_PORT} pnpm --filter web exec next dev -p ${WEB_PORT}"
fi

echo "${C_OK}● all services launched · Ctrl-C to stop${C_RESET}"

# wait on any child; if one dies, tear everything down.
# `wait -n` requires bash 4.3+; macOS ships bash 3 — fall back to a poll.
if wait -n 2>/dev/null; then
  :
else
  while :; do
    for pid in "${PIDS[@]:-}"; do
      if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
        break 2
      fi
    done
    sleep 1
  done
fi
echo "${C_ERR}✗ a service exited; stopping the rest${C_RESET}"
