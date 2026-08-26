#!/usr/bin/env bash
# Card 6a9f4178 — reproduction recipe for Batch 2 (see repro-logs/SUMMARY.txt).
# Run from packages/daemon, AFTER `pnpm build`. Saturates all CPU cores with busy-loop workers, then runs
# merge-gate-concurrency-verdict.mjs many times in parallel batches, capturing full stdout+stderr per run.
# NEVER run this against a live/shared host — it is deliberately, artificially saturating.
set -euo pipefail
cd "$(dirname "$0")/../../../packages/daemon"

NPROC=$(node -e "console.log(require('os').cpus().length)")
OUTDIR="${1:-/tmp/vr-repro-logs2}"
mkdir -p "$OUTDIR"

BURNSCRIPT=$(mktemp --suffix=.mjs)
cat > "$BURNSCRIPT" <<'EOF'
const end = Date.now() + Number(process.argv[2] || 300000);
while (Date.now() < end) {
  let x = 0;
  for (let i = 0; i < 2_000_000; i++) x += Math.sqrt(i);
}
EOF

BURNPIDS=()
for i in $(seq 1 "$NPROC"); do
  node "$BURNSCRIPT" 600000 >/dev/null 2>&1 &
  BURNPIDS+=($!)
done
echo "started ${#BURNPIDS[@]} CPU-burn workers on $NPROC cores"

TOTAL=0
for round in $(seq 1 20); do
  pids=()
  for lane in a b c d e f; do
    node test/merge-gate-concurrency-verdict.mjs > "$OUTDIR/round${round}-${lane}.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; TOTAL=$((TOTAL+1)); done
  echo "round $round done, total=$TOTAL"
done

for p in "${BURNPIDS[@]}"; do kill "$p" 2>/dev/null || true; done
rm -f "$BURNSCRIPT"
echo "ALL DONE total=$TOTAL"
echo "Check results: grep -l '^FAIL  ' \"$OUTDIR\"/*.log ; grep -l 'TypeError\\|Error:' \"$OUTDIR\"/*.log"
