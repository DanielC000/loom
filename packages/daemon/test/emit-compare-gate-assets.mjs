import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// EMIT-COMPARE REDUCED-GATE test — THE ASSETS SCOPE (card 3fbd95e0). Split into its own file, same reasoning
// `_emit-compare-fixtures.mjs` already documents for the A-G/H-L split: keep each scenario file well under
// the harness's per-file `TEST_TIMEOUT_MS` ceiling. Same REAL-git-on-temp-repos style as its siblings
// `emit-compare-gate.mjs`/`emit-compare-gate-scope.mjs`.
//
// Proves:
//   (P) POSITIVE — a diff confined to `packages/daemon/assets/**` REDUCES: build + static guards run, PLUS
//       every certified `ASSET_READING_TEST_REPO_PATHS` name via `--only=` — never the full ~844-file suite.
//   (Q) NEGATIVE (mixed diff) — the SAME assets change riding alongside an ADDED (status "A") compiled `.ts`
//       file in the SAME diff MUST still run the FULL gate: an allowlist match on the assets half never
//       licenses skipping when the src half is unreducible.
//   (R) DIRECT CALL — `computeEmitCompareGate` on an assets-only diff returns `eligible:true`,
//       `changedAssetPaths` naming the changed path, `changedTestFiles:[]` (no test/*.mjs touched), and
//       `buildReducedGateCommand` on that result's own fields includes EVERY certified asset-reading test
//       name plus `pnpm build` and every static guard — never the unfiltered `test:daemon` suite.
//   (S) DELETED asset path (status "D", no other change) still reduces — there is no per-file identity proof
//       for an asset the way there is for a compiled `.ts` file, so every status widens to the certified set.
// Run: 1) build daemon (pnpm build), 2) node test/emit-compare-gate-assets.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ecga-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

// Dynamic, AFTER the LOOM_HOME override above — see emit-compare-gate.mjs's own identical comment for why a
// static import here would be hoisted ahead of that override and lock paths.js's DB_PATH to the real ~/.loom.
const {
  GIT_ID, FULL_GATE, GUARD_BASENAMES, ASSET_TEST_BASENAMES, seed, mkdirp, mk,
} = await import("./_emit-compare-fixtures.mjs");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, buildReducedGateCommand, computeEmitCompareGate } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A bare repo with no changed `.ts` file at all needs none of makeRepoWithBaseSrcFile's tsconfig scaffolding
// — computeEmitCompareGate only ever consults emitCompareSoundnessOk when changedTsFiles.length > 0 (see
// that function's own guard, git/worktrees.ts). Mirrors merge-gate-inert-diff.mjs's own bare `makeRepo`.
function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ecga\n");
  execSync(`git init -q && git config user.email ecga@loom && git config user.name ecga && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const dbs = [];
const worktrees = [];
try {
  // ── (P) POSITIVE — assets-only diff REDUCES, running the certified asset-reading test set ──────────────
  {
    const P = mk("p");
    makeRepo(P);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = worktreePath; P.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill", "SKILL.md"), "# skill\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: edit SKILL.md"`, { cwd: worktreePath });
    seed(db, P);

    const confirm = await sessions.confirmWorkerMerge(P.mgrId, P.workerId);
    check("(P) merged:true", confirm.merged === true);
    check("(P) gateRan:true — a real (smaller) gate still spawns", confirm.gateRan === true);
    check("(P) the gate command WAS called exactly once", calls === 1);
    check("(P) captured command is NOT the full gate — an assets-only diff must NOT run the full suite (RED-first: this is FALSE against pre-3fbd95e0 code, which has no assets scope at all)", capturedGate !== FULL_GATE);
    check("(P) captured command DOES still run pnpm build", capturedGate.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(P) captured command runs static guard ${g}`, capturedGate.includes(g));
    check("(P) captured command runs test:daemon THROUGH --only= (never the unfiltered ~844-file suite)", /test:daemon --only=/.test(capturedGate));
    for (const name of ASSET_TEST_BASENAMES) check(`(P) captured command's --only= names certified asset-reading test ${name}`, capturedGate.includes(name));
    check("(P) a distinguishing warning is present", typeof confirm.warning === "string" && /reduced/.test(confirm.warning));
    check("(P) warning names the changed asset path", typeof confirm.warning === "string" && confirm.warning.includes("packages/daemon/assets/skills/some-skill/SKILL.md"));
    check("(P) warning names the certified asset-reading test count", typeof confirm.warning === "string" && confirm.warning.includes(`${ASSET_TEST_BASENAMES.length} certified asset-reading test`));
  }

  // ── (Q) NEGATIVE — the SAME assets change alongside an ADDED .ts file MUST still full-gate ─────────────
  {
    const Q = mk("q");
    makeRepo(Q);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0; let capturedGate;
    const fakeGate = async (gate) => { calls++; capturedGate = gate; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(Q.repo, Q.projId, Q.taskId);
    Q.worktreePath = worktreePath; Q.branch = branch; worktrees.push(worktreePath);
    mkdirp(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "assets", "skills", "some-skill", "SKILL.md"), "# skill\n");
    mkdirp(path.join(worktreePath, "packages", "daemon", "src"));
    fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", "second.ts"), "export const y = 1;\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feat: skill doc + add second.ts"`, { cwd: worktreePath });
    seed(db, Q);

    const confirm = await sessions.confirmWorkerMerge(Q.mgrId, Q.workerId);
    check("(Q) gateRan:true", confirm.gateRan === true);
    check("(Q) the gate command WAS called exactly once", calls === 1);
    check("(Q) captured command IS the full gate — an ADDED compiled file forces the whole diff closed, assets half included", capturedGate === FULL_GATE);
    check("(Q) emitCompareReduced is false — the predicate genuinely ran and decided not-reduced, never a fabricated skip", confirm.emitCompareReduced === false);
  }

  // ── (R) DIRECT CALL — computeEmitCompareGate's own returned fields on an assets-only diff ──────────────
  {
    const R = mk("r");
    makeRepo(R);
    const baseSha = execSync("git rev-parse HEAD", { cwd: R.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(R.repo, R.projId, R.taskId);
    R.worktreePath = worktreePath; R.branch = branch; worktrees.push(worktreePath);
    const changedPath = path.join("packages", "daemon", "assets", "skill-fragments", "example.md");
    mkdirp(path.join(worktreePath, "packages", "daemon", "assets", "skill-fragments"));
    fs.writeFileSync(path.join(worktreePath, changedPath), "# fragment\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "docs: add fragment"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(R.repo, worktreePath, baseSha, branch);
    check("(R) direct call: eligible:true", direct.eligible === true);
    check("(R) direct call: changedAssetPaths names the changed path", direct.changedAssetPaths.length === 1 && direct.changedAssetPaths[0] === changedPath.split(path.sep).join("/"));
    check("(R) direct call: changedTestFiles is empty — no test/*.mjs path touched", direct.changedTestFiles.length === 0);
    check("(R) direct call: notApplicable:false — a real reducibility decision was made", direct.notApplicable === false);

    const built = buildReducedGateCommand(direct.changedTestFiles, direct.changedAssetPaths);
    check("(R) buildReducedGateCommand(direct fields) runs pnpm build", built.includes("pnpm build"));
    for (const g of GUARD_BASENAMES) check(`(R) buildReducedGateCommand(direct fields) runs static guard ${g}`, built.includes(g));
    for (const name of ASSET_TEST_BASENAMES) check(`(R) buildReducedGateCommand(direct fields) --only= names ${name}`, built.includes(name));
    check("(R) buildReducedGateCommand(direct fields) does NOT run the full suite unfiltered", built.includes("--only="));
    // Backward-compat: the same call with NO second argument (every pre-3fbd95e0 call site) stays byte
    // identical — no assets names folded in when the caller never passes them.
    const builtNoAssets = buildReducedGateCommand(direct.changedTestFiles);
    check("(R) buildReducedGateCommand with no assets arg omits every certified asset-reading test", !ASSET_TEST_BASENAMES.some((n) => builtNoAssets.includes(n)));
  }

  // ── (S) DELETED asset path, alone, still reduces — no per-file identity proof exists for an asset ──────
  {
    const S = mk("s");
    fs.mkdirSync(S.repo, { recursive: true });
    registerForCleanup(S.repo);
    fs.writeFileSync(path.join(S.repo, "README.md"), "# ecga\n");
    mkdirp(path.join(S.repo, "packages", "daemon", "assets", "skills", "doomed-skill"));
    fs.writeFileSync(path.join(S.repo, "packages", "daemon", "assets", "skills", "doomed-skill", "SKILL.md"), "# doomed\n");
    execSync(`git init -q && git config user.email ecga@loom && git config user.name ecga && git add . && git ${GIT_ID} commit -q -m init`, { cwd: S.repo });
    const baseSha = execSync("git rev-parse HEAD", { cwd: S.repo }).toString().trim();
    const { worktreePath, branch } = await createWorktree(S.repo, S.projId, S.taskId);
    S.worktreePath = worktreePath; S.branch = branch; worktrees.push(worktreePath);
    fs.rmSync(path.join(worktreePath, "packages", "daemon", "assets", "skills", "doomed-skill"), { recursive: true, force: true });
    execSync(`git add -A . && git ${GIT_ID} commit -q -m "chore: retire doomed-skill"`, { cwd: worktreePath });

    const direct = await computeEmitCompareGate(S.repo, worktreePath, baseSha, branch);
    check("(S) direct call: eligible:true for a DELETED-only asset path", direct.eligible === true);
    check("(S) direct call: changedAssetPaths names the deleted path", direct.changedAssetPaths.length === 1 && /doomed-skill\/SKILL\.md$/.test(direct.changedAssetPaths[0]));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an assets-only diff reduces to build + static guards + the certified ASSET_READING_TEST_REPO_PATHS set (never the full suite); the same assets change alongside an ADDED .ts file still fails closed to the full gate; computeEmitCompareGate's own changedAssetPaths field and buildReducedGateCommand's optional second argument are wired end to end and stay backward-compatible when omitted; and a DELETED-only asset path reduces exactly like an added/modified one, since no per-file identity proof exists for a non-compiled asset (card 3fbd95e0)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
