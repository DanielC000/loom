import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 85c3812d: nothing proved an `envOverride` (card 7f96aa09) reaches a REAL spawned child's
// process.env. gate-kill-classify.mjs and worker-run-gate.mjs's "(D2)" scenario both stop at the
// OBJECT `runGateStep` is CALLED WITH (an injected double, or a captured argument) — neither ever
// spawns a real child and reads its real env back. This file closes that ONE hop:
//   gate-runner.ts:514  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...envOverride };
// consumed by the `spawn(command, { ..., env, ... })` call at line 518 — the ONLY place `envOverride`
// reaches a child's environment (confirmed: `grep -rn "\.\.\.envOverride" packages/daemon/src/` returns
// exactly this one line, nothing else).
//
// One real, tiny, hermetic `node -e` spawn closes the gap for BOTH env vars that ride this hop
// (LOOM_GATE_OP_ID and LOOM_GATE_TEST_CONCURRENCY — card 85c3812d DoD-2, "one shared test closes it
// for both, which is why they are one card") AND proves the base `GIT_TERMINAL_PROMPT:"0"` survives
// the override spread (DoD-3: "a test that checks only one key would pass while the merge silently
// clobbered the other"). Never touches the live NDJSON sink or the real LOOM_HOME.
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/gate-runner-envoverride-spawn.mjs
import { runGateStep } from "../dist/orchestration/gate-runner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The child prints a ONE-LINE JSON object naming all three vars it actually received. `outputTail` on
// the green path is `tail()` — a bounded TAIL of captured stdout, not "the full stream" (it can be
// truncated for a large run) — but this one short line can never approach that cap, so it is always
// present in full here.
const PRINT_SCRIPT =
  "console.log(JSON.stringify({op:process.env.LOOM_GATE_OP_ID,conc:process.env.LOOM_GATE_TEST_CONCURRENCY,git:process.env.GIT_TERMINAL_PROMPT}))";

{
  const envOverride = { LOOM_GATE_OP_ID: "test-op-85c3812d", LOOM_GATE_TEST_CONCURRENCY: "3" };
  const timeoutMs = 15_000;
  const result = await runGateStep(`node -e "${PRINT_SCRIPT}"`, process.cwd(), timeoutMs, envOverride);
  check("(spawn) the real child exited cleanly (status:0)", result.status === 0);
  let seen;
  try { seen = JSON.parse((result.outputTail ?? "").trim()); } catch { seen = undefined; }
  check("(spawn) the real child's process.env actually received LOOM_GATE_OP_ID from envOverride", seen?.op === "test-op-85c3812d");
  check("(spawn) the SAME real child ALSO received LOOM_GATE_TEST_CONCURRENCY from envOverride (one spawn closes both gaps)", seen?.conc === "3");
  check("(spawn) the base GIT_TERMINAL_PROMPT:\"0\" survives the envOverride spread (not clobbered by it)", seen?.git === "0");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — envOverride's LOOM_GATE_OP_ID and LOOM_GATE_TEST_CONCURRENCY both reach a REAL spawned child's process.env via gate-runner.ts's envOverride spread, and the base GIT_TERMINAL_PROMPT survives the merge."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
