#!/usr/bin/env bash
# Stop hook: nudge Claude to run the doc-updater subagent when the latest
# 5 commits all skipped `docs/` and `README.md`.
#
# Rationale: docs drift the moment code lands. Hard-failing on every commit
# is too noisy; checking the last N commits as a window catches sustained
# drift without firing on a single in-flight feature.
#
# Output contract: a single JSON object on stdout per the Stop hook spec.
# We always emit the existing review reminder; if the staleness condition
# fires, we append an extra line steering Claude to the doc-updater agent.

set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" >/dev/null 2>&1 || true

review_reminder="Reminder: if any src/ or tests/ file changed this session, you must have run /auto-review (style, type, tests, code-reviewer agent). Verify before ending."

extra=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  shas="$(git log -5 --pretty=format:%H 2>/dev/null || true)"
  count="$(printf '%s\n' "$shas" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$count" = "5" ]; then
    touched=0
    while IFS= read -r sha; do
      [ -z "$sha" ] && continue
      if git show --name-only --pretty=format: "$sha" 2>/dev/null \
        | grep -E '^(docs/|README\.md$)' -q; then
        touched=$((touched + 1))
      fi
    done <<< "$shas"
    if [ "$touched" = "0" ]; then
      extra=" The last 5 commits all skipped docs/ and README.md — invoke the doc-updater subagent (Agent tool, subagent_type=doc-updater) to sync drifted docs before stopping. If the changes were truly internal (refactor / tests / config), the agent will report a No-op and exit cheaply."
    fi
  fi
fi

# Emit the JSON message expected by the Stop hook.
python3 - "$review_reminder" "$extra" <<'PY'
import json, sys
msg = sys.argv[1] + sys.argv[2]
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": msg,
    }
}))
PY
