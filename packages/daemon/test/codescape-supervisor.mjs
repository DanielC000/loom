import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape fleet-daemon supervisor (card 894b9b02, epic 369dde3c C1 — FOUNDATION). REAL-SPAWN, hermetic:
// a fixture `codescape` CLI (test/fixtures/fake-codescape-cli.mjs, invoked via node — no shell, no real
// codescape install needed) stands in for the real binary. Claude-free, network-free (the control-plane
// client is exercised against a fake in-process http.Server, never a real Codescape serve).
//
// Proves the DoD:
//   (neg)   LOOM_DEV unset ⇒ the supervisor NEVER spawns anything: getPort()/getPid() stay null, no
//           fake-codescape-calls.jsonl is ever written, boot is behaviorally byte-identical to today.
//   (a)     with LOOM_DEV=1 + a codescape CLI actually resolvable (card 503a30a0: host-CLI-PRESENCE is
//           the gate now, not a hand-set LOOM_CODESCAPE_ENABLED toggle): ingest runs (one call recorded),
//           THEN serve spawns on the loopback port getPort() returns — and BOTH ran from the exact SAME
//           shared cwd (the CWD CONTRACT).
//   (b)     killing the live child triggers a BOUNDED restart: a fresh serve call is recorded (new pid),
//           reusing the SAME port, without the caller doing anything.
//   (c)     stop() disarms restart-on-death and clears getPort()/getPid().
//   (d)     the control-plane client methods (registerWorktree/reingestMain/dropWorktree/overlay) hit the
//           right method+URL+body on a fake HTTP server, resolve `{ok:false}` (never throw) against an
//           unreachable port within their own bound, and short-circuit instantly with no live port at all.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-supervisor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

// --- Hermetic LOOM_HOME, set BEFORE importing dist (CODESCAPE_HOME_DIR derives from it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The isLoomDev()/isCodescapeSupervisorEnabled() checks below need the TRUE default-off state — delete
// any inherited flags (e.g. this test running inside a LOOM_DEV=1 self-hosting shell).
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_CODESCAPE_BIN;

const { CodescapeSupervisor, codescapeBootRepoPaths } = await import("../dist/codescape/supervisor.js");
const { isLoomDev, isCodescapeSupervisorEnabled, resolveCodescapeBin, CODESCAPE_HOME_DIR } = await import("../dist/paths.js");

// ===================== CR fix (blocker 1): codescapeBootRepoPaths — the boot-ingest project filter =====================
// Pure, hermetic, no live db — plain project-shaped objects. Proves the boot-ingest gap fix: a project
// whose RESOLVED codescape.enabled is true contributes its repoPath; everything else is filtered out.
check("(boot-ingest) no projects ⇒ []", JSON.stringify(codescapeBootRepoPaths([])) === "[]");
check("(boot-ingest) a project with no config override (default codescape.enabled=false) is excluded",
  JSON.stringify(codescapeBootRepoPaths([{ repoPath: "/repo/a" }])) === "[]");
check("(boot-ingest) codescape.enabled explicitly false is excluded",
  JSON.stringify(codescapeBootRepoPaths([{ repoPath: "/repo/a", config: { codescape: { enabled: false } } }])) === "[]");
check("(boot-ingest) codescape.enabled true contributes its repoPath",
  JSON.stringify(codescapeBootRepoPaths([{ repoPath: "/repo/a", config: { codescape: { enabled: true } } }])) === JSON.stringify(["/repo/a"]));
check("(boot-ingest) mixed set: only the enabled projects' repoPaths, in list order",
  JSON.stringify(codescapeBootRepoPaths([
    { repoPath: "/repo/a", config: { codescape: { enabled: true } } },
    { repoPath: "/repo/b", config: { codescape: { enabled: false } } },
    { repoPath: "/repo/c" },
    { repoPath: "/repo/d", config: { codescape: { enabled: true } } },
  ])) === JSON.stringify(["/repo/a", "/repo/d"]));

// ===================== paths.ts resolvers (claude-free, pure) =====================
check("(resolver) CODESCAPE_HOME_DIR derives from LOOM_HOME", CODESCAPE_HOME_DIR === path.join(tmpHome, "codescape"));
check("(resolver) resolveCodescapeBin() with no override falls back to the bare 'codescape' command",
  (() => { const r = resolveCodescapeBin(); return r.command !== process.execPath && r.args.length === 0; })());
process.env.LOOM_CODESCAPE_BIN = fixtureCli;
const resolvedBin = resolveCodescapeBin();
check("(resolver) a .mjs override resolves to {command: node, args:[fixture]} (node-invocation shape)",
  resolvedBin.command === process.execPath && JSON.stringify(resolvedBin.args) === JSON.stringify([fixtureCli]));

// ===================== (neg) LOOM_DEV unset — the hard negative case =====================
check("(neg) isLoomDev() is FALSE by default", isLoomDev() === false);
check("(neg) isCodescapeSupervisorEnabled() is FALSE by default (even with the fixture CLI resolvable)", isCodescapeSupervisorEnabled() === false);
const negHomeDir = path.join(tmpHome, "neg-home");
const negSup = new CodescapeSupervisor({ homeDir: negHomeDir });
await negSup.start(["/some/repo"]);
check("(neg) start() with LOOM_DEV unset never spawns — getPort() is null", negSup.getPort() === null);
check("(neg) start() with LOOM_DEV unset never spawns — getPid() is null", negSup.getPid() === null);
check("(neg) start() with LOOM_DEV unset never creates the home dir (zero side effects)", !fs.existsSync(negHomeDir));

// ===================== (neg2) LOOM_DEV on but NO codescape CLI resolvable — host-CLI-PRESENCE is the =====
// ===================== actual gate now (card 503a30a0), not a hand-set env toggle =====================
process.env.LOOM_DEV = "1";
{
  const savedBin = process.env.LOOM_CODESCAPE_BIN;
  delete process.env.LOOM_CODESCAPE_BIN;
  check("(neg2) LOOM_DEV=1 but no codescape CLI resolvable at all ⇒ still disabled",
    isCodescapeSupervisorEnabled() === false);
  process.env.LOOM_CODESCAPE_BIN = savedBin;
}

// ===================== (gate) enable: LOOM_DEV=1 + a resolvable codescape CLI (card 503a30a0) =====================
// No separate hand-set toggle needed — the fixture CLI standing in for a real installed binary is enough
// once LOOM_DEV is on. This is the whole point of the fix: on the owner's own dev machine (which actually
// has the CLI), this activates automatically; on a vanilla end-user host (which never does), it stays off.
check("(gate) isCodescapeSupervisorEnabled() is TRUE once LOOM_DEV=1 AND the fixture CLI is resolvable",
  isLoomDev() === true && isCodescapeSupervisorEnabled() === true);

// ===================== (dbPath) card b8de5876: the boot gate must honor a DB-persisted path with NO =====
// ===================== global CLI/env var configured — the exact bug: boot's start() used to call ========
// ===================== isCodescapeSupervisorEnabled()/resolveCodescapeBin() with NO dbPath at all, so a ===
// ===================== host configured ONLY via `integrations.codescape.path` (no LOOM_CODESCAPE_BIN, no ==
// ===================== global install) logged "codescape off" at boot forever, while the per-spawn seam ==
// ===================== (pty/host.ts) — which DID thread the DB path — went on to conclude "enabled", =====
// ===================== disagreeing within the same boot. This section proves dbPath ALONE (env unset) ====
// ===================== both satisfies the gate AND is what start()/spawnServe() actually spawn with. ======
{
  const savedBin = process.env.LOOM_CODESCAPE_BIN;
  delete process.env.LOOM_CODESCAPE_BIN;

  check("(dbPath) with no dbPath and no env var, the gate is FALSE (no global CLI on this host)",
    isCodescapeSupervisorEnabled() === false);
  check("(dbPath) isCodescapeSupervisorEnabled(fixtureCli) is TRUE — a DB path ALONE satisfies the gate, no env var needed",
    isCodescapeSupervisorEnabled(fixtureCli) === true);

  const dbPathHomeDir = path.join(tmpHome, "dbpath-home");
  const dbPathCallsFile = path.join(dbPathHomeDir, "fake-codescape-calls.jsonl");
  const readDbPathCalls = () => fs.existsSync(dbPathCallsFile)
    ? fs.readFileSync(dbPathCallsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const dbPathSup = new CodescapeSupervisor({ homeDir: dbPathHomeDir, ingestTimeoutMs: 15_000 });
  // The regression: `start()` used to take only `repoPaths` — a caller passing a 2nd arg here would have
  // had it silently ignored, `isCodescapeSupervisorEnabled()` would run with NO dbPath, see no env var and
  // no global "codescape" on PATH, and never spawn at all (this exact assertion block fails RED against
  // the pre-fix code — verified by temporarily reverting supervisor.ts's `start`/`ingest`/`spawnServe`).
  await dbPathSup.start(["/fake/repo/dbpath"], fixtureCli);
  for (let i = 0; i < 50 && readDbPathCalls().length < 2; i++) await sleep(50);
  const dbPathCalls = readDbPathCalls();
  check("(dbPath) start(repoPaths, dbPath) with ONLY a dbPath (no env var) actually ingests+spawns serve",
    dbPathCalls.length === 2 && dbPathCalls[0]?.cmd === "ingest" && dbPathCalls[1]?.cmd === "serve");
  check("(dbPath) getPort() is live — the DB-path-only configuration reached spawnServe, not just the gate check",
    typeof dbPathSup.getPort() === "number" && dbPathSup.getPort() > 0);

  // Restart-on-death must ALSO keep using the remembered dbPath (spawnServe runs off a setTimeout, long
  // after start()'s own call stack returned) — kill the child and confirm the respawn still uses the
  // fixture CLI, not a silent fallback to bare "codescape" (which would fail the enablement gate entirely
  // were it re-checked, but spawnServe doesn't re-check — it would just try to spawn the wrong binary).
  const dbPathPidBefore = dbPathSup.getPid();
  process.kill(dbPathPidBefore);
  for (let i = 0; i < 100 && readDbPathCalls().length < 3; i++) await sleep(50);
  check("(dbPath) restart-on-death respawns using the SAME remembered dbPath (a 3rd 'serve' call recorded, new pid)",
    readDbPathCalls().length === 3 && readDbPathCalls()[2]?.cmd === "serve" && dbPathSup.getPid() !== dbPathPidBefore);

  dbPathSup.stop();
  process.env.LOOM_CODESCAPE_BIN = savedBin;
}

// ===================== (a) REAL-SPAWN: ingest-then-serve, shared cwd =====================
const homeDir = path.join(tmpHome, "codescape-home");
const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
const readCalls = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const sup = new CodescapeSupervisor({
  homeDir,
  restartBackoffMs: [150, 250, 400], // fast — this test proves restart-on-death without waiting real minutes
  healthyRunMs: 60_000, // never hit "healthy" mid-test — keeps the attempt counter deterministic
  ingestTimeoutMs: 15_000,
});

await sup.start(["/fake/repo/one"]);
// Give the long-lived `serve` fixture a moment to actually spawn + write its call record.
for (let i = 0; i < 50 && readCalls().length < 2; i++) await sleep(50);

const calls1 = readCalls();
check("(a) exactly 2 calls recorded (1 ingest + 1 serve)", calls1.length === 2);
check("(a) call 1 is 'ingest /fake/repo/one'", calls1[0]?.cmd === "ingest" && calls1[0]?.repoPath === "/fake/repo/one");
check("(a) call 2 is 'serve'", calls1[1]?.cmd === "serve");
check("(a) getPort() returns a live numeric port", typeof sup.getPort() === "number" && sup.getPort() > 0);
check("(a) the serve call's --port matches getPort()", Number(calls1[1]?.port) === sup.getPort());
check("(a) getPid() returns the live child's pid", typeof sup.getPid() === "number" && sup.getPid() > 0);
check("(a) CWD CONTRACT: ingest ran from the shared homeDir",
  path.resolve(calls1[0]?.cwd || "") === path.resolve(homeDir));
check("(a) CWD CONTRACT: serve ran from the SAME shared homeDir as ingest",
  calls1[0]?.cwd === calls1[1]?.cwd);

// ===================== (a2) getHomeDir() (P4 wiring, card 088afc94) =====================
// Exposes the shared ingest+serve cwd so a caller resolving codescape's OWN project id (manifest.ts
// `resolveCodescapeProjectId`) reads the manifest from the SAME homeDir this instance actually ingests
// into — a test-only supervisor with a custom homeDir must not silently fall back to the daemon default.
check("(a2) getHomeDir() returns the SAME homeDir this instance was constructed with", sup.getHomeDir() === homeDir);
const otherHomeSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "some-other-home") });
check("(a2) getHomeDir() differs across two independently-constructed instances",
  otherHomeSup.getHomeDir() !== sup.getHomeDir() && otherHomeSup.getHomeDir() === path.join(tmpHome, "some-other-home"));

// ===================== (a3) registerProject / resolveProjectId (P4 follow-up, card 088afc94) =====================
// `sup.start(["/fake/repo/one"])` above already ran the NEW boot-time registration loop internally (after
// spawnServe, with a bounded retry for the spawn-race — see registerProjectWithRetry's doc) against the
// fixture's now-REAL minimal HTTP listener (see fake-codescape-cli.mjs). So resolveProjectId for that
// repo should already be CACHED, with no further network call needed.
const bootRegisteredId = sup.resolveProjectId("/fake/repo/one");
check("(a3) resolveProjectId resolves the repo registered at boot (from the in-memory cache, no manifest needed)",
  typeof bootRegisteredId === "string" && bootRegisteredId.length > 0);

// Re-registering the SAME repoRoot the boot loop already registered is idempotent: same id, mode flips
// to "already-registered" (the fixture's own registered-repoRoot tracking).
const reReg = await sup.registerProject("/fake/repo/one");
check("(a3) re-registering an already-boot-registered repo resolves ok:true", reReg.ok === true);
check("(a3) mode is 'already-registered' (idempotent, matches the fixture's own tracking)", reReg.json?.mode === "already-registered");
check("(a3) the id is STABLE across calls", reReg.json?.id === bootRegisteredId);

// A brand-new repo (never passed to start(), never registered before) registers fresh via POST /project
// directly — proves registerProject works standalone, not just via the boot loop.
const freshRepo = "/fake/repo/three";
check("(a3) resolveProjectId for an unregistered repo returns null BEFORE any registerProject call (no cache, no manifest)",
  sup.resolveProjectId(freshRepo) === null);
const freshReg = await sup.registerProject(freshRepo);
check("(a3) registerProject on a brand-new repo resolves ok:true", freshReg.ok === true);
check("(a3) mode is 'ingested' (first time this repoRoot is seen)", freshReg.json?.mode === "ingested");
check("(a3) its id DIFFERS from the boot-registered repo's id (distinct repos, distinct ids)", freshReg.json?.id !== bootRegisteredId);
check("(a3) resolveProjectId now resolves it from the cache (no further network call needed)",
  sup.resolveProjectId(freshRepo) === freshReg.json?.id);

// ===================== (a4) resolveProjectId cache-miss falls back to the cold manifest read =====================
// A FRESH supervisor instance (empty cache) pointed at a homeDir whose manifest already has an entry —
// mirrors a daemon restart: the in-memory cache is gone, but codescape's own manifest file survives.
{
  const fallbackHomeDir = path.join(tmpHome, "fallback-home");
  const manifestDir = path.join(fallbackHomeDir, ".codescape", "projects");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "index.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "manifest-only-id-123", name: "x", path: "/fake/repo/four", lastIngested: new Date(0).toISOString(), graphPath: "/x/graph.json" }],
  }));
  const freshSup = new CodescapeSupervisor({ homeDir: fallbackHomeDir }); // no port — never started, empty cache
  check("(a4) a fresh instance's empty cache falls back to the manifest for a repo it never registered itself",
    freshSup.resolveProjectId("/fake/repo/four") === "manifest-only-id-123");
  check("(a4) a repo with NEITHER a cache entry NOR a manifest entry resolves null (honest, not a guess)",
    freshSup.resolveProjectId("/fake/repo/five") === null);
}

// ===================== (a5) registerProject failure paths never throw, never cache a bad result =====================
{
  const neverStartedSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "never-started-for-register") });
  const noPortReg = await neverStartedSup.registerProject("/fake/repo/six");
  check("(a5) registerProject with no live port resolves ok:false (never throws)", noPortReg.ok === false);
  check("(a5) nothing gets cached on failure", neverStartedSup.resolveProjectId("/fake/repo/six") === null);
}

// ===================== (a5b) CR fix (item 1): resolveProjectId caches a manifest HIT too, not just a =====
// ===================== registerProject success — the spawn hot path must not re-read the manifest file ===
// ===================== on every single lookup once a repo's id is already known. ==========================
{
  const cacheHomeDir = path.join(tmpHome, "manifest-cache-home");
  const cacheManifestDir = path.join(cacheHomeDir, ".codescape", "projects");
  fs.mkdirSync(cacheManifestDir, { recursive: true });
  fs.writeFileSync(path.join(cacheManifestDir, "index.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "cache-hit-id-789", name: "y", path: "/fake/repo/cache-hit", lastIngested: new Date(0).toISOString(), graphPath: "/x/graph.json" }],
  }));
  const cacheSup = new CodescapeSupervisor({ homeDir: cacheHomeDir });
  check("(a5b) first call resolves via the manifest", cacheSup.resolveProjectId("/fake/repo/cache-hit") === "cache-hit-id-789");
  // Delete the manifest file entirely — if the SECOND call still resolves the id, it can only be serving
  // it from the in-memory cache the first call populated, never re-reading the (now-gone) file.
  fs.rmSync(path.join(cacheManifestDir, "index.json"));
  check("(a5b) a SECOND call still resolves the SAME id after the manifest file is deleted (served from cache, no re-read)",
    cacheSup.resolveProjectId("/fake/repo/cache-hit") === "cache-hit-id-789");
}

// ===================== (a5c) CR fix (item 1): resolveProjectId caches a MISS too, bounded by a TTL (test =
// ===================== seam negativeCacheTtlMs shrinks it so this doesn't wait 30 real seconds) ============
{
  const negCacheHomeDir = path.join(tmpHome, "negative-cache-home");
  const NEG_TTL_MS = 200;
  const negSup2 = new CodescapeSupervisor({ homeDir: negCacheHomeDir, negativeCacheTtlMs: NEG_TTL_MS }); // no manifest at all yet
  check("(a5c) a repo with no manifest at all resolves null (nothing to cache positively)",
    negSup2.resolveProjectId("/fake/repo/late-ingest") === null);
  // Simulate the repo getting ingested WHILE the negative TTL is still live — this proves the miss is
  // genuinely being served from the negative cache (not re-reading the manifest every call): if it were
  // re-reading, this would immediately pick up the new entry instead of staying null.
  const negManifestDir = path.join(negCacheHomeDir, ".codescape", "projects");
  fs.mkdirSync(negManifestDir, { recursive: true });
  fs.writeFileSync(path.join(negManifestDir, "index.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "late-ingest-id", name: "z", path: "/fake/repo/late-ingest", lastIngested: new Date(0).toISOString(), graphPath: "/x/graph.json" }],
  }));
  check("(a5c) immediately after: STILL null — the negative cache is honored, not re-reading every call",
    negSup2.resolveProjectId("/fake/repo/late-ingest") === null);
  // Once the (short, test-only) TTL expires, the NEXT call is allowed to re-read the manifest and pick up
  // the now-real entry — proving the cache is a BOUNDED TTL, not a permanent negative result.
  await sleep(NEG_TTL_MS + 100);
  check("(a5c) after the negative TTL expires, the SAME repo now resolves the newly-ingested id",
    negSup2.resolveProjectId("/fake/repo/late-ingest") === "late-ingest-id");
}

// ===================== (a5d) nitpick fix: the projectIds/unresolvedProjectIds cache key is normalized =====
// ===================== case-insensitively — consistent with manifest.ts's own samePath matching ===========
{
  const caseHomeDir = path.join(tmpHome, "case-cache-home");
  const caseManifestDir = path.join(caseHomeDir, ".codescape", "projects");
  fs.mkdirSync(caseManifestDir, { recursive: true });
  fs.writeFileSync(path.join(caseManifestDir, "index.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "case-id-abc", name: "c", path: "/Fake/Repo/Case-Test", lastIngested: new Date(0).toISOString(), graphPath: "/x/graph.json" }],
  }));
  const caseSup = new CodescapeSupervisor({ homeDir: caseHomeDir });
  check("(a5d) first call (exact case) resolves via the manifest", caseSup.resolveProjectId("/Fake/Repo/Case-Test") === "case-id-abc");
  fs.rmSync(path.join(caseManifestDir, "index.json"));
  check("(a5d) a DIFFERENTLY-CASED lookup of the SAME repo still hits the cache (no re-read of the now-gone manifest)",
    caseSup.resolveProjectId("/fake/repo/case-test") === "case-id-abc");
}

// ===================== (a6b) nitpick fix: registerProjectWithRetry does NOT sleep after the FINAL failed =====
// ===================== attempt — a single-attempt call against a refusing port returns near-instantly, ====
// ===================== not delayMs later (proving the trailing sleep guard actually skips) ==================
{
  const neverListeningSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "never-listening-for-retry") });
  const t0b = Date.now();
  const singleAttempt = await neverListeningSup.registerProjectWithRetry("/fake/repo/never-listening", 1, 5_000); // 1 attempt, would-be 5s trailing sleep if not guarded
  const elapsedB = Date.now() - t0b;
  check("(a6b) single-attempt registerProjectWithRetry resolves ok:false (no live port)", singleAttempt.ok === false);
  check(`(a6b) resolves near-instantly (${elapsedB}ms), NOT after the delayMs trailing sleep that would follow a non-final attempt`,
    elapsedB < 2_000);
}

// ===================== (a6) registerProjectWithRetry bounds EACH attempt at the SHORT registerTimeoutMs, =====
// ===================== NOT the much larger ingestTimeoutMs — a hung (not refused) connection can't stack =====
// ===================== retries into a long wait (manager follow-up question on card 088afc94) ==============
// A server that ACCEPTS the connection but never responds — the only way to prove a bound is actually
// enforced (a fast connection-refused would pass even with the wrong, larger timeout wired in by
// mistake — see the (d-hang) section below for the same technique). `ingestTimeoutMs` is set deliberately
// large (30s) so this test would take at least 2×30s if the retry loop ever fell back to using it instead
// of the short `registerTimeoutMs` — this is a FALSIFIABLE proof, not just an assertion.
{
  const hungServer = http.createServer(() => { /* never responds — simulates a hung/wedged codescape serve */ });
  await new Promise((resolve) => hungServer.listen(0, "127.0.0.1", resolve));
  const hungPort = hungServer.address().port;
  const RETRY_TIMEOUT_MS = 300;
  const retrySup = new CodescapeSupervisor({ port: hungPort, registerTimeoutMs: RETRY_TIMEOUT_MS, ingestTimeoutMs: 30_000 });
  const t0 = Date.now();
  const result = await retrySup.registerProjectWithRetry("/fake/repo/hung", 2, 50); // 2 attempts, 50ms apart
  const elapsed = Date.now() - t0;
  check("(a6) registerProjectWithRetry resolves ok:false against a hung server (never throws)", result.ok === false);
  check(`(a6) both attempts bounded at registerTimeoutMs (~${RETRY_TIMEOUT_MS}ms each), NOT ingestTimeoutMs (30s) — elapsed ${elapsed}ms for 2 attempts, well under the 30s a single wrongly-bounded attempt would already take`,
    elapsed < 10_000);
  hungServer.closeAllConnections();
  await new Promise((resolve) => hungServer.close(resolve));
}

// ===================== (b) restart-on-death: bounded, same port, new pid =====================
const portBefore = sup.getPort();
const pidBefore = sup.getPid();
process.kill(pidBefore); // simulate a crash — NOT supervisor.stop()

// Wait for the FIXTURE's own respawned process to actually run and append its call record — getPid()
// flips to the new child's pid synchronously on spawn, well before that child's script has executed, so
// poll the call log itself (the actual observable proof of a restart), not just the pid.
for (let i = 0; i < 100 && readCalls().length < 3; i++) await sleep(50);

check("(b) after the kill, a NEW serve call is recorded (a real restart happened)", readCalls().length === 3);
const calls2 = readCalls();
check("(b) the 3rd call is another 'serve'", calls2[2]?.cmd === "serve");
check("(b) restart reused the SAME port", sup.getPort() === portBefore);
check("(b) restart produced a DIFFERENT pid (a genuinely new process)", sup.getPid() !== pidBefore && sup.getPid() !== null);
check("(b) the restarted serve ran from the SAME shared homeDir", calls2[2]?.cwd === calls2[0]?.cwd);

// ===================== (c) stop() disarms restart + clears state =====================
sup.stop();
check("(c) stop() clears getPort()", sup.getPort() === null);
check("(c) stop() clears getPid()", sup.getPid() === null);
await sleep(600); // longer than the fast backoff schedule — prove NO further restart happens post-stop
const callsAfterStop = readCalls().length;
await sleep(300);
check("(c) no further serve call is recorded after stop() (restart-on-death is disarmed)",
  readCalls().length === callsAfterStop);

// ===================== (bad-bin) CR fix: repeated spawn death must give up, never phantom-alive =========
// The negative spawn-failure case the original test never exercised (the CR-flagged gap): repeated
// restart-on-death must give up (not phantom-alive) once the bounded backoff schedule is exhausted.
// Card 503a30a0 NOTE: this used to point LOOM_CODESCAPE_BIN at a NONEXISTENT path to force an ENOENT
// spawn-level 'error' — that specific trigger is no longer reachable through the public API now that CLI
// PRESENCE is itself the enablement gate (a nonexistent bin now fails the OUTER gate in start()/ingest(),
// so spawnServe is never even reached — arguably better production behavior, since a misconfigured path
// now refuses cleanly instead of attempting and failing). What's still exercised here instead: the SAME
// scheduleRestart give-up-after-N-attempts logic, reached via REPEATED real deaths (the working fixture
// CLI, killed over and over) rather than a single ENOENT — `onDeath` wires BOTH child.on("error",...) and
// child.on("exit",...) to the identical handler (see spawnServe's own doc), so this still proves the give-up
// bound genuinely fires and stays down; only the specific "spawn never even started" flavor of death is
// no longer independently triggerable from outside the class.
//
// Card 5dd77ba5 fix: the rewrite above (a real-kill loop) gated its kills on blind sleep(80) +
// getPort()!==null polling — but getPort()===null is AMBIGUOUS: it reads identically whether the
// supervisor has genuinely given up (this.port cleared, no timer pending — permanent) or is merely
// transiently down BETWEEN a kill and its already-SCHEDULED restart (this.alive false for the ~50ms
// backoff delay — temporary). Instrumented measurement: that transient window runs 50-74ms against the
// old 80ms budget — as little as 6ms of margin — so on a slower/loaded host the outer loop can sample
// mid-transient, conclude "gave up" after too FEW kills to actually exhaust the schedule, and then have
// the trailing sleep(300) catch the still-pending LEGITIMATE restart firing: a real restart misread as a
// "stray" one. Fix: never infer state from getPort() timing — gate every kill on the calls-file record
// (the SAME technique section (b) above already uses to detect a real restart), so each kill always lands
// on the actually-running child and the loop always performs EXACTLY 1 initial + restartBackoffMs.length
// restart kills — no more, no less — deterministically exhausting the schedule regardless of host speed.
// The final "stays down" check is then a genuinely non-racy NEGATIVE assertion: scheduleRestart's give-up
// branch (supervisor.ts) returns before ever reaching its `setTimeout` — so once give-up is reached there
// is structurally no pending timer left that could revive it; the trailing wait only needs to be long
// enough to notice a regression, not to out-race a real one.
const badBinHomeDir = path.join(tmpHome, "bad-bin-home");
const badBinCallsFile = path.join(badBinHomeDir, "fake-codescape-calls.jsonl");
const readBadBinCalls = () => fs.existsSync(badBinCallsFile)
  ? fs.readFileSync(badBinCallsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const badBinBackoffMs = [50, 50, 50]; // fast + few — prove the give-up bound without a long wait
const badBinSup = new CodescapeSupervisor({
  homeDir: badBinHomeDir,
  restartBackoffMs: badBinBackoffMs,
  healthyRunMs: 60_000, // never long enough to count a kill-right-after-spawn as "healthy"
});
await badBinSup.start(); // the fixture CLI is enabled (LOOM_CODESCAPE_BIN still fixtureCli) — spawns for real

// Kill exactly 1 (initial) + badBinBackoffMs.length (restarts) times — the precise count that exhausts the
// bounded schedule — gating each kill on the calls-file record actually appearing (never a blind sleep),
// so the pid killed is always the currently-live child and the number of kills always lands exactly on
// the schedule's boundary, regardless of host speed.
const expectedSpawns = 1 + badBinBackoffMs.length;
for (let expected = 1; expected <= expectedSpawns; expected++) {
  for (let i = 0; i < 100 && readBadBinCalls().length < expected; i++) await sleep(50);
  check(`(bad-bin) spawn #${expected} recorded before killing it`, readBadBinCalls().length >= expected);
  const pid = badBinSup.getPid();
  if (pid != null) { try { process.kill(pid); } catch { /* already gone */ } }
}

// The last kill above is the one that exhausts restartAttempts — scheduleRestart's give-up branch runs
// SYNCHRONOUSLY off that death's exit event and never reaches a setTimeout, so this settles quickly and,
// once null, stays null (no pending timer could ever flip it back).
for (let i = 0; i < 100 && badBinSup.getPort() !== null; i++) await sleep(50);

check("(bad-bin) after exhausting the bounded restart schedule, getPort() is null (gave up, NOT phantom-alive)",
  badBinSup.getPort() === null);
check("(bad-bin) getPid() is null too (no live child left dangling)", badBinSup.getPid() === null);
check(`(bad-bin) exactly ${expectedSpawns} calls recorded (1 initial + ${badBinBackoffMs.length} restarts) — the schedule was exhausted, not cut short`,
  readBadBinCalls().length === expectedSpawns);

// Give any straggler restart timer a moment to fire (it structurally shouldn't — give-up never schedules
// one) and re-confirm both signals stay put: no new call recorded, port stays null.
const callsAtGiveUp = readBadBinCalls().length;
await sleep(300);
check("(bad-bin) stays down (no stray restart revives it after giving up)",
  badBinSup.getPort() === null && readBadBinCalls().length === callsAtGiveUp);

// ===================== (d) control-plane client: bounded, never throws =====================
const requests = [];
const fakeServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
const fakePort = fakeServer.address().port;

// Test-only seam: pre-seed a live port with NO real spawn, to exercise the HTTP client hermetically.
const client = new CodescapeSupervisor({ port: fakePort });
check("(d) test-seam port pre-seeds getPort()", client.getPort() === fakePort);

const reg = await client.registerWorktree("proj1", { worktreeId: "wt1", path: "/x/y", baseRef: "main" });
check("(d) registerWorktree resolves ok:true against the fake server", reg.ok === true);
check("(d) registerWorktree POSTs /project/<id>/worktree",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/worktree");
check("(d) registerWorktree body carries worktreeId/path/baseRef",
  (() => { const b = JSON.parse(requests.at(-1)?.body || "{}"); return b.worktreeId === "wt1" && b.path === "/x/y" && b.baseRef === "main"; })());

await client.reingestMain("proj1");
check("(d) reingestMain POSTs /project/<id>/reingest-main",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/reingest-main");

await client.dropWorktree("proj1", "wt1");
check("(d) dropWorktree DELETEs /project/<id>/worktree/<worktreeId>",
  requests.at(-1)?.method === "DELETE" && requests.at(-1)?.url === "/project/proj1/worktree/wt1");

await client.overlay("proj1", "wt1");
check("(d) overlay POSTs /project/<id>/worktree/<worktreeId>/overlay",
  requests.at(-1)?.method === "POST" && requests.at(-1)?.url === "/project/proj1/worktree/wt1/overlay");

await new Promise((resolve) => fakeServer.close(resolve));

// Bounded against an unreachable (just-closed) port — never throws, resolves within its own timeout.
const deadClient = new CodescapeSupervisor({ port: fakePort, registerTimeoutMs: 500, reingestTimeoutMs: 500 });
const t0 = Date.now();
const deadReg = await deadClient.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
check("(d) an unreachable server resolves ok:false (never throws)", deadReg.ok === false);
check("(d) bounded — resolves quickly, doesn't hang past its own timeout", Date.now() - t0 < 5_000);

// No live port at all (never started) ⇒ immediate ok:false, no fetch attempted.
const noPortSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "never-started") });
const t1 = Date.now();
const noPortReg = await noPortSup.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
check("(d) no live port ⇒ ok:false immediately (no fetch attempted)", noPortReg.ok === false && Date.now() - t1 < 200);

// ===================== (d-hang) CR fix: prove the AbortController bound actually FIRES =====================
// The dead-port case above proves "never throws" but resolves via a fast connection-refused error, never
// actually exercising the timeout/AbortController path. This server ACCEPTS the connection but never
// responds — the only way to prove the bound itself (not just an OS-level refusal) is what stops the call.
const hungServer = http.createServer(() => { /* never responds — simulates a hung codescape serve */ });
await new Promise((resolve) => hungServer.listen(0, "127.0.0.1", resolve));
const hungPort = hungServer.address().port;
const HUNG_TIMEOUT_MS = 300;
const hungClient = new CodescapeSupervisor({ port: hungPort, registerTimeoutMs: HUNG_TIMEOUT_MS });
const t2 = Date.now();
const hungReg = await hungClient.registerWorktree("p", { worktreeId: "w", path: "/a", baseRef: "main" });
const hungElapsed = Date.now() - t2;
check("(d-hang) a connected-but-never-responds server resolves ok:false (the AbortController bound fires)", hungReg.ok === false);
check(`(d-hang) the abort fires around its OWN timeout (${hungElapsed}ms), not instantly and not way past it`,
  hungElapsed >= HUNG_TIMEOUT_MS - 50 && hungElapsed < HUNG_TIMEOUT_MS + 4_000);
hungServer.closeAllConnections();
await new Promise((resolve) => hungServer.close(resolve));

// ===================== cleanup =====================
delete process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_ENABLED;
delete process.env.LOOM_DEV;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape supervisor (C1, + P4 wiring 088afc94 + its dynamic-registration follow-up): codescapeBootRepoPaths filters projects to only those with codescape.enabled resolved true; LOOM_DEV unset never spawns anything (getPort/getPid null, zero side effects); enabled ingest-then-serve run from the SAME shared cwd (CWD CONTRACT) on a real loopback port, and start()'s own boot loop registers each project via a REAL POST /project round-trip against the fixture's minimal HTTP listener, caching the resolved id; registerProject/resolveProjectId are idempotent (re-registering an already-known repo returns the SAME id, mode 'already-registered'), a brand-new repo registers fresh ('ingested', a distinct id), a fresh instance's empty cache falls back to the cold manifest read for a repo it never registered itself, and a repo in neither cache nor manifest resolves an honest null; registerProject with no live port resolves ok:false and caches nothing; registerProjectWithRetry bounds EACH attempt at the SHORT registerTimeoutMs (falsifiably proven against a hung, never-responding server — the retry never stacks into the much larger ingestTimeoutMs); getHomeDir() exposes that same shared cwd per-instance; killing the child triggers a bounded restart (same port, new pid); stop() disarms restart-on-death; the control-plane client (register/reingest/drop/overlay) hits the right method+URL+body, is bounded, and NEVER throws — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
