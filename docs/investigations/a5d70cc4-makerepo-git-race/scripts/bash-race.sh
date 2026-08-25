#!/usr/bin/env bash
# Trial 5 — N truly-simultaneous bash-backgrounded `git init` chains, bypassing Node's
# own child_process.spawn overhead (~tens of ms per call) as a possible confound on how
# simultaneous the process starts really are. Each backgrounded subshell does the exact
# same `git init -q && git config ... && git config ... && git add . && git -c ... commit`
# chain used by packages/daemon/test/merge-rest-route-tracked.mjs:56-60 (see ../README.md).
#
# Usage: bash bash-race.sh <N> <root-dir>
set -u
N="${1:-60}"
ROOT="${2:?usage: bash-race.sh <N> <root-dir>}"
mkdir -p "$ROOT"
for i in $(seq 1 "$N"); do
  d="$ROOT/r$i"
  mkdir -p "$d"
  echo "# x" > "$d/README.md"
  (
    cd "$d" &&
    git init -q &&
    git config user.email a@a &&
    git config user.name a &&
    git add . &&
    git -c user.email=a@a -c user.name=a commit -q -m init > "$d/out.txt" 2>&1
    echo $? > "$d/exit.code"
  ) &
done
wait
echo "DONE: $(grep -L '^0$' "$ROOT"/r*/exit.code 2>/dev/null | wc -l) non-zero exits out of $N"
