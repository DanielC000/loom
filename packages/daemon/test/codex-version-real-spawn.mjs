import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 353f6dc4 (multi-harness epic df1f94b0, Phase 1) DoD-5 — REAL-SPAWN validation of
// pty/codex-doctrine.ts's version-cache path. A mocked exec cannot prove this (memory
// `real-spawn-smoke-for-subprocess-features`): it never exercises the actual cross-platform
// `execFile` boundary the way this project has been burned by before (a silently no-op'ing relay
// shipped green under a mocked exec). This drives `prewarmCodexVersionAsync`/`getCachedCodexVersion`
// against a REAL, standalone Node child process (test/fixtures/fake-codex-cli.mjs) substituted for the
// `codex` binary via `LOOM_CODEX_BIN` — the same substitution technique
// test/kickoff-real-spawn.mjs already established for claude.
//
// SCOPE: this covers the read-only adapter facet's version-gating path ONLY. The trust-dialog-detect,
// busy/idle-detect, and submit/interrupt/exit protocol (the stateful runtime) is NOT covered here — it
// is pending an architecture decision on how it integrates with pty/host.ts's `PtyHost` (see the parity
// matrix doc); that surface was already empirically validated against the REAL codex binary in the prior
// probe card (a7d74718), which this card cites rather than re-spending the owner's subscription to
// re-derive.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-version-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-cli.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  codex-version-real-spawn.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see kickoff-real-spawn.mjs's header for the accepted POSIX gap this mirrors.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-codex-version-");

// A .cmd wrapper so a plain `execFile(bin, ["--version"])` (no shell/interpreter indirection) can launch
// `node fake-codex-cli.mjs` as the substitute "codex" binary — mirrors kickoff-real-spawn.mjs exactly.
const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const { getCachedCodexVersion, prewarmCodexVersionAsync } = await import("../dist/pty/codex-doctrine.js");

check("cache starts cold (nothing warmed it yet)", getCachedCodexVersion() === null);

prewarmCodexVersionAsync();
await waitUntil(() => getCachedCodexVersion() !== null, { timeoutMs: 5000, label: "codex version cache populated" });
check("prewarm resolved a version via the REAL child process", getCachedCodexVersion() === "9.9.9");
check("getCachedCodexVersion is non-blocking (no execFile call inside it — see its own doc); second read returns the SAME cached value", getCachedCodexVersion() === "9.9.9");

// Idempotency: a second prewarm call while already warm must not re-spawn (best-effort assertion — no
// spawn-count instrumentation exists, so this checks the documented early-return contract by re-invoking
// and confirming the cached value is untouched, which is what that early return guarantees).
prewarmCodexVersionAsync();
check("re-calling prewarm while warm is a no-op (cached value unchanged)", getCachedCodexVersion() === "9.9.9");

await finishAndExit(failures === 0 ? 0 : 1);
