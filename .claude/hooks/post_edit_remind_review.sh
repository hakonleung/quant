#!/usr/bin/env bash
# PostToolUse hook: intentionally a no-op.
#
# Earlier this hook nagged Claude to run /generate-tests + /auto-review after
# every edit to source / proto files. In practice that triggered the
# code-reviewer subagent on scaffolding, config tweaks, and trivial refactors
# where it added no value and burned context.
#
# Policy now (see CLAUDE.md §0 / §4.1):
#   - generate-tests + auto-review run on **user request** ("review"/"审一下")
#     or at milestone / feature boundaries with non-trivial business logic.
#   - `pnpm check` is the always-on gate; it stays cheap and local.
#
# Keep this file so settings.json continues to resolve, but do nothing.
exit 0
