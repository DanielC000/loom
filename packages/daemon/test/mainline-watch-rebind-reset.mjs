import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 84ea9f67 — a repo rebind/repath resets the mainline watermark + boot-alert marker (docs/decisions/4fa36502-mainline-move-tripwire.md). REAL git on temp repos.
//   (A) control: WITHOUT a rebind, a real raw move on the same repo still alerts.
//   (B) rebind repoPath to a DIFFERENT repo with the same branch name ⇒ W + marker gone, ONE low `source:"rebind"` event (from → to paths), and the next BOOT first-sight check files NO alert and re-seeds W.
//       (card 787dd2a7: a LANDING-shaped first-sight check — no `source` — no longer seeds by itself either;
//       seeding on that path now defers to advanceMainlineWatermark{,ForBatch} after a verified landing.)
//   (C) a no-op rebind (same path, and a trailing-slash spelling) does NOT reset W (a raw move cannot be laundered through it) and files nothing.
//   (D) a `repos` registry repath resets only that key's baseline; an unchanged sibling key keeps its W.
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-rebind-reset.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mainline-rebind-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mw", GIT_AUTHOR_EMAIL: "mw@loom", GIT_COMMITTER_NAME: "mw", GIT_COMMITTER_EMAIL: "mw@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mw@loom -c user.name=mw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const mkRepo = (name) => {
  const r = path.join(os.tmpdir(), `loom-mwrb-${name}-${sfx}`);
  fs.mkdirSync(r, { recursive: true }); registerForCleanup(r);
  fs.writeFileSync(path.join(r, "README.md"), `# ${name}\n`);
  git(r, "init", "-q", "-b", "main"); git(r, "config", "core.autocrlf", "false"); git(r, "config", "user.email", "mw@loom"); git(r, "config", "user.name", "mw");
  commitAll(r, `init ${name}`, GIT_ID);
  return r;
};
const head = (r) => git(r, "rev-parse", "HEAD");
const addCommit = (r, n) => { fs.writeFileSync(path.join(r, `f${n}.txt`), `${n}\n`); commitAll(r, `chore(x): step ${n}`, GIT_ID); return head(r); };
const repoA = mkRepo("a"), repoB = mkRepo("b"), repoC = mkRepo("c");
addCommit(repoB, 1); // B has different history than A, same branch name "main"

const projId = `mwrb-proj-${sfx}`, agentId = `mwrb-agent-${sfx}`, mgrId = `mwrb-mgr-${sfx}`;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: async () => ({ killedPids: [] }) });
db.insertProject({ id: projId, name: "MWRB", repoPath: repoA, vaultPath: repoA, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repoA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
const wKey = (k) => MW.mainlineWatermarkKey(projId, k), aKey = (k) => MW.mainlineBootAlertKey(projId, k);
const setW = (k, sha) => db.setMeta(wKey(k), JSON.stringify({ branch: "main", sha }));
const watermark = (k = "primary") => MW.parseMainlineWatermark(db.getMeta(wKey(k)));
const allEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === projId);
const runCheck = (repoKey, repoPath, source) => sessions.checkMainlineMove({ projectId: projId, repoKey, repoPath, managerSessionId: mgrId, workerSessionId: null, taskId: null, source });
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); };

try {
  // ── (A) control: no rebind, a real raw move still alerts ──
  const a0 = head(repoA);
  const a1 = addCommit(repoA, 1); setW("primary", a1); // W = a1, then main is rawly rewound to a0
  git(repoA, "update-ref", "refs/heads/main", a0); git(repoA, "reset", "-q", "--hard"); // raw rewind (empty reflog message)
  const n0 = allEvents().length;
  await runCheck("primary", repoA);
  const evA = allEvents().slice(n0);
  check("(A) control: WITHOUT a rebind a real raw move on the same repo still alerts (high)", evA.length === 1 && evA[0].detail.severity === "high" && !evA[0].detail.source);

  // ── (B) rebind to a DIFFERENT repo, same branch name ──
  const aTip = head(repoA); setW("primary", aTip);
  db.setMeta(aKey("primary"), JSON.stringify({ branch: "main", from: aTip, to: aTip, evidence: ["x"], suspectShas: [], nudgedAt: null }));
  const nB = allEvents().length;
  db.updateProject(projId, { repoPath: repoB });
  const evB = allEvents().slice(nB);
  check("(B1) rebind deletes the watermark AND the boot-alert marker", db.getMeta(wKey("primary")) === undefined && db.getMeta(aKey("primary")) === undefined);
  check("(B2) rebind files ONE `source:rebind` event naming from → to paths (HIGH here only because the seeded marker is undelivered; see B5/B6 for the low case)", evB.length === 1 && evB[0].detail.severity === "high" && evB[0].detail.source === "rebind" && evB[0].detail.reset === true && evB[0].detail.fromPath === repoA && evB[0].detail.toPath === repoB && evB[0].detail.repoKey === "primary");
  const nB2 = allEvents().length;
  // card 787dd2a7: a LANDING-shaped call (no source) no longer seeds by itself on first sight — seeding
  // there now defers to advanceMainlineWatermark{,ForBatch} after a verified landing — so this uses the
  // BOOT source to exercise "the rebind's reset is followed by a clean re-establishment", which is still
  // exactly what boot does for a repo with no resolvable default (repoB here has no origin/HEAD).
  const rB = await runCheck("primary", repoB, "boot");
  check("(B3) the next BOOT first-sight check in the NEW repo files NO alert and re-seeds W at its tip like a first run", rB === head(repoB) && allEvents().length === nB2 && watermark()?.sha === head(repoB));
  // card 787dd2a7: the boot check above DID seed W (confirmed by B3); delete it again here to re-create a
  // genuine true-first-sight state, so a LANDING-shaped call can be shown returning the live tip without
  // seeding itself (seeding on that path defers to advanceMainlineWatermark{,ForBatch}).
  db.deleteMeta(wKey("primary"));
  const nBland = allEvents().length;
  const rBland = await runCheck("primary", repoB);
  check("(B3b) a LANDING-shaped (non-boot) first-sight check returns the tip but defers seeding to advanceMainlineWatermark", rBland === head(repoB) && allEvents().length === nBland && watermark() === null);
  await runCheck("primary", repoB, "boot"); // re-seed for the rest of this scenario, unchanged from before this addition
  // positive control for (B3): WITHOUT the reset the same situation IS the false alert this card fixes
  setW("primary", aTip); const nBc = allEvents().length;
  await runCheck("primary", repoB);
  const evBc = allEvents().slice(nBc);
  check("(B4) negative control: a stale W from repo A read against repo B IS the loud false alert (evidence watermark-missing) — the instrument can fail", evBc.length === 1 && evBc[0].detail.severity === "high" && evBc[0].detail.evidence.includes("watermark-missing"));

  // ── (B5) an UNDELIVERED boot-alert marker is carried by a HIGH rebind event; a DELIVERED one stays low ──
  const bTip0 = head(repoB); setW("primary", bTip0);
  const undelivered = { branch: "main", from: "aaaaaaaa11111111", to: "bbbbbbbb22222222", evidence: ["reflog-raw-write"], suspectShas: ["bbbbbbbb22222222"], nudgedAt: null };
  db.setMeta(aKey("primary"), JSON.stringify(undelivered));
  const nB5 = allEvents().length;
  db.updateProject(projId, { repoPath: repoC });
  const evB5 = allEvents().slice(nB5);
  check("(B5) rebind over an UNDELIVERED marker files ONE HIGH event carrying the marker's branch/from/to/evidence and saying an unread alert was discarded",
    evB5.length === 1 && evB5[0].detail.severity === "high" && evB5[0].detail.source === "rebind" && /unread mainline alert/.test(evB5[0].detail.reason)
    && evB5[0].detail.discardedAlert?.branch === "main" && evB5[0].detail.discardedAlert.from === undelivered.from && evB5[0].detail.discardedAlert.to === undelivered.to
    && evB5[0].detail.discardedAlert.evidence.join() === "reflog-raw-write" && db.getMeta(aKey("primary")) === undefined);
  setW("primary", head(repoC));
  db.setMeta(aKey("primary"), JSON.stringify({ ...undelivered, nudgedAt: now }));
  const nB6 = allEvents().length;
  db.updateProject(projId, { repoPath: repoB });
  const evB6 = allEvents().slice(nB6);
  check("(B6) rebind over a DELIVERED marker stays LOW with no discardedAlert", evB6.length === 1 && evB6[0].detail.severity === "low" && evB6[0].detail.discardedAlert === undefined && db.getMeta(aKey("primary")) === undefined);

  // ── (C) no-op rebind must NOT reset W ──
  const bTip = head(repoB); setW("primary", bTip);
  const nC = allEvents().length;
  db.updateProject(projId, { repoPath: repoB });
  db.updateProject(projId, { repoPath: repoB + path.sep });
  check("(C) a no-op rebind (same path, trailing-separator spelling) keeps W and files nothing", watermark()?.sha === bTip && allEvents().length === nC);
  db.updateProject(projId, { name: "MWRB2" });
  check("(C2) a name-only edit keeps W and files nothing", watermark()?.sha === bTip && allEvents().length === nC);

  // ── (D) registry repath resets only that key ──
  db.updateProject(projId, { repos: [{ key: "x", path: repoA }, { key: "y", path: repoC }] });
  setW("x", head(repoA)); setW("y", head(repoC));
  const nD = allEvents().length;
  db.updateProject(projId, { repos: [{ key: "x", path: repoB }, { key: "y", path: repoC }] });
  const evD = allEvents().slice(nD);
  check("(D) a registry repath of key x resets x only; unchanged key y keeps W; ONE event names x", db.getMeta(wKey("x")) === undefined && watermark("y")?.sha === head(repoC) && evD.length === 1 && evD[0].detail.repoKey === "x" && evD[0].detail.toPath === repoB);
  setW("y", head(repoC)); const nD2 = allEvents().length;
  db.updateProject(projId, { repos: [{ key: "x", path: repoB }] });
  check("(D2) removing registry key y drops its baseline and files one event", db.getMeta(wKey("y")) === undefined && allEvents().length === nD2 + 1 && allEvents().at(-1).detail.toPath === null);
} finally {
  console.warn = realWarn;
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real repo change resets the mainline baseline (audited), a no-op rebind does not, and a raw move without a rebind still alerts."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
