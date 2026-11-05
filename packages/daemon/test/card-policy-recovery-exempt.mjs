import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — a card policy added AFTER a worker was admitted must never strand it. Real git, fake ptys,
// no claude, no daemon.
//   (R) recycle: a LIVE worker on a card whose policy (every requirement unmet) was added mid-flight is recycled
//       without refusal — the successor is spawned and live.
//   (V) revive is NOT a recovery path for the policy: worker_revive forks onto a FOLLOW-UP card, which runs the full
//       spawn-phase policy for THAT card (refused while unmet, no worker row / pty; admitted once satisfied), and a
//       revived worker on a checkpoint card gets the checkpoint kickoff paragraph. Only recycle (and boot-reconcile)
//       continue the SAME admitted card and are exempt.
//   Boot-reconcile / crash-orphan resume never reach spawnWorker at all (pinned by card-policy-source-pins.mjs's
//   source-text caller census); this file does NOT drive a real boot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
const tmpHome = useOwnLoomHome("cpr-");
requireHermeticEnv();
// revive reads the source transcript from the engine's per-user store: sandbox it (and the ambient override).
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { makeEnv, policy, closeAll } = await import("./_card-policy-fixture.mjs");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return String(e?.message ?? e); } };
const ALL_UNMET = [{ kind: "approved-request" }, { kind: "code-review-report" }, { kind: "investigate-checkpoint" }];

const e = await makeEnv();

// ── (R) recycle ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const t = e.addTask("rc");
  const live = await e.sessionsSpawn.spawnWorker(e.mgrId, { taskId: t, agentId: e.agentId, kickoffPrompt: "KICK" });
  check("(R0) setup: the worker was admitted before any policy existed", !!live?.id && e.db.getSession(live.id).taskId === t);
  e.setPolicies([policy({ require: ALL_UNMET })]);
  check("(R0) setup: the policy is NOW live and would refuse a fresh spawn on this card", !!(await throws(() => e.sessionsSpawn.spawnWorker(e.mgrId, { taskId: e.addTask("rc-probe"), agentId: e.agentId, kickoffPrompt: "KICK" }))));
  let successor = null, err = null;
  try { successor = await e.sessionsSpawn.recycleWorker(e.mgrId, live.id, "HANDOFF_TEXT"); } catch (x) { err = String(x?.message ?? x); }
  check(`(R1) recycle of a live worker after a policy was added is NOT refused (${err ?? "ok"})`, !err && !!successor?.id);
  check("(R1) the successor is bound to the same card and was handed a pty", successor && e.db.getSession(successor.id).taskId === t && !!e.optsFor(successor.id));
}

// ── (V) revive ────────────────────────────────────────────────────────────────────────────────────────────────
{
  e.setPolicies(undefined);
  const OLD_CWD = path.join(os.tmpdir(), `cpr-gone-${process.pid}`, "old-worktree");
  const ENG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const tpath = engineTranscriptPath(OLD_CWD, ENG);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "remember PLUM-7431" } }) + "\n");
  const tOrig = e.addTask("orig", "feat(cpf): the original landed card");
  e.db.updateTask(tOrig, { columnKey: "done", mergedSha: "abc1234def" });
  e.db.insertSession({ id: "cpr-src", projectId: e.projId, agentId: e.agentId, engineSessionId: ENG, title: null, cwd: OLD_CWD, processState: "exited", resumability: "dead", busy: false, createdAt: e.now, lastActivity: e.now, lastError: null, role: "worker", parentSessionId: e.mgrId, taskId: tOrig, worktreePath: OLD_CWD, branch: "loom/old" });
  e.db.appendEvent({ id: "cpr-ev-src", ts: e.now, managerSessionId: e.mgrId, workerSessionId: "cpr-src", taskId: tOrig, kind: "merge_done", detail: { branch: "loom/old" } });
  e.setPolicies([policy({ require: ALL_UNMET })]);
  const followUp = e.addTask("fix", "feat(cpf): follow-up on the landed card");
  const plain = await throws(() => e.sessionsSpawn.spawnWorker(e.mgrId, { taskId: followUp, agentId: e.agentId, kickoffPrompt: "KICK" }));
  check("(V0) control: a plain worker_spawn onto the follow-up card IS refused by the policy", !!plain && /Feat policy/.test(plain));
  const workersBefore = e.db.listWorkers(e.mgrId).length;
  const refused = await throws(() => e.sessionsSpawn.reviveWorker(e.mgrId, { workerSessionId: "cpr-src", taskId: followUp, note: "NOTE" }));
  check(`(V1) worker_revive onto a follow-up card whose approved-request is unmet IS refused by the spawn policy (${refused ? refused.slice(0, 60) : "NOT refused"})`, !!refused && /Feat policy/.test(refused) && /permission Request/.test(refused));
  check("(V1) the refused revive created NO worker row", e.db.listWorkers(e.mgrId).length === workersBefore);
  e.fileRequest({ taskId: followUp });
  let revived = null, err = null;
  try { revived = await e.sessionsSpawn.reviveWorker(e.mgrId, { workerSessionId: "cpr-src", taskId: followUp, note: "NOTE" }); } catch (x) { err = String(x?.message ?? x); }
  check(`(V2) once the follow-up card's policy is satisfied the revive is admitted (${err ?? "ok"})`, !err && !!revived?.id);
  check("(V2) the revived worker is bound to the follow-up card", revived && e.db.getSession(revived.id).taskId === followUp);
  const prompt = e.optsFor(revived?.id)?.startupPrompt ?? "";
  check("(V2) the revived worker's kickoff carries the read-only CARD POLICY block", prompt.includes("CARD POLICY"));
  check("(V2) ...and, because the follow-up card has an investigate-checkpoint requirement, the checkpoint paragraph", prompt.includes("report your plan with worker_report"));
}

closeAll();
console.log(failures === 0 ? "\n✅ ALL PASS — card-policy recovery exemptions" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
