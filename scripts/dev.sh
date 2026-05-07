#!/usr/bin/env bash
# Local dev orchestrator — Python Flight RPC + NestJS API + Next.js Web
# (and optionally Redis for the channel module).
#
# Two modes:
#
#   1. Foreground (default, used by `pnpm dev`): every service runs
#      attached, logs are color-prefixed, Ctrl-C tears them all down.
#      This is the original behavior — exit when you stop watching.
#
#   2. Daemonized (`start` / `stop` / `status` / `restart`): every
#      service is detached (`setsid`), pid + log files live under
#      `.logs/`, the controlling shell returns immediately. Use for
#      "spin everything up and walk away" workflows.
#
# Usage:
#   scripts/dev.sh                     # foreground all
#   scripts/dev.sh --py-only           # foreground py
#   scripts/dev.sh --ts-only           # foreground api+web
#   scripts/dev.sh start               # daemonize all
#   scripts/dev.sh start --with-redis  # also manage redis-server
#   scripts/dev.sh stop                # kill everything start put up
#   scripts/dev.sh status              # show pid + liveness per service
#   scripts/dev.sh restart             # stop + start
#
# Flag selectors (apply in any mode):
#   --py-only / --ts-only / --no-web / --no-api / --with-redis
#
# Env overrides:
#   QUANT_FLIGHT_HOST   default 127.0.0.1
#   QUANT_FLIGHT_PORT   default 8815
#   API_PORT            default 3001
#   WEB_PORT            default 3000
#   CHANNEL_REDIS_URL   default redis://127.0.0.1:6379  (--with-redis picks the port from this)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------- subcommand parsing ----------
MODE="up"
case "${1:-}" in
  start|stop|status|restart) MODE="$1"; shift ;;
  up)                        MODE="up"; shift ;;
  -h|--help)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# ---------- flags ----------
RUN_PY=1; RUN_API=1; RUN_WEB=1; RUN_REDIS=0
for arg in "$@"; do
  case "$arg" in
    --py-only)    RUN_API=0; RUN_WEB=0 ;;
    --ts-only)    RUN_PY=0 ;;
    --no-web)     RUN_WEB=0 ;;
    --no-api)     RUN_API=0 ;;
    --with-redis) RUN_REDIS=1 ;;
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

# Pull the redis port out of CHANNEL_REDIS_URL if set; default 6379.
REDIS_URL_RAW="${CHANNEL_REDIS_URL:-redis://127.0.0.1:6379}"
REDIS_PORT="$(echo "$REDIS_URL_RAW" | sed -E 's|.*:([0-9]+).*|\1|')"
[[ "$REDIS_PORT" =~ ^[0-9]+$ ]] || REDIS_PORT=6379

# ---------- colors ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_PY=$'\033[38;5;141m'      # purple
  C_API=$'\033[38;5;208m'     # orange
  C_WEB=$'\033[38;5;39m'      # cyan-blue
  C_RED=$'\033[38;5;167m'     # redis (mauve)
  C_OK=$'\033[38;5;42m'       # green
  C_ERR=$'\033[38;5;203m'     # red
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_PY=""; C_API=""; C_WEB=""; C_RED=""; C_OK=""; C_ERR=""
fi

LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- service registry ----------
# Parallel arrays keyed by index:
#   svc_name[i]    short tag
#   svc_color[i]   ANSI color
#   svc_enabled[i] 1 = include, 0 = skip
#   svc_cmd[i]     bash command to launch
svc_name=();   svc_color=();   svc_enabled=();   svc_cmd=()

push_svc() {
  svc_name+=("$1"); svc_color+=("$2"); svc_enabled+=("$3"); svc_cmd+=("$4")
}

# Order is also the start order; stop order reverses below so dependents
# (api/web on redis) go down first.
push_svc "redis" "$C_RED" "$RUN_REDIS" "redis-server --port ${REDIS_PORT} --save '' --appendonly no --daemonize no"
push_svc "py"    "$C_PY"  "$RUN_PY"    "uv run python -m quant_rpc.main"
push_svc "api"   "$C_API" "$RUN_API"   "PORT=${API_PORT} pnpm --filter api dev"
push_svc "web"   "$C_WEB" "$RUN_WEB"   "PORT=${WEB_PORT} pnpm --filter web exec next dev -p ${WEB_PORT}"

pidfile() { echo "$LOG_DIR/$1.pid"; }
logfile() { echo "$LOG_DIR/$1.log"; }

# ---------- preflight ----------
miss=0
[[ $RUN_PY    -eq 1 ]] && ! have uv          && { echo "${C_ERR}✗ uv not found. install: https://docs.astral.sh/uv/${C_RESET}"; miss=1; }
( [[ $RUN_API -eq 1 ]] || [[ $RUN_WEB -eq 1 ]] ) && ! have pnpm && { echo "${C_ERR}✗ pnpm not found. install: npm i -g pnpm${C_RESET}"; miss=1; }
[[ $RUN_REDIS -eq 1 ]] && ! have redis-server && { echo "${C_ERR}✗ redis-server not found (brew install redis)${C_RESET}"; miss=1; }
[[ $miss -eq 1 ]] && exit 1

# ---------- foreground ('up') mode ----------
prefix() {
  local tag="$1" color="$2" file="$3"
  awk -v t="$tag" -v c="$color" -v r="$C_RESET" -v f="$file" '
    { line = c "[" t "]" r " " $0;
      print line;
      print $0 >> f;
      fflush();
    }'
}

PIDS=()
cleanup_fg() {
  local code=$?
  echo
  echo "${C_DIM}── shutting down (${#PIDS[@]} procs) ──${C_RESET}"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    fi
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "-$pid" 2>/dev/null
  done
  exit "$code"
}

spawn_fg() {
  local tag="$1" color="$2" cmd="$3" log
  log="$(logfile "$tag")"
  echo "${color}▶ start ${tag}${C_RESET} ${C_DIM}→ ${cmd}${C_RESET}"
  if have setsid; then
    setsid bash -c "$cmd" 2>&1 | prefix "$tag" "$color" "$log" &
  else
    ( set -m; exec bash -c "$cmd" ) 2>&1 | prefix "$tag" "$color" "$log" &
  fi
  PIDS+=($!)
}

run_up() {
  banner
  for tag in py api web redis; do : > "$(logfile "$tag")"; done

  for i in "${!svc_name[@]}"; do
    [[ "${svc_enabled[$i]}" -eq 1 ]] || continue
    spawn_fg "${svc_name[$i]}" "${svc_color[$i]}" "${svc_cmd[$i]}"
  done

  echo "${C_OK}● all services launched · Ctrl-C to stop${C_RESET}"
  trap cleanup_fg INT TERM EXIT

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
}

# ---------- daemonized helpers ----------
pid_alive() { local pid="$1"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }
read_pid()  { local f="$1"; [[ -f "$f" ]] && cat "$f" 2>/dev/null || echo ""; }

# Detached spawn: redirect both streams to the logfile, write the pid
# to a pidfile, return the pid on stdout. setsid on Linux puts the
# process in its own group so we can `kill -- -pgid` later; macOS
# falls back to `set -m` + subshell.
spawn_bg() {
  local tag="$1" cmd="$2" log pid pidf
  log="$(logfile "$tag")"
  pidf="$(pidfile "$tag")"

  : > "$log"
  if have setsid; then
    setsid bash -c "$cmd" >>"$log" 2>&1 < /dev/null &
    pid=$!
  else
    ( set -m; exec bash -c "$cmd" >>"$log" 2>&1 < /dev/null ) &
    pid=$!
  fi
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$pidf"
  echo "$pid"
}

run_start() {
  banner_lite
  # Refuse to double-start any single service.
  local conflict=0
  for i in "${!svc_name[@]}"; do
    [[ "${svc_enabled[$i]}" -eq 1 ]] || continue
    local existing
    existing="$(read_pid "$(pidfile "${svc_name[$i]}")")"
    if pid_alive "$existing"; then
      echo "${C_ERR}✗ ${svc_name[$i]} already running (pid ${existing}); run 'stop' first${C_RESET}"
      conflict=1
    fi
  done
  [[ $conflict -eq 1 ]] && exit 1

  for i in "${!svc_name[@]}"; do
    [[ "${svc_enabled[$i]}" -eq 1 ]] || continue
    local tag="${svc_name[$i]}" color="${svc_color[$i]}" cmd="${svc_cmd[$i]}" pid
    pid="$(spawn_bg "$tag" "$cmd")"
    echo "${color}▶ start ${tag}${C_RESET} ${C_DIM}pid=${pid} log=${LOG_DIR}/${tag}.log${C_RESET}"
  done

  # Brief sanity check — give each child 800ms to crash on a config error
  # before we report success. That window catches the usual cases (port
  # in use, missing env) without delaying the "everything booted" signal
  # much. Slow boots (NestJS first compile, Next first build) survive
  # past 800ms so they're still reported as up here.
  sleep 0.8
  local dead=0
  for i in "${!svc_name[@]}"; do
    [[ "${svc_enabled[$i]}" -eq 1 ]] || continue
    local tag="${svc_name[$i]}" pid
    pid="$(read_pid "$(pidfile "$tag")")"
    if ! pid_alive "$pid"; then
      echo "${C_ERR}✗ ${tag} exited within 0.8s — see ${LOG_DIR}/${tag}.log${C_RESET}"
      rm -f "$(pidfile "$tag")"
      dead=1
    fi
  done

  if [[ $dead -eq 1 ]]; then
    echo "${C_ERR}● some services failed to come up; run 'stop' to clear pids${C_RESET}"
    exit 1
  fi
  echo "${C_OK}● daemonized · 'scripts/dev.sh stop' to tear down${C_RESET}"
}

run_stop() {
  echo "${C_DIM}── stopping daemonized services ──${C_RESET}"
  local any=0
  # Reverse start order: web → api → py → redis (api needs redis at
  # startup, so redis goes down last on the way out too).
  for i in $(seq $(( ${#svc_name[@]} - 1 )) -1 0); do
    local tag="${svc_name[$i]}" color="${svc_color[$i]}" pidf pid
    pidf="$(pidfile "$tag")"
    pid="$(read_pid "$pidf")"
    if pid_alive "$pid"; then
      any=1
      echo "${color}■ stop ${tag}${C_RESET} ${C_DIM}pid=${pid}${C_RESET}"
      # Try the process group first so node watchers / uv children go
      # too; fall back to plain pid if the group form errors (e.g. when
      # setsid wasn't available at spawn time).
      kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    elif [[ -n "$pid" ]]; then
      echo "${C_DIM}· ${tag} stale pid=${pid} (already exited)${C_RESET}"
    fi
  done

  # Wait up to 5s for graceful exits, then SIGKILL stragglers.
  local waited=0
  while (( waited < 50 )); do
    local alive=0
    for i in "${!svc_name[@]}"; do
      local pid
      pid="$(read_pid "$(pidfile "${svc_name[$i]}")")"
      pid_alive "$pid" && { alive=1; break; }
    done
    [[ $alive -eq 0 ]] && break
    sleep 0.1
    waited=$(( waited + 1 ))
  done

  for i in "${!svc_name[@]}"; do
    local tag="${svc_name[$i]}" pid
    pid="$(read_pid "$(pidfile "$tag")")"
    if pid_alive "$pid"; then
      echo "${C_ERR}✗ ${tag} did not exit on TERM, sending KILL${C_RESET}"
      kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
    rm -f "$(pidfile "$tag")"
  done

  if [[ $any -eq 0 ]]; then
    echo "${C_DIM}(nothing was running)${C_RESET}"
  else
    echo "${C_OK}● stopped${C_RESET}"
  fi
}

run_status() {
  printf "%-7s %-17s %-7s %s\n" "SVC" "STATE" "PID" "LOG"
  printf "%-7s %-17s %-7s %s\n" "---" "-----" "---" "---"
  for i in "${!svc_name[@]}"; do
    local tag="${svc_name[$i]}" enabled="${svc_enabled[$i]}" pid state
    pid="$(read_pid "$(pidfile "$tag")")"
    if [[ "$enabled" -ne 1 ]]; then
      state="${C_DIM}skip${C_RESET}"
    elif pid_alive "$pid"; then
      state="${C_OK}up${C_RESET}"
    elif [[ -n "$pid" ]]; then
      state="${C_ERR}dead${C_RESET}"
    else
      state="${C_DIM}down${C_RESET}"
    fi
    printf "%-7s %-17s %-7s %s\n" "$tag" "$state" "${pid:-—}" "$LOG_DIR/${tag}.log"
  done
}

# ---------- banners ----------
banner() {
  echo "${C_BOLD}┌── quant dev ──────────────────────────────${C_RESET}"
  echo "${C_BOLD}│${C_RESET} root      ${C_DIM}$ROOT${C_RESET}"
  [[ $RUN_REDIS -eq 1 ]] && echo "${C_BOLD}│${C_RESET} redis     ${C_DIM}127.0.0.1:${REDIS_PORT}${C_RESET}  ${C_DIM}(channel bus)${C_RESET}"
  [[ $RUN_PY    -eq 1 ]] && echo "${C_BOLD}│${C_RESET} flight    ${C_DIM}${QUANT_FLIGHT_HOST}:${QUANT_FLIGHT_PORT}${C_RESET}  ${C_DIM}(py)${C_RESET}"
  [[ $RUN_API   -eq 1 ]] && echo "${C_BOLD}│${C_RESET} api       ${C_DIM}127.0.0.1:${API_PORT}${C_RESET}  ${C_DIM}(nest)${C_RESET}"
  [[ $RUN_WEB   -eq 1 ]] && echo "${C_BOLD}│${C_RESET} web       ${C_DIM}127.0.0.1:${WEB_PORT}${C_RESET}  ${C_DIM}(next)${C_RESET}"
  echo "${C_BOLD}│${C_RESET} logs      ${C_DIM}${LOG_DIR}/{redis,py,api,web}.log${C_RESET}"
  echo "${C_BOLD}└───────────────────────────────────────────${C_RESET}"
}

banner_lite() {
  echo "${C_BOLD}■ quant dev · ${MODE}${C_RESET}  ${C_DIM}root=${ROOT}${C_RESET}"
}

# ---------- dispatch ----------
case "$MODE" in
  up)      run_up ;;
  start)   run_start ;;
  stop)    run_stop ;;
  status)  run_status ;;
  restart) run_stop; run_start ;;
  *)       echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
