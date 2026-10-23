import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers checkMainlineMove's boot-path store() never re-stamping per-branch trust, a repo rebind wiping every trust record, the Platform Lead's own git_checkout (never re-points W), and every case-fold / path-prefix branch-name collision refusal:
//   - (C3) checkMainlineMove's BOOT-path store() must NEVER re-stamp the per-branch
//   - (C7) a repo rebind wipes every per-branch trust record too, not just W (M3-iii)
//   - (OK / LEAD): SUCCESS via create:true, then the Platform Lead's own checkout
//   - (LEAD) the Platform Lead's own git_checkout does NOT re-point W
//   - (CASEFOLD A) create:true "FEAT" over a PACKED "feat" ⇒ refused, naming feat; feat's own sha is untouched (seventh CR, MAJOR 1)
//   - (CASEFOLD B) switch to "FEAT" over a PACKED "feat" ⇒ refused (seventh CR, MAJOR 1)
//   - (CASEFOLD C) switch to "FEAT" over a LOOSE "feat" (never packed) ⇒ refused — the
//   - (CASEFOLD D1) create:true "FEAT/X" over a PACKED "feat/x" ⇒ refused (seventh CR, MAJOR 1)
//   - (CASEFOLD D2) create:true "FEAT/x" over a LOOSE "feat/y" ⇒ refused — the
//   - (NEVER-TWO-SPELLINGS) a branch's trust record is never keyed under two
//   - (SHADOW-EXACT) the remote-tracking shadow match is EXACT, never a loose "/branch"
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-casefold.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-casefold-");

import {
  loadPcbDistModules, makeFixtureKit, git, commitAll, GIT_ID, callTool,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db, PlatformMcpRouter } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (C3) checkMainlineMove's BOOT-path store() must NEVER re-stamp the per-branch
  //                        trust record (card f683a5ad) — only W advances =====================
  {
    const fx = makeFixture("c3boot");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    const landedSha = fx.watermark().sha;
    check("(C3) setup: trust stamped by the landing", fx.trust(fx.main) === landedSha);
    // checkMainlineMove's "w.sha === head.tip" shortcut returns EARLY, skipping store() entirely, when
    // nothing has moved since the landing — so an UNCHANGED boot check can never exercise it. Advancing
    // with an ORDINARY (non-Loom) commit forces a real classification: classifyMainlineMove treats a
    // genuine porcelain commit as "explained"/benign (same technique the (LNDR)/(DEDUPE) scenarios use
    // for the OPPOSITE case — a raw `update-ref` — to prove the alert path instead).
    fs.writeFileSync(path.join(fx.repo, "c3.txt"), "c3\n");
    commitAll(fx.repo, "chore(x): ordinary advance for the boot check to classify", GIT_ID);
    const advancedTip = fx.canonHead();
    check("(C3) setup: HEAD advanced past W via an ordinary (non-Loom) commit", advancedTip !== landedSha);
    await fx.sessions.checkMainlineMovesOnBoot();
    check("(C3) THE FIX (card f683a5ad): the boot path's own checkMainlineMove store() leaves the trust record exactly as the landing left it — NEVER re-stamped to the newly-classified tip", fx.trust(fx.main) === landedSha);
    check("(C3) W itself still advances to the new tip (4fa36502's own protected dedupe — unaffected by this card)", fx.watermark()?.sha === advancedTip);
  }

  // ===================== (C7) a repo rebind wipes every per-branch trust record too, not just W (M3-iii) =====================
  {
    const fx = makeFixture("c7rebind");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(C7) setup: trust stamped by the landing", fx.trust(fx.main) === fx.watermark().sha);
    db.updateProject(fx.projId, { repoPath: path.join(os.tmpdir(), `loom-pcb-c7-other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) });
    check("(C7) rebind wipes the per-branch trust record too (C7)", fx.trust(fx.main) === null);
    check("(C7) rebind also wipes W itself (pre-existing behavior, unchanged)", fx.watermark() === null);
  }

  // ===================== (OK / LEAD): SUCCESS via create:true, then the Platform Lead's own checkout =====================
  let okFx;
  {
    const fx = makeFixture("ok", { withPlatform: true });
    okFx = fx;
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(OK) setup: a real landing establishes W on main FIRST", seeded.settled === true && seeded.ok === true && seeded.value.merged === true && fx.watermark()?.branch === fx.main && fx.watermark()?.sha === fx.canonHead());

    const created = await fx.call("project_checkout_branch", { branch: "atlas", create: true });
    check("(OK) create:true switches to a brand-new atlas", created.ok === true && created.created === true && fx.canonBranch() === "atlas");

    // THE POINT (removing the re-point would turn this RED): a worker spawned AFTER the switch, forked
    // from the NEW checkout, lands on atlas — not main — with no branchDiverted refusal.
    const afterSwitch = await fx.addWorker("post");
    const confirmResult = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, afterSwitch.workerId);
    check("(OK) the solo merge confirm lands cleanly (NO branchDiverted refusal)", confirmResult.settled === true && confirmResult.ok === true && confirmResult.value.merged === true && !confirmResult.value.branchDiverted);
    const landedSha = fx.canonHead();
    check("(OK) canonical is still on atlas after the landing", fx.canonBranch() === "atlas");
    check("(OK) the watermark advanced to the new landed tip, branch unchanged", fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === landedSha);
  }

  // ===================== (LEAD) the Platform Lead's own git_checkout does NOT re-point W =====================
  {
    const fx = okFx;
    git(fx.repo, "checkout", "-q", fx.main);
    const wBeforeLead = fx.watermark();
    const evCountBefore = fx.mwEvents().length;
    const platform = new PlatformMcpRouter(db, fx.sessions);
    const leadResult = await callTool(platform.buildServer(fx.pfmId), "git_checkout", { projectId: fx.projId, branch: fx.main });
    check("(LEAD) setup control: the Lead's own git_checkout actually succeeded", leadResult.ok === true && leadResult.branch === fx.main);
    check("(LEAD) canonical really moved back to main", fx.canonBranch() === fx.main);
    check("(LEAD) THE POINT: W is UNCHANGED by the Lead's checkout — still atlas, not re-pointed to main", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeLead) && fx.watermark()?.branch === "atlas");
    check("(LEAD) no new manager-checkout audit event was filed by the Lead's call", fx.mwEvents().length === evCountBefore);
  }

  // ===================== (CASEFOLD A) create:true "FEAT" over a PACKED "feat" ⇒ refused, naming feat; feat's own sha is untouched (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-a");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(CASEFOLD A) create:true \"FEAT\" over a packed \"feat\" is refused", r.ok === false);
    check("(CASEFOLD A) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(CASEFOLD A) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
    check("(CASEFOLD A) no local \"FEAT\" ref was ever created", (() => { try { git(fx.repo, "rev-parse", "--verify", "--quiet", "refs/heads/FEAT"); return false; } catch { return true; } })());
  }

  // ===================== (CASEFOLD B) switch to "FEAT" over a PACKED "feat" ⇒ refused (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-b");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(CASEFOLD B) switch to \"FEAT\" over a packed \"feat\" is refused", r.ok === false);
    check("(CASEFOLD B) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(CASEFOLD B) canonical is untouched (still on main)", fx.canonBranch() === fx.main);
  }

  // ===================== (CASEFOLD C) switch to "FEAT" over a LOOSE "feat" (never packed) ⇒ refused — the
  // exact CR8 "(C)" case: the OLD rev-parse-based check could resolve "FEAT" via NTFS case-folding and
  // then misdiagnose it as "no trusted baseline" instead of naming the real collision =====================
  {
    const fx = makeFixture("casefold-c");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(CASEFOLD C) switch to \"FEAT\" over a loose \"feat\" is refused", r.ok === false);
    check("(CASEFOLD C) the refusal names the real branch \"feat\", not a \"no trusted baseline\" misdiagnosis", /"feat"/.test(r.error) && !/no trusted baseline/.test(r.error));
    check("(CASEFOLD C) canonical is untouched (still on main)", fx.canonBranch() === fx.main);
    // negative control: the exact, real-cased name still switches cleanly.
    const ok = await fx.call("project_checkout_branch", { branch: "feat" });
    check("(CASEFOLD C) negative control: the exact existing name \"feat\" switches cleanly", ok.ok === true && fx.canonBranch() === "feat");
  }

  // ===================== (CASEFOLD D1) create:true "FEAT/X" over a PACKED "feat/x" ⇒ refused (seventh CR, MAJOR 1) =====================
  {
    const fx = makeFixture("casefold-d1");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat/x");
    fx.trustBranch("feat/x");
    git(fx.repo, "pack-refs", "--all");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT/X", create: true });
    check("(CASEFOLD D1) create:true \"FEAT/X\" over a packed \"feat/x\" is refused", r.ok === false);
    check("(CASEFOLD D1) the refusal names the colliding existing branch \"feat/x\"", /"feat\/x"/.test(r.error));
  }

  // ===================== (CASEFOLD D2) create:true "FEAT/x" over a LOOSE "feat/y" ⇒ refused — the
  // reverse shape: the candidate's own leaf segment collides with an existing branch's DIRECTORY segment
  // (seventh CR, MINOR 4 / D2) =====================
  {
    const fx = makeFixture("casefold-d2");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat/y");
    fx.trustBranch("feat/y");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT/x", create: true });
    check("(CASEFOLD D2) create:true \"FEAT/x\" over a loose \"feat/y\" is refused", r.ok === false);
    check("(CASEFOLD D2) the refusal names the colliding directory component via \"feat/y\"", /"feat"/.test(r.error) && /"feat\/y"/.test(r.error));
    // negative control: a genuinely non-colliding sibling under the SAME exact-case directory still works.
    const ok = await fx.call("project_checkout_branch", { branch: "feat/z", create: true });
    check("(CASEFOLD D2) negative control: a non-colliding sibling \"feat/z\" (same exact-case directory) still creates cleanly", ok.ok === true && ok.created === true && fx.canonBranch() === "feat/z");
  }

  // ===================== (NEVER-TWO-SPELLINGS) a branch's trust record is never keyed under two
  // case-spellings of the same name — this record's own claim, checked directly =====================
  {
    const fx = makeFixture("never-two-spellings");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featTrustBefore = fx.trust("feat");
    git(fx.repo, "pack-refs", "--all");
    await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    await fx.call("project_checkout_branch", { branch: "FEAT" });
    check("(NEVER-TWO-SPELLINGS) no trust record was ever stamped under the colliding case \"FEAT\"", fx.trust("FEAT") == null);
    check("(NEVER-TWO-SPELLINGS) \"feat\"'s own trust record is untouched", fx.trust("feat") === featTrustBefore);
  }

  // ===================== (SHADOW-EXACT) the remote-tracking shadow match is EXACT, never a loose "/branch"
  // suffix — round 11's suffix match over-matched refs/remotes/origin/hotfix/zzz as a shadow of a switch to
  // "zzz" (seventh CR, MAJOR 2) =====================
  {
    const fx = makeFixture("shadow-exact-negative");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    git(fx.repo, "update-ref", "refs/remotes/origin/hotfix/zzz", fx.canonHead());
    const negative = await fx.call("project_checkout_branch", { branch: "zzz" });
    check("(SHADOW-EXACT) switching to \"zzz\" when only \"refs/remotes/origin/hotfix/zzz\" exists is an ORDINARY refusal, not a shadow match", negative.ok === false && !/remote-tracking ref/.test(negative.error));
    check("(SHADOW-EXACT) no HIGH event was filed for the non-match", fx.mwEvents().length === 0);
  }
  {
    const fx = makeFixture("shadow-exact-positive");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    git(fx.repo, "update-ref", "refs/remotes/origin/zzz", fx.canonHead());
    const positive = await fx.call("project_checkout_branch", { branch: "zzz" });
    check("(SHADOW-EXACT) positive control: switching to \"zzz\" when \"refs/remotes/origin/zzz\" exists IS the shadow case", positive.ok === false && /remote-tracking ref/.test(positive.error));
    check("(SHADOW-EXACT) positive control files a HIGH event naming remote-tracking-shadow", fx.mwEvents().some((e) => e.detail.evidence.includes("remote-tracking-shadow")));
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "checkMainlineMove's boot-path store() never re-stamping per-branch trust, a repo rebind wiping every trust record, the Platform Lead's own git_checkout (never re-points W), and every case-fold / path-prefix branch-name collision refusal" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
