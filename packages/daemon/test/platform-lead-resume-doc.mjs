import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2fed1663 — lineage-scope the Platform Lead resume doc so concurrent Leads never contend on one
// shared file. `/platform-lead` doctrine promotes running MULTIPLE concurrent Leads AND rewriting ONE
// living resume doc "in place"; those conflicted — a second live Lead's rewrite invalidated the first's
// read, and the loser SKIPPED recording its whole session rather than clobber (observed 2026-07-01,
// Leads 872342ba + 745b06ef live concurrently).
//
// PROVES the DoD:
//   (1) PURE: lineageRootId walks a recycledFrom chain back to its root; a fresh (non-recycled) session
//       is its own root.
//   (2) IMPURE resolvePlatformLeadResumeDocPath: the FIRST lineage ever observed claims the plain base
//       filename PERMANENTLY (app_meta marker) — the single-Lead default; that SAME lineage's later
//       successors resolve back to the SAME base path; any OTHER lineage gets its own DISTINCT
//       `PLATFORM-LEAD-RESUME-<lineageId>.md`, SEEDED from the base doc's content the first time it's
//       needed (never re-seeded once it exists); with no base doc on disk, a secondary lineage still
//       resolves a path (no crash) and creates no file (the agent starts fresh, like today).
//   (3) END-TO-END via SessionService: two concurrently-spawned Leads (fresh startPlatformLead calls,
//       each its own lineage) get DISTINCT resume-doc paths injected into their startupPrompt's
//       "Where things live" block; a lineage's recycle successor (recyclePlatformLead) carries forward
//       the SAME resolved path as its predecessor — the primary lineage's successor still reads the
//       base file, a secondary lineage's successor still reads its own seeded file.
//   (4) PURE-ish composeResumeDocOperationalNotes / findFreshestSiblingResumeDoc — the optional read-cap
//       + freshest-sibling hardening on top of the doctrine above: a healthy small doc with no siblings
//       emits nothing; a doc past the ~80KB warn threshold emits a size-warning note naming its own path;
//       a sibling resume doc whose mtime materially (>=48h) leads the resolved doc's own mtime emits a
//       staleness note pointing at that freshest sibling; a sibling only slightly fresher stays silent;
//       the sibling finder ignores non-matching filenames and never throws on a missing dir.
//   (5) END-TO-END: an oversized doc's injected startupPrompt carries the size-warning note ahead of the
//       "Where things live" pointer block, and the continuation handoff still rides along after it.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like platform-lead-recycle.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty/stop seam). A real temp git repo backs the spawn
// cwd (it also stands in for the Lead's "home" — the reserved platform project binds vaultPath there).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-resume-doc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-lead-resumedoc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const {
  lineageRootId, resolvePlatformLeadResumeDocPath,
  platformLeadBaseResumeDocPath, platformLeadLineageResumeDocPath,
  PRIMARY_LINEAGE_META_KEY,
  findFreshestSiblingResumeDoc, composeResumeDocOperationalNotes,
} = await import("../dist/sessions/platform-lead-prompt.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude); it also
// stands in for the reserved platform project's "home" (repoPath === vaultPath, per platform/seed.ts). ---
const repo = path.join(os.tmpdir(), `loom-lead-resumedoc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform lead resume-doc lineage test repo\n");
execSync(`git init -q && git add . && git -c user.email=rd@loom -c user.name=rd commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Platform", startupPrompt: "LEAD WARMUP BRIEF", position: 0, profileId: null });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ============================ (1) PURE: lineageRootId chain walk ==================================
  db.insertSession({ id: "root1", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });
  db.insertSession({ id: "gen2", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "root1" });
  db.insertSession({ id: "gen3", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "gen2" });
  check("(1) a fresh (non-recycled) session is its own lineage root", lineageRootId(db, db.getSession("root1")) === "root1");
  check("(1) one hop up the chain resolves to the root", lineageRootId(db, db.getSession("gen2")) === "root1");
  check("(1) two hops up the chain resolves to the SAME root", lineageRootId(db, db.getSession("gen3")) === "root1");

  // --- defensive branches: a corrupt recycledFrom chain must still TERMINATE with a sane id ---
  // (a) a SELF-LOOP (recycledFrom points at its own id) — the `seen` guard must stop immediately.
  db.insertSession({ id: "selfLoop", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "selfLoop" });
  check("(1) a self-loop terminates (no infinite loop) and returns its own id", lineageRootId(db, db.getSession("selfLoop")) === "selfLoop");

  // (b) a 2-NODE CYCLE (A -> B -> A) — the `seen` guard must stop once a REPEATED id is hit.
  db.insertSession({ id: "cycleA", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "cycleB" });
  db.insertSession({ id: "cycleB", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "cycleA" });
  const cycleResult = lineageRootId(db, db.getSession("cycleA"));
  check("(1) a 2-node cycle terminates (no infinite loop) and returns a member of the cycle", cycleResult === "cycleA" || cycleResult === "cycleB");

  // (c) a recycledFrom pointing at a MISSING (never-inserted) session — breaks and returns the last
  // VALID id reached (one real hop, then the dangling reference is dropped, not followed into a crash).
  db.insertSession({ id: "midValid", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "missingGhost" });
  db.insertSession({ id: "childValid", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", recycledFrom: "midValid" });
  check("(1) a dangling recycledFrom (missing predecessor) breaks cleanly and returns the last VALID id", lineageRootId(db, db.getSession("childValid")) === "midValid");

  // ============================ (2) IMPURE resolvePlatformLeadResumeDocPath =========================
  const home2 = path.join(os.tmpdir(), `loom-lead-resumedoc-home2-${Date.now()}`);
  fs.mkdirSync(home2, { recursive: true });
  const basePath2 = platformLeadBaseResumeDocPath(home2);

  const p1 = resolvePlatformLeadResumeDocPath(db, home2, "lineageA");
  check("(2) the FIRST lineage ever observed claims the plain base filename", p1 === basePath2);
  const p1again = resolvePlatformLeadResumeDocPath(db, home2, "lineageA");
  check("(2) the SAME (primary) lineage's later call still resolves to the base file", p1again === basePath2);

  const p2 = resolvePlatformLeadResumeDocPath(db, home2, "lineageB");
  check("(2) a DIFFERENT (secondary) lineage gets a DISTINCT, non-base path", p2 !== basePath2 && p2 === platformLeadLineageResumeDocPath(home2, "lineageB"));
  const p2again = resolvePlatformLeadResumeDocPath(db, home2, "lineageB");
  check("(2) the secondary lineage's later call resolves to the SAME per-lineage path", p2again === p2);

  // seed-from-base: write real content into the base doc, then a THIRD (never-seen) lineage should get
  // its own file SEEDED with that exact content.
  fs.writeFileSync(basePath2, "# Platform Lead Resume\n\nSTATE: 3 projects live.\n");
  const p3 = resolvePlatformLeadResumeDocPath(db, home2, "lineageC");
  check("(2) a third lineage also gets its OWN distinct path", p3 !== basePath2 && p3 !== p2);
  check("(2) the third lineage's file was SEEDED from the base doc's content", fs.existsSync(p3) && fs.readFileSync(p3, "utf8") === fs.readFileSync(basePath2, "utf8"));

  // Once a lineage's file exists, it is never re-seeded — the Lead's own edits are never clobbered.
  fs.writeFileSync(p3, "# Lineage C's own edits\n");
  const p3reread = resolvePlatformLeadResumeDocPath(db, home2, "lineageC");
  check("(2) re-resolving an EXISTING lineage file returns the same path without re-seeding it", p3reread === p3 && fs.readFileSync(p3, "utf8") === "# Lineage C's own edits\n");

  // No base doc on disk yet → a secondary lineage still resolves cleanly (no crash) and creates no file
  // (mirrors today's cold-boot-on-nothing behavior — the agent starts its doc fresh). The primary-claim
  // marker is GLOBAL per Db (there is only ever ONE real platform home in production) — reset it so this
  // independently-scoped scenario starts fresh, sharing the one Db instance like the rest of this file.
  db.deleteMeta(PRIMARY_LINEAGE_META_KEY);
  const home3 = path.join(os.tmpdir(), `loom-lead-resumedoc-home3-${Date.now()}`);
  fs.mkdirSync(home3, { recursive: true });
  const q1 = resolvePlatformLeadResumeDocPath(db, home3, "onlyLineage"); // claims primary (base) — no file needed to exist
  check("(2) with an empty home, the first lineage still resolves to the base path", q1 === platformLeadBaseResumeDocPath(home3));
  const q2 = resolvePlatformLeadResumeDocPath(db, home3, "secondLineageNoBase");
  check("(2) a secondary lineage with NO base doc on disk resolves a path without throwing", typeof q2 === "string" && q2 !== q1);
  check("(2) …and creates no file (nothing to seed from — agent starts fresh)", !fs.existsSync(q2));

  // ============================ (3) END-TO-END via SessionService ====================================
  db.deleteMeta(PRIMARY_LINEAGE_META_KEY); // fresh primary-claim slate for this scenario (see note above)
  const basePathE2E = platformLeadBaseResumeDocPath(repo);
  fs.rmSync(basePathE2E, { force: true }); // ensure a clean slate for this section

  const leadA = svc.startPlatformLead("agentLead"); // opens the PRIMARY lineage
  const promptA = host.spawned.at(-1).startupPrompt ?? "";
  check("(3) Lead A's startupPrompt carries the 'Where things live' resume-doc block", promptA.includes("## Where things live (your resume doc)"));
  check("(3) Lead A (the first-ever lineage) resolves to the plain base file", promptA.includes(basePathE2E));
  check("(3) Lead A's startupPrompt still carries its agent warm-up after the block", promptA.includes("LEAD WARMUP BRIEF") && promptA.indexOf("Where things live") < promptA.indexOf("LEAD WARMUP BRIEF"));

  const leadB = svc.startPlatformLead("agentLead"); // a SECOND, concurrently-live, fresh lineage
  const promptB = host.spawned.at(-1).startupPrompt ?? "";
  const lineageBPath = platformLeadLineageResumeDocPath(repo, leadB.id);
  check("(3) Lead B (a second concurrent lineage) resolves to its OWN distinct file", promptB.includes(lineageBPath) && !promptB.includes(basePathE2E));
  check("(3) Lead A and Lead B got DISTINCT resume-doc paths (no shared-file contention)", !promptA.includes(lineageBPath) && !promptB.includes(basePathE2E));

  // Recycle Lead A (the primary lineage) — its successor must resolve to the SAME base file.
  const succA = await svc.recyclePlatformLead(leadA.id, "HANDOFF A: primary lineage continues");
  const succPromptA = host.spawned.at(-1).startupPrompt ?? "";
  check("(3) Lead A's successor is a NEW session in the SAME (primary) lineage", succA.id !== leadA.id && lineageRootId(db, db.getSession(succA.id)) === leadA.id);
  check("(3) Lead A's successor STILL resolves to the base file (its lineage's own doc)", succPromptA.includes(basePathE2E));
  check("(3) Lead A's successor prompt still carries the continuation handoff", succPromptA.includes("HANDOFF A: primary lineage continues") && succPromptA.includes("[loom:continuation]"));

  // Recycle Lead B (the secondary lineage) — its successor must resolve to the SAME per-lineage file B.
  const succB = await svc.recyclePlatformLead(leadB.id, "HANDOFF B: secondary lineage continues");
  const succPromptB = host.spawned.at(-1).startupPrompt ?? "";
  check("(3) Lead B's successor is a NEW session in the SAME (secondary) lineage", succB.id !== leadB.id && lineageRootId(db, db.getSession(succB.id)) === leadB.id);
  check("(3) Lead B's successor resolves to the SAME per-lineage file as its predecessor (not the base, not lineage A's)", succPromptB.includes(lineageBPath) && !succPromptB.includes(basePathE2E));

  // ==================== (4) composeResumeDocOperationalNotes — size + staleness warnings ====================
  const home4 = path.join(os.tmpdir(), `loom-lead-resumedoc-home4-${Date.now()}`);
  fs.mkdirSync(home4, { recursive: true });
  const doc4 = platformLeadBaseResumeDocPath(home4);

  // No doc on disk yet, no siblings — nothing to flag.
  check("(4) no doc + no siblings ⇒ empty notes", composeResumeDocOperationalNotes(home4, doc4) === "");

  // A small, healthy doc — well under the warn threshold, no siblings — still nothing to flag.
  fs.writeFileSync(doc4, "# Platform Lead Resume\n\nSTATE: nothing notable.\n");
  check("(4) a small doc + no siblings ⇒ empty notes", composeResumeDocOperationalNotes(home4, doc4) === "");

  // A doc past the ~80KB warn threshold ⇒ the size note fires and names the path.
  fs.writeFileSync(doc4, "x".repeat(90 * 1024));
  const sizeNotes = composeResumeDocOperationalNotes(home4, doc4);
  check("(4) an oversized doc ⇒ the size-warning note fires", sizeNotes.includes("[loom:resume-doc-size]"));
  check("(4) the size-warning note names the doc's own path", sizeNotes.includes(doc4));
  fs.writeFileSync(doc4, "# Platform Lead Resume\n\nSTATE: nothing notable.\n"); // shrink back down

  // A fresher sibling (another lineage's file) ⇒ the staleness note fires and points at it.
  const siblingPath4 = platformLeadLineageResumeDocPath(home4, "otherLineage");
  fs.writeFileSync(siblingPath4, "# Lineage-B resume\n\nSTATE: actively maintained.\n");
  const oldMs = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago — well past the 48h material-lag threshold
  fs.utimesSync(doc4, new Date(oldMs), new Date(oldMs));
  const staleNotes = composeResumeDocOperationalNotes(home4, doc4);
  check("(4) a materially-fresher sibling ⇒ the staleness note fires", staleNotes.includes("[loom:resume-doc-stale]"));
  check("(4) the staleness note names the FRESHEST sibling's path", staleNotes.includes(siblingPath4));

  // A sibling only SLIGHTLY fresher (under the material-lag threshold) ⇒ no staleness note.
  const recentMs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago — under the 48h threshold
  fs.utimesSync(doc4, new Date(recentMs), new Date(recentMs));
  fs.utimesSync(siblingPath4, new Date(), new Date());
  check("(4) a sibling only slightly fresher (< material-lag) ⇒ no staleness note", !composeResumeDocOperationalNotes(home4, doc4).includes("[loom:resume-doc-stale]"));

  // findFreshestSiblingResumeDoc: excludes the given path, ignores non-matching filenames, tolerates a
  // missing/unreadable home directory.
  fs.writeFileSync(path.join(home4, "not-a-resume-doc.md"), "irrelevant\n");
  const freshest4 = findFreshestSiblingResumeDoc(home4, doc4);
  check("(4) findFreshestSiblingResumeDoc ignores non-matching filenames and excludes the given path", freshest4 !== null && freshest4.path === siblingPath4);
  check("(4) findFreshestSiblingResumeDoc on a missing home dir returns null (never throws)", findFreshestSiblingResumeDoc(path.join(home4, "does-not-exist"), doc4) === null);

  // ==================== (5) END-TO-END: the notes ride along in the injected startupPrompt ====================
  db.deleteMeta(PRIMARY_LINEAGE_META_KEY);
  const home5 = path.join(os.tmpdir(), `loom-lead-resumedoc-home5-${Date.now()}`);
  fs.mkdirSync(home5, { recursive: true });
  db.insertProject({ id: "pHome5", name: "Loom Platform 5", repoPath: repo, vaultPath: home5, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "agentLead5", projectId: "pHome5", name: "Platform", startupPrompt: "LEAD5 WARMUP", position: 0, profileId: null });

  const leadC = svc.startPlatformLead("agentLead5"); // opens the primary lineage — claims the base file at home5
  const basePathHome5 = platformLeadBaseResumeDocPath(home5);
  const promptC = host.spawned.at(-1).startupPrompt ?? "";
  check("(5) a fresh, healthy (nonexistent) doc injects NO operational notes", !promptC.includes("[loom:resume-doc-size]") && !promptC.includes("[loom:resume-doc-stale]"));

  // Blow the doc past the size cap directly on disk, then recycle — the successor's injected prompt must
  // carry the size warning ahead of the "Where things live" pointer block.
  fs.writeFileSync(basePathHome5, "y".repeat(90 * 1024));
  const succC = await svc.recyclePlatformLead(leadC.id, "HANDOFF C: doc has grown too large");
  const succPromptC = host.spawned.at(-1).startupPrompt ?? "";
  check("(5) an oversized doc's successor prompt carries the size-warning note", succPromptC.includes("[loom:resume-doc-size]"));
  check("(5) the size-warning note precedes the 'Where things live' pointer block", succPromptC.indexOf("[loom:resume-doc-size]") < succPromptC.indexOf("Where things live"));
  check("(5) the successor prompt still carries its continuation handoff after the notes", succPromptC.includes("HANDOFF C: doc has grown too large"));
  fs.rmSync(home5, { recursive: true, force: true });
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Platform Lead resume doc is lineage-scoped: the first-ever lineage keeps the plain base file (single-Lead default), every other (concurrent/later) lineage gets its own file seeded from the base once, a lineage's recycle successor always resolves back to its OWN lineage's file, concurrently-spawned Leads never contend on one shared file, and the optional read-cap/freshest-sibling hardening injects a size or staleness note into the successor's startupPrompt exactly when the doc genuinely warrants it (and stays silent otherwise)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
