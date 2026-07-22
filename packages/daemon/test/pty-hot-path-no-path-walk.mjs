import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3e429d83 (retitled: guard the spawn hot path against a synchronous PATH walk).
//
// BACKGROUND: `CLAUDE.md`'s load-bearing invariant is "the spawn HOT PATH (`createPty` →
// `buildMcpServers`) does NO blocking work". `resolveExecutable` (pty/resolve-bin.ts) is a SYNCHRONOUS
// walk of every PATH dir × every PATHEXT extension — on this dev box's real Windows PATH (69 dirs × 14
// extensions ≈ 966 `existsSync` calls), a single COLD negative resolution measured ~17-20ms. That is a
// real synchronous stall if it ever lands on the hot path for a normal spawn.
//
// It does not today: `buildMcpServers`'s codescape mount is gated behind THREE short-circuits —
// `o.codescapeEnabled` (per-project, default false) → `isLoomDev()` (env, default off, never true for a
// shipped loomctl install) → `isCodescapeSupervisorEnabled` (which itself checks `isLoomDev()` again
// before touching the filesystem) — so for a normal/vanilla spawn, `resolveExecutable`/`hostToolBinExists`
// never run at all. That safety comes from TWO INDEPENDENT LAYERS: `host.ts`'s own outer ordering, AND
// `isCodescapeSupervisorEnabled`'s internal `isLoomDev()` re-check — a regression has to defeat BOTH to
// actually reach the filesystem.
//
// THIS TEST GUARDS THE INVARIANT ("no PATH walk on the hot path for a normal spawn"), NOT the outer
// ordering specifically. It reddens on anything that actually causes the walk — confirmed by fail-first
// testing: bypassing `isCodescapeSupervisorEnabled` entirely (calling `hostToolBinExists`/
// `codescapeBinCandidate` directly, unconditionally — i.e. defeating BOTH layers, as removing/inlining the
// inner `isLoomDev()` short-circuit would) turned this test red (2898/2901 matching calls). It will NOT
// catch a reorder of just `host.ts`'s outer gate alone — the inner short-circuit in
// `isCodescapeSupervisorEnabled` still prevents the walk, so that case is harmless and the test correctly
// stays green. Don't read this test's silence on such a reorder as proof nothing changed.
//
// Mechanism: spy on the real `fs.existsSync` (mutating the shared `node:fs` default-export object — both
// this test file and the compiled dist's `import fs from "node:fs"` reference the SAME object, so the
// patch is visible process-wide) and count only calls whose path is shaped like resolveExecutable's own
// PATH-walk candidates for the bare "codescape" bin name (`.../codescape` or `.../codescape.<ext>`,
// case-insensitive) — a signature unique to that walk, so it can't false-positive on unrelated existsSync
// traffic (e.g. capability/venv resolution) that buildMcpServers also performs.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-hot-path-no-path-walk.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME, matching every other in-process pty/host test in this suite. ---
const tmpHome = path.join(os.tmpdir(), `loom-hotpath-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The true default-off state — strip anything this test process may have inherited (e.g. running inside
// a LOOM_DEV=1 self-hosting/orchestration shell) so the negative case below is genuine, not accidental.
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_CODESCAPE_BIN;

const { buildMcpServers } = await import("../dist/pty/host.js");

// Matches resolveExecutable's candidate shape for the bare "codescape" bin name: `<dir>/codescape` (POSIX,
// no PATHEXT) or `<dir>\codescape.EXE` etc (Windows) — case-insensitive PATHEXT.
const CODESCAPE_WALK_CANDIDATE_RE = /[\\/]codescape(\.[A-Za-z0-9]+)?$/i;

let walkCandidateCalls = 0;
let totalCalls = 0;
const originalExistsSync = fs.existsSync;
fs.existsSync = (p) => {
  totalCalls++;
  if (typeof p === "string" && CODESCAPE_WALK_CANDIDATE_RE.test(p)) walkCandidateCalls++;
  return originalExistsSync(p);
};

try {
  // A normal worker spawn — codescapeEnabled explicitly false, and (separately) simply unset. Neither
  // should ever reach the PATH-walk candidate shape, LOOM_DEV off (the vanilla-install state) or not.
  buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", repoPath: "/some/repo", codescapeEnabled: false });
  buildMcpServers({ sessionId: "s2", port: 4317, role: "worker", repoPath: "/some/repo" });
  buildMcpServers({ sessionId: "s3", port: 4317, role: "manager", repoPath: "/some/repo", codescapeEnabled: false });

  check(
    `(guard) normal non-dev spawns never reach resolveExecutable's PATH-walk for "codescape" (saw ${walkCandidateCalls} matching existsSync call(s) out of ${totalCalls} total)`,
    walkCandidateCalls === 0,
  );
} finally {
  fs.existsSync = originalExistsSync;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the spawn hot path (buildMcpServers) never reaches resolveExecutable's synchronous PATH walk for a normal (non-codescape-enabled / non-LOOM_DEV) spawn. See host.ts's gate-ordering comment above the codescape mount for why this must stay true."
  : `\n❌ ${failures} FAILURE(S) — the spawn hot path performed a synchronous PATH walk (fs/pty/resolve-bin.ts's resolveExecutable) during a normal spawn. This regresses the load-bearing 'no blocking work on the hot path' invariant (CLAUDE.md) — check whether host.ts's codescape gate ordering (o.codescapeEnabled && o.repoPath → isLoomDev() → isCodescapeSupervisorEnabled) was changed or reordered.`);
process.exit(failures === 0 ? 0 : 1);
