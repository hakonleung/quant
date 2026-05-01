#!/usr/bin/env bash
# PostToolUse hook: after Edit/Write/MultiEdit on source/proto files, remind Claude to run /generate-tests then /auto-review.
set -euo pipefail

payload="$(cat)"
file_path="$(printf '%s' "$payload" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    p = d.get("tool_input", {}).get("file_path", "")
    print(p)
except Exception:
    pass')"

case "$file_path" in
  *services/py/*.py | \
  *apps/api/src/*.ts | \
  *apps/web/*.ts | *apps/web/*.tsx | \
  *packages/*.ts | *packages/*.tsx | \
  *proto/* )
    cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Source/contract file edited. Before declaring this task done you MUST: (1) run /generate-tests (calls test-generator agent) so the mirrored test file exists and covers golden/边界/异常/不变量/回归; (2) run /auto-review which executes ruff+mypy+pytest (Py) + eslint+tsc+jest/vitest (TS) + code-reviewer agent against CLAUDE.md and docs/. Skipping either step = task incomplete."}}
EOF
    ;;
  *)
    : ;;
esac
