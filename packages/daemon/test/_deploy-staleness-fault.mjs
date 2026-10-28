// Shared by test/deploy-staleness.mjs AND test/served-status.mjs — card 2888badf.
//
// Card 944eeaed (originally inline in deploy-staleness.mjs; extracted here by card 2888badf so a SECOND
// test file — served-status.mjs's "(4-setup) real-tree probe" — can reuse the identical mechanism instead
// of a second hand-copied hook that would drift from this one on its own clock): a test-only ESM loader
// hook (Node's `node:module` `register()`, stable since Node 20.6 — a genuine module-customization-hooks
// seam, not a mock) that intercepts `node:child_process` ONLY when it's imported by the real compiled
// `dist/deploy-staleness.js` (never by a test file's OWN `execSync`/`execFileSync` import, nor by anything
// else in that process) and swaps in a thin passthrough wrapper around the REAL `execFileSync`. Every call
// that isn't deliberately armed via one of the `globalThis.__ds*Fault` globals below falls straight through
// to the real `execFileSync`, so a scenario that doesn't explicitly arm one of them is byte-for-byte
// unaffected by this hook's mere presence (installing it twice in the same process, e.g. from both
// consumers' own import graphs, is a no-op past the first call — see `installDeployStalenessFaultHook`).
//
// Three independent, one-shot faults, each matched on the exact argv `deploy-staleness.ts`'s own `runGit`
// passes to the real git binary (always `["-C", repoRoot, ...args]` — membership checks below, never a
// position check, because of that leading `-C repoRoot` pair):
//   - `globalThis.__dsGitFault`      — the per-file `git show` calls inside `computeAncestorBehaviouralMatch`
//                                      (matched on `args.includes("show")`).
//   - `globalThis.__dsDiffFault`     — that same function's OWN leading, unconditional `git diff
//                                      --name-status` call (matched on `args.includes("--name-status")`) —
//                                      card 89a454b2: the real-world mechanism that can starve the show-
//                                      fault above of ever firing under genuine host load.
//   - `globalThis.__dsLogFault`      — card 2888badf: either of the two `git log ... -- <pathspecs>` calls
//                                      (the restart-relevant or web-relevant commit history reads — matched
//                                      on `args.includes("log") && args.includes("--")`, which excludes the
//                                      mainline-HEAD `git log -1 ...` call, the one `log` call with no `--`).
//                                      One-shot, so it fires on whichever of the two runs FIRST in a real
//                                      call (the restart-relevant log, which `computeDeployStaleness` always
//                                      issues before the web-relevant one) — the exact call named in both
//                                      "could not read daemon-src/shared commit history" advisories.
// Each fault object is `{armed, fired, maxFires, delayMs}`: `armed` must be true and `fired < maxFires` for
// THIS call to be faulted (so a fault can be scoped to fire exactly once, or never clear, by construction);
// `delayMs` is passed to a synchronous `Atomics.wait` before throwing, so a caller that itself reasons about
// elapsed wall time (as deploy-staleness.mjs's own `computeAtCapWithRetry` does) can make an injected fault
// LOOK as slow as a real scheduling-delayed git call — served-status.mjs's own fault-proof section has no
// such elapsed-time heuristic and is free to arm a short `delayMs` instead.
//
// A bare PATH shim (prepending a directory holding a `git.cmd`/`git.bat` to PATH) does NOT work for this:
// Node's own `execFileSync`/`spawnSync` refuses to resolve a bare command name to a shell file without
// `shell:true` (the CVE-2024-27980 fix) — confirmed empirically while building this fixture, the same
// conclusion 52ce4b2d separately reached for simple-git's own spawn path.
import { register } from "node:module";

// Card 8d8fa497: a MINIMUM attempt count (not a cap — see GIT_TIMEOUT_RETRY_DEADLINE_MS below, for a
// caller that also wants a shared wall-clock ceiling across a nested retry). Renamed from `_MAX_ATTEMPTS`.
export const GIT_TIMEOUT_RETRY_MIN_ATTEMPTS = 3;
// Card 8d8fa497: an OPTIONAL wall-clock deadline (performance.now()-scale) a caller may derive once and pass
// down into every `withGitTimeoutRetry` call it nests, so a combined (outer-retrying-an-inner-retry) budget
// stays time-boxed instead of twice-multiplied. `withGitTimeoutRetry` always makes at least
// GIT_TIMEOUT_RETRY_MIN_ATTEMPTS real attempts regardless of this deadline — a single slow attempt must
// never be reported as "exhausted" having retried zero times.
export const GIT_TIMEOUT_RETRY_DEADLINE_MS = 60_000;

const CP_FAULT_HOOK_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:child_process" && /deploy-staleness\\.js$/.test(context.parentURL ?? "")) {
    return { url: "virtual:deploy-staleness-cp-fault", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === "virtual:deploy-staleness-cp-fault") {
    const src = \`
      import { execFileSync as real } from "node:child_process";
      // Card b5416a46: deploy-staleness.ts now resolves an absolute git.exe on win32 (via
      // resolveGitBinaryForSpawn()) instead of the bare literal "git", so this match can no longer pin an
      // exact string — it matches any path whose basename (case-insensitive, optional .exe) is "git".
      // The backslash count below looks wrong but isn't: this text sits inside TWO nested template
      // literals (this whole CP_FAULT_HOOK_SOURCE string, then this "src" string within it), each of
      // which collapses "\\\\" to one real backslash — verified empirically against the real two-level
      // load path (not just a standalone sweep) before landing; don't "simplify" the backslash count
      // without re-verifying against a live run, the same way this count was derived.
      const isGitBinary = (f) => /(^|[\\\\\\\\/])git(\\\\.exe)?$/i.test(f);
      // Card 89a454b2: a SECOND, independent one-shot fault — globalThis.__dsDiffFault — matched on the
      // literal "--name-status" arg, which (verified: grepped the whole module) is unique to
      // computeAncestorBehaviouralMatch's own LEADING, unconditional git diff --name-status call
      // (deploy-staleness.ts, before the per-file show loop the fault above watches). This simulates a
      // REAL, uninjected ETIMEDOUT on that leading call — the exact mechanism that starves the show-fault
      // below of ever firing under genuine host load (card 89a454b2's own investigation). Checked FIRST,
      // same ordering as production's real call sequence (diff before any show).
      // NOTE: this comment deliberately avoids backtick characters — this text is nested TWO template-
      // literal levels deep (CP_FAULT_HOOK_SOURCE's own literal, then this src literal within it); a single
      // backslash-escaped backtick here only survives the outer level and still closes the INNER literal
      // early, which is exactly the syntax break this note exists to prevent recurring.
      export const execFileSync = (file, args, opts) => {
        const diffFault = globalThis.__dsDiffFault;
        if (diffFault && diffFault.armed && isGitBinary(file) && Array.isArray(args) && args.includes("--name-status") && diffFault.fired < diffFault.maxFires) {
          diffFault.fired++;
          const sab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sab, 0, 0, diffFault.delayMs);
          const err = new Error("spawnSync git ETIMEDOUT");
          err.code = "ETIMEDOUT";
          throw err;
        }
        const fault = globalThis.__dsGitFault;
        if (fault && fault.armed && isGitBinary(file) && Array.isArray(args) && args.includes("show") && fault.fired < fault.maxFires) {
          fault.fired++;
          const sab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sab, 0, 0, fault.delayMs);
          const err = new Error("spawnSync git ETIMEDOUT");
          err.code = "ETIMEDOUT";
          throw err;
        }
        // Card 2888badf: a THIRD, independent one-shot fault — globalThis.__dsLogFault — matched on a
        // "log" call that ALSO carries a "--" pathspec separator, which is unique to the restart-relevant
        // / web-relevant commit-history reads (deploy-staleness.ts) and excludes the mainline-HEAD
        // "git log -1 ..." call (no "--"). Reproduces the exact "could not read daemon-src/shared commit
        // history" / "could not read web-src commit history" ETIMEDOUT advisories deterministically.
        const logFault = globalThis.__dsLogFault;
        if (logFault && logFault.armed && isGitBinary(file) && Array.isArray(args) && args.includes("log") && args.includes("--") && logFault.fired < logFault.maxFires) {
          logFault.fired++;
          const sab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sab, 0, 0, logFault.delayMs);
          const err = new Error("spawnSync git ETIMEDOUT");
          err.code = "ETIMEDOUT";
          throw err;
        }
        return real(file, args, opts);
      };
    \`;
    return { format: "module", source: src, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

let installed = false;
// Idempotent per-process: `register()` installs a process-global loader hook, so a second call (e.g. from
// a second consumer importing this same helper in the same process) is a deliberate no-op rather than a
// duplicate/conflicting registration.
export function installDeployStalenessFaultHook() {
  if (installed) return;
  installed = true;
  register("data:text/javascript," + encodeURIComponent(CP_FAULT_HOOK_SOURCE), import.meta.url);
}

// Card 30dd2dab: unambiguous — computeDeployStaleness's own `unavailable()` call sites set this EXACT
// reasonKind/reason shape only when one of its unconditional `runGit` calls throws (see deploy-staleness.ts's
// own `unavailable()` call sites) — never for an intentional, non-timeout unavailable state (e.g. no .git,
// a missing dist entry), which carry a different reasonKind or reason text and must never be retried.
export const isTransientGitTimeout = (result) =>
  result?.available === false && result?.reasonKind === "could-not-measure" && /ETIMEDOUT/i.test(result?.reason ?? "");

// Generic bounded retry: calls `computeFn(options)`, retrying ONLY while `isTransientGitTimeout` is true,
// for at least GIT_TIMEOUT_RETRY_MIN_ATTEMPTS attempts — a MINIMUM, not a cap: an optional, shared
// `deadlineAt` (performance.now()-scale, passed by a caller that nests this inside its own outer retry) can
// extend the attempt budget further, but never shrink it below the minimum. `onRetry(attempt, result)`, if
// given, is invoked (with the 1-based attempt number that just failed) before each retry — never on the
// final, returned attempt — so a caller can log/count retries without duplicating this loop's own shape.
export function withGitTimeoutRetry(computeFn, options, deadlineAt, onRetry) {
  let attempt = 1;
  for (;;) {
    const result = computeFn(options);
    const deadlinePassed = deadlineAt === undefined || performance.now() >= deadlineAt;
    if (!isTransientGitTimeout(result) || (attempt >= GIT_TIMEOUT_RETRY_MIN_ATTEMPTS && deadlinePassed)) return result;
    if (onRetry) onRetry(attempt, result);
    attempt++;
  }
}
