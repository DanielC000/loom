import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The Platform Lead's [loom:idle] nudge carries a `[loom:linked-fixes]` line naming Platform cards whose
// linked fix (a `resolvesEscalation` link, stored as an `escalation_triaged` event) has MERGED on another
// board. A board count on the Lead's own board cannot change when the resolving work lands elsewhere.
//
// HERMETIC, CLAUDE-FREE: a recording pty stub, tick() driven directly, a REAL Db and a REAL temp git repo
// (the merged check is the genuine git-derived getTaskMergedInfo, never a mock).
//
// Proves:
//   (A) findPlatformCardsWithMergedFixes: unmerged link -> []; a real squash commit lands -> [escalation id];
//       the escalation card in the terminal column is dropped; an unlinked card never appears.
//   (B) formatLinkedFixesLine: "" at N=0 (no noise), singular/plural wording, cap + "+N more".
//   (C) The nudge: a warm cache puts the line on the LEAD's nudge only (not on a manager's), with the
//       escalation id; N=0 adds nothing.
//   (D) A synchronously-throwing, rejecting, or never-settling resolver still DELIVERS the nudge (without
//       the line) -- the refresh is fire-and-forget and the nudge never awaits it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

useOwnLoomHome("idle-nudge-linked-fixes-");
const { Db } = await import("../dist/db.js");
const { IdleWatcher } = await import("../dist/orchestration/idle-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { findPlatformCardsWithMergedFixes, formatLinkedFixesLine, LINKED_FIXES_LIST_CAP, LINKED_FIXES_MAX_LINKS } = await import("../dist/orchestration/linked-fixes.js");
const { resolveConfig } = await import("@loom/shared");
const { taskKey } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-11-06T12:00:00.000Z");
const minutesAgo = (m, base = NOW) => new Date(base.getTime() - m * 60_000).toISOString();
const settle = () => new Promise((r) => setImmediate(r));

const repo = path.join(os.tmpdir(), `loom-lf-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# linked-fixes test repo\n");
execSync("git init -q", { cwd: repo });
commitAll(repo, "init", "-c user.email=lf@loom -c user.name=lf");

const dbFile = path.join(os.tmpdir(), `loom-lf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const nowIso = NOW.toISOString();
db.insertProject({ id: "pHome", name: "Platform Home", repoPath: repo, vaultPath: repo, config: {}, createdAt: nowIso, archivedAt: null, reserved: true });
db.insertProject({ id: "pDest", name: "Dest", repoPath: repo, vaultPath: repo, config: {}, createdAt: nowIso, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentH", projectId: "pHome", name: "lead", startupPrompt: "lead", position: 0 });
db.insertAgent({ id: "agentD", projectId: "pDest", name: "mgr", startupPrompt: "orchestrate", position: 0 });

let seq = 0;
const card = (id, projectId, columnKey) => db.insertTask({
  id, projectId, title: id, body: "", columnKey, priority: "p2", position: seq++, createdAt: nowIso, updatedAt: nowIso,
});
const link = (escId, destId) => db.appendEvent({
  id: `ev-${escId}-${destId}`, ts: nowIso, managerSessionId: "LEAD", taskId: escId, kind: "escalation_triaged",
  detail: { destinationProjectId: "pDest", destinationTaskId: destId },
});
const land = (destId) => execSync(
  `git -c user.email=x@loom -c user.name=x commit --allow-empty -q -m "fix(x): landed ${destId}" -m "Loom-Worker-Branch: loom/${taskKey(destId)}"`,
  { cwd: repo },
);

// ============================ (A) the helper, against real git ============================
card("esc-open-merged", "pHome", "todo");
card("esc-open-unmerged", "pHome", "todo");
card("esc-terminal-merged", "pHome", "done");
card("esc-unlinked", "pHome", "todo");
card("dest-merged", "pDest", "todo");
card("dest-unmerged", "pDest", "todo");
card("dest-merged-2", "pDest", "todo");
link("esc-open-merged", "dest-merged");
link("esc-open-unmerged", "dest-unmerged");
link("esc-terminal-merged", "dest-merged-2");

check("(A) before any landing: no card reads as having a merged fix", (await findPlatformCardsWithMergedFixes(db, "pHome")).length === 0);
land("dest-merged");
land("dest-merged-2");
const found = await findPlatformCardsWithMergedFixes(db, "pHome");
check("(A) positive control: the open escalation whose destination merged IS reported", found.includes("esc-open-merged"));
check("(A) a linked escalation whose destination is NOT merged is not reported", !found.includes("esc-open-unmerged"));
check("(A) an escalation already in the terminal column is not reported (already handled)", !found.includes("esc-terminal-merged"));
check("(A) an unlinked card is never reported", !found.includes("esc-unlinked"));
check("(A) exactly one card reported", found.length === 1);
check("(A) another project's id yields nothing", (await findPlatformCardsWithMergedFixes(db, "pDest")).length === 0);

// ============================ (B) the formatter ============================
check("(B) N=0 renders as empty string (no noise)", formatLinkedFixesLine([]) === "");
const one = formatLinkedFixesLine(["abcdef1234567890"]);
check("(B) N=1 wording + 8-char id", /^\[loom:linked-fixes\] 1 Platform card has a linked fix merged: abcdef12\.$/.test(one));
const many = formatLinkedFixesLine(Array.from({ length: LINKED_FIXES_LIST_CAP + 2 }, (_, i) => `id${String(i).padStart(6, "0")}xx`));
check("(B) N>1 plural wording", /\d+ Platform cards have linked fixes merged/.test(many));
check("(B) capped list collapses the tail to '+2 more'", /\+2 more\.$/.test(many));

// ============================ (C)/(D) the nudge ============================
function makeWatcher(resolveLinkedFixes) {
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new IdleWatcher({
    db, pty, control: new OrchestrationControl(), recycleRatio: 0.8,
    notifyIdleWorker: () => {}, isWorkerStranded: () => true,
    ...(resolveLinkedFixes ? { resolveLinkedFixes } : {}),
  });
  return { alive, enqueued, watcher };
}
const seededIds = [];
function seedLead(w, id, projectId, agentId, role, lastActivity) {
  seededIds.push(id);
  db.insertSession({
    id, projectId, agentId, engineSessionId: "eng-" + id, title: null, cwd: repo,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: lastActivity, lastActivity, lastError: null, role,
  });
  w.alive.add(id);
}
// Warm the cache while the session is NOT yet due (recent activity -> under-window), then age it and tick
// again: the refresh is fire-and-forget, so the line shows up on the NEXT nudge, never the one that kicked it.
async function warmThenNudge(w, id, resolver) {
  w.watcher.tick(NOW);
  await resolver?.done;
  await settle(); await settle();
  const later = new Date(NOW.getTime() + 120 * 60_000);
  w.watcher.tick(later);
  return w.enqueued.filter((m) => m.id === id);
}

{
  let calls = 0; let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const w = makeWatcher(async (pid) => { calls++; resolveDone(); return pid === "pHome" ? ["esc-open-merged"] : []; });
  seedLead(w, "LEAD-1", "pHome", "agentH", "platform", minutesAgo(1));
  const nudges = await warmThenNudge(w, "LEAD-1", { done });
  check("(C) the resolver was consulted for the Lead's own board", calls >= 1);
  check("(C) the Lead's nudge fired", nudges.length === 1);
  check("(C) it carries the [loom:linked-fixes] line naming the escalation card (8-char id)",
    /\[loom:linked-fixes\] 1 Platform card has a linked fix merged: esc-open\./.test(nudges[0]?.text ?? ""));
  check("(C) the existing board-delta line is still present and untouched", /\[loom:board-delta\]/.test(nudges[0]?.text ?? ""));
}
{
  const w = makeWatcher(async () => []);
  seedLead(w, "LEAD-2", "pHome", "agentH", "platform", minutesAgo(1));
  const nudges = await warmThenNudge(w, "LEAD-2", null);
  check("(C) N=0 -> the nudge fires but carries NO linked-fixes line", nudges.length === 1 && !/linked-fixes/.test(nudges[0].text));
}
{
  // The db is shared with the Leads seeded above, so this watcher ticks them too: assert on WHICH board the
  // resolver was asked about (never the manager's own), not on a bare call count.
  let asked = 0;
  const w = makeWatcher(async (pid) => { if (pid === "pDest") asked++; return ["esc-open-merged"]; });
  seedLead(w, "MGR-1", "pDest", "agentD", "manager", minutesAgo(1));
  card("tk-actionable", "pDest", "todo");
  const nudges = await warmThenNudge(w, "MGR-1", null);
  check("(C) a MANAGER's nudge never carries the line and never consults the resolver", nudges.length === 1 && asked === 0 && !/linked-fixes/.test(nudges[0].text));
}

for (const [label, resolver] of [
  ["synchronously throws", () => { throw new Error("boom"); }],
  ["rejects", () => Promise.reject(new Error("boom"))],
  ["never settles", () => new Promise(() => {})],
]) {
  const w = makeWatcher(resolver);
  const id = `LEAD-D-${label.replace(/\W+/g, "")}`;
  seedLead(w, id, "pHome", "agentH", "platform", minutesAgo(1));
  let nudges;
  try { nudges = await warmThenNudge(w, id, null); } catch (e) { nudges = []; console.log("tick threw:", e?.message); }
  check(`(D) a resolver that ${label} still DELIVERS the nudge (no line)`, nudges.length === 1 && !/linked-fixes/.test(nudges[0].text));
}

// Real default resolver (no injection): a cold cache must not delay or block the nudge either.
{
  const w = makeWatcher(null);
  seedLead(w, "LEAD-REAL", "pHome", "agentH", "platform", minutesAgo(1));
  const nudges = await warmThenNudge(w, "LEAD-REAL", null);
  check("(D) default (real git-derived) resolver wiring: nudge delivered", nudges.length === 1);
}

// ====== (E)-(G) throttle, self-heal, pruning. Retire every Lead seeded above so call counts are clean. ======
for (const id of seededIds) db.setProcessState(id, "exited");
const IDLE_MIN = resolveConfig(undefined).orchestration.idleNudgeMinutes;
const STEP_MIN = Math.max(IDLE_MIN, 5) + 1; // one throttle window (and past the in-flight bound) plus a minute
const at = (offsetMin) => new Date(NOW.getTime() + offsetMin * 60_000);
const touch = (id, d) => db.db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(d.toISOString(), id);
// Tick at `t` with the Lead freshly active (no nudge), or `due` (a nudge is owed). Returns its nudge text, if any.
async function tickAt(w, id, offsetMin, due) {
  touch(id, due ? at(offsetMin - IDLE_MIN - 5) : at(offsetMin - 1));
  const before = w.enqueued.length;
  w.watcher.tick(at(offsetMin));
  await settle(); await settle();
  return w.enqueued.slice(before).find((m) => m.id === id)?.text;
}
let leadSeq = 0;
function freshLead(w) {
  const id = `LEAD-X${leadSeq++}`;
  seedLead(w, id, "pHome", "agentH", "platform", at(-1).toISOString());
  return id;
}
const retire = (id) => db.setProcessState(id, "exited");

// (A') the cap bounds the OPEN population: 51 NEWER terminal-column links must not crowd out an older open one.
for (let i = 0; i < LINKED_FIXES_MAX_LINKS + 1; i++) {
  card(`esc-term-${i}`, "pHome", "done");
  card(`dest-term-${i}`, "pDest", "todo");
  link(`esc-term-${i}`, `dest-term-${i}`);
}
check("(A') an older OPEN merged-fix card is still surfaced behind 51 newer terminal-column links",
  (await findPlatformCardsWithMergedFixes(db, "pHome")).includes("esc-open-merged"));

// (E) throttle: at most one refresh per idle-nudge window per Lead.
{
  let calls = 0;
  const w = makeWatcher(async () => { calls++; return []; });
  const id = freshLead(w);
  await tickAt(w, id, 0, false); await tickAt(w, id, 1, false); await tickAt(w, id, 2, false);
  check("(E) three ticks inside one window -> exactly ONE refresh", calls === 1);
  await tickAt(w, id, STEP_MIN + 2, false);
  check("(E) a tick past the window -> a second refresh", calls === 2);
  retire(id);
}

// (F) self-heal.
{
  // Abandoned in-flight: call 1 hangs; a later tick abandons it and starts call 2.
  let calls = 0; let late;
  const w = makeWatcher(() => { calls++; return calls === 1 ? new Promise((r) => { late = r; }) : Promise.resolve([]); });
  const id = freshLead(w);
  await tickAt(w, id, 0, false);
  await tickAt(w, id, 1, false);
  check("(F) a hung refresh blocks a second one while within the in-flight bound", calls === 1);
  await tickAt(w, id, STEP_MIN + 1, false);
  check("(F) past the in-flight bound the hung refresh is ABANDONED and a new one starts", calls === 2);
  late(["esc-stale-abandoned"]); await settle(); await settle();
  const text = await tickAt(w, id, 2 * STEP_MIN + 2, true);
  check("(F) the abandoned attempt's late completion never writes the line", typeof text === "string" && !/linked-fixes|esc-stal/.test(text));
  retire(id);
}
{
  // K straight failures clear a previously-good line (control: still present after K-1).
  let calls = 0;
  const w = makeWatcher(() => { calls++; return calls === 1 ? Promise.resolve(["esc-open-merged"]) : Promise.reject(new Error("boom")); });
  const id = freshLead(w);
  await tickAt(w, id, 0, false);                      // call 1: good -> line set
  await tickAt(w, id, STEP_MIN, false);               // call 2: fail 1
  await tickAt(w, id, 2 * STEP_MIN, false);           // call 3: fail 2
  const afterTwo = await tickAt(w, id, 3 * STEP_MIN, true); // nudge composed BEFORE call 4 lands; K-1=2 failures so far
  check("(F) control: after K-1 failures the last good line is still shown", /linked-fixes/.test(afterTwo ?? ""));
  const afterThree = await tickAt(w, id, 4 * STEP_MIN, true); // call 4 was fail 3 -> line cleared
  check("(F) after K straight failures the line is cleared (no line beats a stale one)", typeof afterThree === "string" && !/linked-fixes/.test(afterThree));
  retire(id);
}
{
  // A successful refresh returning [] clears an existing line.
  let calls = 0;
  const w = makeWatcher(() => Promise.resolve(++calls === 1 ? ["esc-open-merged"] : []));
  const id = freshLead(w);
  await tickAt(w, id, 0, false);
  const first = await tickAt(w, id, STEP_MIN, true);
  check("(F) control: the line is shown while the refresh still said so", /linked-fixes/.test(first ?? ""));
  const second = await tickAt(w, id, 2 * STEP_MIN, true);
  check("(F) a refresh that returns [] clears the line", typeof second === "string" && !/linked-fixes/.test(second));
  retire(id);
}

// (G) pruning / exited Lead.
{
  // Warm a line, exit the Lead, tick (prunes), revive it with a hung resolver: no line may survive.
  let calls = 0;
  const w = makeWatcher(() => (++calls === 1 ? Promise.resolve(["esc-open-merged"]) : new Promise(() => {})));
  const id = freshLead(w);
  await tickAt(w, id, 0, false);
  retire(id);
  w.watcher.tick(at(1)); await settle();
  db.setProcessState(id, "live");
  const text = await tickAt(w, id, STEP_MIN + 2, true);
  check("(G) a Lead that exited (and was pruned) does not keep its old line when it returns", typeof text === "string" && !/linked-fixes/.test(text));
  retire(id); // the next block counts resolver calls: no other live Lead may share this board
}
{
  // A refresh that completes AFTER the Lead exited (no prune tick in between) must not write a line.
  let calls = 0; let done;
  const w = makeWatcher(() => (++calls === 1 ? new Promise((r) => { done = r; }) : new Promise(() => {})));
  const id = freshLead(w);
  await tickAt(w, id, 0, false);
  retire(id);
  done(["esc-open-merged"]); await settle(); await settle();
  db.setProcessState(id, "live");
  const text = await tickAt(w, id, STEP_MIN + 2, true);
  check("(G) a refresh completing after the Lead exited never re-adds a line", typeof text === "string" && !/linked-fixes/.test(text));
  retire(id);
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
