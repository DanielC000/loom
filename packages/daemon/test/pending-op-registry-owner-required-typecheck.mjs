import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PROVES the TS-ENFORCEMENT HALF of card 94725dcb's RUNTIME-vs-TYPE-SYSTEM split: `owner` is a genuinely
// REQUIRED TypeScript parameter on `PendingOpRegistry.attach()` — tsc must refuse to compile a caller that
// omits it. This is the ONE guarantee the daemon's own test suite (all untyped `.mjs`) cannot otherwise
// exercise, since nothing else in this repo runs `tsc` against a deliberately-bad fixture and checks the
// compiler's own verdict.
//
// Code Review (M3) found the FIRST version of this test's RED fixture omitted `owner` AND
// `onSettledAfterPending` AND `opts` all at once — it "passed" only through a regex quirk (the generic
// "Expected N arguments" diagnostic matches regardless of WHICH trailing argument(s) are missing), so it
// would have stayed green even if `owner` were optional and only the OTHER two were required. Fixed: the
// RED fixture now supplies `onSettledAfterPending`/`opts` explicitly as `undefined` and omits ONLY
// `owner` — isolating the one argument this test claims to be about.
//
// Code Review (second round) then found that this test's own DISCRIMINATING proof — confirming the RED
// fixture compiles clean once `owner` is made optional — temporarily edited the REAL pending-ops.ts
// SOURCE and rebuilt the daemon from inside this committed test file. That is unsafe for a reason
// specific to this project: the merge gate runs test files CONCURRENTLY, in several lanes, against the
// SAME worktree's `dist/` — a test that mutates `src`/rebuilds `dist` at runtime corrupts every OTHER
// test running in parallel in that same worktree, and a crash mid-mutation leaves a broken tree behind
// for the rest of the gate. Tests must treat `src`/`dist` as READ-ONLY, full stop.
//
// THAT discriminating proof (making `owner` optional in the real source, confirming the RED fixture then
// compiles clean, reverting) was therefore run ONCE, by hand, outside this committed test — its output is
// reported in the worker_report for card 94725dcb's Code Review, not re-executed here.
//
// Proves (real `tsc --noEmit` against the REAL, current compiled `.d.ts` — read-only, no source
// mutation, no rebuild):
//   (1) RED: a fixture that calls `attach()` with `owner` OMITTED (and nothing else) fails to compile.
//   (2) GREEN: the IDENTICAL fixture, differing only in that one call supplying `owner`, compiles clean —
//       the negative control proving (1)'s failure is attributable to the missing argument specifically,
//       not some unrelated import/setup problem (a broken import would fail BOTH fixtures identically).
//
// Run: 1) build daemon (pnpm build — the dist/orchestration/pending-ops.d.ts this test type-checks
// against must exist and be current), 2) node packages/daemon/test/pending-op-registry-owner-required-typecheck.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const distPendingOps = fileURLToPath(new URL("../dist/orchestration/pending-ops.js", import.meta.url));
if (!fs.existsSync(distPendingOps.replace(/\.js$/, ".d.ts"))) {
  console.log(`FAIL  dist/orchestration/pending-ops.d.ts not found at ${distPendingOps.replace(/\.js$/, ".d.ts")} — run 'pnpm build' first`);
  process.exit(1);
}

const require_ = createRequire(import.meta.url);
const tscBin = require_.resolve("typescript/bin/tsc");

const scratch = path.join(os.tmpdir(), `loom-porotc-${Date.now()}-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true });

try {
  fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ type: "module" }));
  const importSpecifier = path.relative(scratch, distPendingOps).split(path.sep).join("/");
  const importPath = importSpecifier.startsWith(".") ? importSpecifier : `./${importSpecifier}`;

  // `ownerArg` is appended AFTER an explicit `undefined, undefined` for onSettledAfterPending/opts — so
  // the ONLY thing that varies between the RED and GREEN fixtures is whether `owner` itself is present.
  const fixture = (ownerArg) => `
import { PendingOpRegistry } from "${importPath}";
const registry = new PendingOpRegistry();
async function run(): Promise<void> {
  await registry.attach("k", "spawn", "mgr", 10, async () => ({ ok: true }), undefined, undefined${ownerArg});
}
void run();
`;

  const compile = (file) => {
    try {
      execFileSync(process.execPath, [
        tscBin, "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
        "--moduleResolution", "NodeNext", "--skipLibCheck", "--esModuleInterop", file,
      ], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, output: "" };
    } catch (err) {
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  // (1) RED — owner OMITTED, onSettledAfterPending/opts both explicitly `undefined` (so owner is the
  // ONLY missing argument — see the CR-M3 header note above).
  const redFile = path.join(scratch, "owner-omitted.ts");
  fs.writeFileSync(redFile, fixture(""));
  const red = compile(redFile);
  check("(1) RED: omitting ONLY the required `owner` argument fails to compile", red.ok === false);
  check("(1) [diagnosis] the failure actually names the missing argument (not an unrelated import error)", /Expected \d+ arguments?, but got \d+|is missing in type|Argument of type 'undefined'/.test(red.output));

  // (2) GREEN — IDENTICAL fixture, owner supplied — the negative control.
  const greenFile = path.join(scratch, "owner-supplied.ts");
  fs.writeFileSync(greenFile, fixture(`, { exempt: true, reason: "fixture" }`));
  const green = compile(greenFile);
  check("(2) GREEN: the IDENTICAL fixture WITH `owner` supplied compiles clean — proves (1) is attributable to the missing argument, not a broken import/setup", green.ok === true);
  if (!green.ok) console.log(`  [green fixture tsc output]\n${green.output}`);
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PendingOpRegistry.attach()'s `owner` parameter is a GENUINELY required TypeScript argument: tsc refuses to compile a caller that omits ONLY it, and the identical call compiles clean once `owner` is supplied. The discriminating proof (making `owner` optional in the real source and confirming the SAME red fixture then compiles clean) was run once, by hand, outside this committed test — see this file's own header and the card's worker_report for its output; this file never mutates src/dist or rebuilds the daemon itself."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
