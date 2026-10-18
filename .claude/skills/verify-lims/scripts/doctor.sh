#!/usr/bin/env bash
# Read-only: is this run's Aliquot worth driving? Exits non-zero with the first failed check.
# Usage: .claude/skills/verify-lims/scripts/doctor.sh [run-name]
set -uo pipefail
ROOT=$(cd -P "$(dirname "$0")/../../../.." && pwd)
NAME=${1:-verify}
RUN="$ROOT/.verify/runs/$NAME"
fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$RUN/pid" && -f "$RUN/base" ]] || fail "no run '$NAME' (launch it: .claude/skills/verify-lims/scripts/launch.sh $NAME)"
PID=$(cat "$RUN/pid")
BASE=$(cat "$RUN/base")
PORT=${BASE##*:}
kill -0 "$PID" 2>/dev/null || fail "server process $PID is gone; see $RUN/server.log"
ps -o command= -p "$PID" | grep -q 'node server.js' || fail "pid $PID is not 'node server.js'"
lsof -nP -a -p "$PID" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || fail "port $PORT is not owned by pid $PID"
grep -q "Data folder: *$RUN/data" "$RUN/server.log" || fail "server is not using $RUN/data"
SETUP=$(curl -fsS "$BASE/api/setup") || fail "$BASE/api/setup does not answer"
echo "$SETUP" | grep -q '"needsSetup":false' || fail "lab is not set up: $SETUP"
echo "$SETUP" | grep -q '"demo":true' || fail "demo lab not loaded: $SETUP"
if ps eww -o command= -p "$PID" | grep -qF "ALIQUOT_CLAUDE_BIN=$ROOT/test/fake-claude.mjs"; then CLAUDE="fake (test/fake-claude.mjs, replies in $RUN/fake)"; else CLAUDE="REAL claude: this run can reach the model and the computer's Claude account"; fi
echo "OK  run=$NAME pid=$PID base=$BASE commit=$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo '+dirty')"
echo "    claude: $CLAUDE"
echo "    server started from the working tree at launch; relaunch after server/ changes (public/ changes need only a reload)"
