import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bba7a8ec — a manager kickoff is composed by the SYNCHRONOUS `composeManagerStartupPrompt`, which now
// does NO git: its caller's async entry point pre-reads the deploy staleness (off the event loop) and hands it
// in. Driven through the real `SessionService.startManager` -> `composeManagerStartupPrompt` path (fake pty).
//
// Proves:
//   (1) a spawn with NO pre-read carries the honest "not measured at spawn" line, and neither a stale/fresh
//       claim nor the old `[loom:deploy-staleness-unknown] … ETIMEDOUT` notice.
//   (2) a pre-read STALE result renders the `[loom:deploy-stale]` alarm (and no not-measured line).
//   (3) THE CARD'S SYMPTOM: a pre-read that takes LONGER than the old synchronous 1 s cap (a 1.5 s stubbed git
//       over a throwaway repo) completes and the kickoff carries NO ETIMEDOUT / could-not-measure notice.
//   (4) the same on THIS checkout with the real async read (`resolveDeployStalenessAsync`): no ETIMEDOUT.
//   (5) the pre-read helpers only read git for a MANAGER (agent profile / session role) — a non-manager gets
//       `undefined` and pays for no read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { CLEAN_STALENESS } from "./_deploy-staleness-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mgrpre-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { computeDeployStalenessAsync } = await import("../dist/deploy-staleness.js");

const vault = path.join(tmpHome, "vault");
fs.mkdirSync(vault, { recursive: true });
const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "mgrpre.db"));
// A SUBDIR of LOOM_HOME: a manager is barred from a repoPath that is the workspace home or an ancestor of it.
const mgrRepo = path.join(tmpHome, "mgr-repo");
fs.mkdirSync(mgrRepo, { recursive: true });
db.insertProject({ id: "pM", name: "MgrPre", repoPath: mgrRepo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
for (const n of [1, 2, 3, 4]) db.insertAgent({ id: `agentMgr${n}`, projectId: "pM", name: `Mgr${n}`, startupPrompt: "DOCTRINE", position: n, profileId: null });

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; this.handles = new Map(); }
  createPty(opts) {
    this.capture.push(opts);
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const promptOf = (sid) => host.capture.find((o) => o.sessionId === sid).startupPrompt;
const spawn = (agentId, opts) => {
  const id = svc.startManager(agentId, undefined, opts).id;
  const p = promptOf(id);
  host.handles.get(id).kill();
  return p;
};

// (1) no pre-read
{
  const p = spawn("agentMgr1");
  check("(1) no pre-read ⇒ the honest not-measured line is present", p.includes("[loom:deploy-staleness-not-measured] Deploy staleness was not measured at spawn."));
  check("(1) ...and it claims neither stale nor current, and carries no ETIMEDOUT / unknown notice",
    !p.includes("[loom:deploy-stale]") && !p.includes("[loom:deploy-staleness-unknown]") && !/ETIMEDOUT/.test(p));
  check("(1) ...and the 'Where things live' block + doctrine are intact", p.includes("## Where things live") && p.includes("DOCTRINE"));
}

// (2) pre-read STALE
{
  const stale = { ...CLEAN_STALENESS, available: true, stale: true, commitsBehind: 2, mainlineHeadSha: "abcdef1234567890", mainlineHeadDate: "2026-02-01T00:00:00Z", runningCodeBuiltAt: "2026-01-01T00:00:00Z" };
  const p = spawn("agentMgr2", { deployStaleness: stale });
  check("(2) a pre-read stale result renders the [loom:deploy-stale] alarm naming the commit count", p.includes("[loom:deploy-stale]") && p.includes("carries 2 `packages/daemon/src`"));
  check("(2) ...and no not-measured line", !p.includes("deploy-staleness-not-measured"));
  const clean = spawn("agentMgr2", { deployStaleness: { ...CLEAN_STALENESS, available: true } });
  check("(2) a pre-read CLEAN result emits no deploy notice at all", !/\[loom:deploy-stale/.test(clean));
}

// (3) a pre-read slower than the old sync cap completes: no ETIMEDOUT in the kickoff
{
  const repo = path.join(tmpHome, "slow-repo");
  fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages", "daemon", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "packages", "daemon", "dist", "index.js"), "x");
  execSync("git init -q", { cwd: repo });
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@loom -c user.name=t commit -q -m init", { cwd: repo });
  const SLOW_MS = 1500; // > the sync driver's 1000 ms cap that used to produce the ETIMEDOUT notice
  const slowGit = async (root, args) => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return execSync(`git -C "${root}" ${args.map((a) => `"${a}"`).join(" ")}`, { encoding: "utf8" });
  };
  const t0 = performance.now();
  const staleness = await computeDeployStalenessAsync({
    repoRoot: repo, distEntry: path.join(repo, "packages", "daemon", "dist", "index.js"),
    sharedDist: path.join(repo, "packages", "shared", "dist"), webDist: path.join(repo, "packages", "web", "dist"), asyncGit: slowGit,
  });
  const took = performance.now() - t0;
  check(`(3) the stubbed read really exceeded the old 1 s sync cap (${Math.round(took)} ms)`, took > 1000);
  check("(3) ...and still produced a measurement (available:true), not could-not-measure", staleness.available === true);
  const p = spawn("agentMgr3", { deployStaleness: staleness });
  check("(3) the kickoff carries NO ETIMEDOUT and NO could-not-measure notice", !/ETIMEDOUT/.test(p) && !p.includes("[loom:deploy-staleness-unknown]"));
}

// (4) the real async read on THIS checkout
{
  const staleness = await svc.resolveDeployStalenessAsync();
  const p = spawn("agentMgr4", { deployStaleness: staleness });
  check("(4) the real async read on this checkout does not time out (kickoff has no ETIMEDOUT)" + (staleness.available ? "" : ` [read was unavailable: ${staleness.reason}]`), !/ETIMEDOUT/.test(p));
}

// (5) pre-read helpers read git only for a manager
{
  let reads = 0;
  svc.setDeployStalenessOverrideForTest(undefined);
  const real = svc.resolveDeployStalenessAsync.bind(svc);
  svc.resolveDeployStalenessAsync = async () => { reads++; return real(); };
  const nonManager = await svc.preReadDeployStalenessForAgent("agentMgr1"); // profileId null ⇒ no manager role
  check("(5) an agent with no manager profile gets undefined and no read", nonManager === undefined && reads === 0);
  const sid = svc.startManager("agentMgr1").id;
  const mgrRow = await svc.preReadDeployStalenessForSession(sid);
  check("(5) a manager session row triggers exactly one read and returns a result", reads === 1 && mgrRow !== undefined && typeof mgrRow.available === "boolean");
  host.handles.get(sid).kill();
  const plainId = svc.startNew("agentMgr2", { forcePlain: true }).id;
  const plainRow = await svc.preReadDeployStalenessForSession(plainId);
  host.handles.get(plainId).kill();
  check("(5) a plain (role-less) session gets undefined and no further read", plainRow === undefined && reads === 1);
}

// (6) a PACKAGED install (no `.git` at the repo root) renders NOTHING — decided synchronously, no git spawned
{
  const { notApplicableDeployStaleness } = await import("../dist/deploy-staleness.js");
  const noGitRoot = path.join(tmpHome, "packaged-root");
  fs.mkdirSync(noGitRoot, { recursive: true });
  const withGitRoot = path.join(tmpHome, "source-root");
  fs.mkdirSync(path.join(withGitRoot, ".git"), { recursive: true });
  const na = notApplicableDeployStaleness(noGitRoot);
  check("(6) no .git ⇒ the synchronous not-applicable result (available:false, reasonKind not-applicable)", na?.available === false && na?.reasonKind === "not-applicable");
  check("(6) CONTROL: a .git present ⇒ undefined (staleness COULD be measured, so the caller must pre-read or say not-measured)", notApplicableDeployStaleness(withGitRoot) === undefined);
  const prevRoot = process.env.LOOM_REPO_ROOT;
  process.env.LOOM_REPO_ROOT = noGitRoot;
  try {
    const p = spawn("agentMgr3");
    check("(6) a manager kickoff on a packaged install (no pre-read) carries NO deploy-staleness line at all",
      !/deploy-stale|deploy-staleness|not measured/.test(p) && p.includes("## Where things live"));
    check("(6) the sync fallback resolver yields the not-applicable result there (so the build stamp renders empty, not '[build: not measured]')",
      svc.resolveDeployStalenessWithoutGit()?.reasonKind === "not-applicable");
  } finally {
    if (prevRoot === undefined) delete process.env.LOOM_REPO_ROOT; else process.env.LOOM_REPO_ROOT = prevRoot;
  }
  const p2 = spawn("agentMgr3");
  check("(6) CONTROL: with the real (.git-bearing) root restored, the same spawn DOES carry the not-measured line again", p2.includes("[loom:deploy-staleness-not-measured]"));
}

// (7) the platform/setup/companion `session_spawn` backing op threads its async pre-read into the manager kickoff
{
  const stale = { ...CLEAN_STALENESS, available: true, stale: true, commitsBehind: 3, mainlineHeadSha: "1234abcd5678", mainlineHeadDate: "2026-02-01T00:00:00Z", runningCodeBuiltAt: "2026-01-01T00:00:00Z" };
  const id = svc.spawnSessionAsPlatform("pM", "agentMgr4", "manager", { deployStaleness: stale }).id;
  const p = promptOf(id);
  host.handles.get(id).kill();
  check("(7) spawnSessionAsPlatform(manager, {deployStaleness}) renders the pre-read stale alarm in the kickoff", p.includes("[loom:deploy-stale]") && p.includes("carries 3 `packages/daemon/src`"));
}

db.close();
try { cleanupPathSync(tmpHome); } catch { /* best effort */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — the manager kickoff takes its deploy staleness from an async pre-read, and never carries the ETIMEDOUT notice."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
