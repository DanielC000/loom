// _emit-compare-fixtures.mjs — shared fixture helpers for the emit-compare-gate test SUITE.
//
// Card 4dfc648a (DoD-3): `emit-compare-gate.mjs` used ~112.5s of its 120s per-FILE harness ceiling
// standalone (~94%) — the tightest margin of any test in the project, with no `TEST_TIMEOUT_OVERRIDES`
// entry and no evidence a growing allowlist is the right fix (that list has already been shown to miss
// real cases — this file's old, unsplit self was the proof). The actual cost is REAL git subprocess work:
// each scenario below does a real `git init`/commit/worktree-add/squash-merge, and the suite had grown to
// thirteen such scenarios (cards dd4349ff, manager-review #128, 815b4b30, 44968963, 7183540f each adding
// more) sharing one file. `TEST_TIMEOUT_MS` (scripts/test-daemon.mjs) is a PER-FILE ceiling, so the fix
// that doesn't touch any timeout constant is to split the scenarios across two files — full coverage
// preserved, per-file standalone margin roughly halved. See `emit-compare-gate.mjs` (scenarios A-G) and
// `emit-compare-gate-scope.mjs` (scenarios H-L) for the split; this module holds what both share so
// neither copy can drift from the other. The leading underscore excludes this file from harness discovery
// (`isUnderscoreExcluded` in scripts/test-daemon.mjs) — it is never run as a test on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerForCleanup } from "./_tmp-fixture.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const GIT_ID = "-c user.email=ecg@loom -c user.name=ecg";
export const now = new Date().toISOString();
export const FULL_GATE = "pnpm build && pnpm --filter @loom/daemon test:daemon";
export const GUARD_BASENAMES = ["clock-path-regression-guard.mjs", "fixed-wait-negative-guard.mjs", "onexit-discard-guard.mjs", "codescape-privacy-guard.mjs", "fixed-wait-witness-guard.mjs"];

// Card 815b4b30: (I)/(J)/(K) (in emit-compare-gate-scope.mjs) need each fixture repo to carry a REAL,
// importable packages/daemon/scripts/test-daemon.mjs so `loadExcludedTestDirNames` (git/worktrees.ts) can
// actually resolve `EXCLUDED_DIR_NAMES` from it — using the REAL file's content (not a hand-typed stub)
// means those tests exercise the genuine reuse path end to end, with zero risk of a second, drifting copy
// of the fixtures/census name list.
export const REAL_TEST_DAEMON_SCRIPT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test-daemon.mjs"), "utf8",
);

export function seed(db, p) {
  db.insertProject({ id: p.projId, name: "ECG", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: FULL_GATE } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "ECG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

export const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
export const mk = (label) => ({
  projId: `ecg-${label}-proj-${sfx}`, agentId: `ecg-${label}-agent-${sfx}`, taskId: `ecg-${label}-task-${sfx}`,
  mgrId: `ecg-${label}-mgr-${sfx}`, workerId: `ecg-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ecg-${label}-${sfx}`),
});

export const BASE_SRC = [
  "// explains what isReady checks",
  "export function isReady(x: number): boolean {",
  "  return x === 0;",
  "}",
  "",
].join("\n");

// `packageTsconfigOpts` defaults to a clean `{outDir:"dist",rootDir:"src",types:["node"]}`-shaped block (no
// emitDecoratorMetadata) — pass an override to construct the (G) violation fixture.
export function makeRepoWithBaseSrcFile(p, srcContent, packageTsconfigOpts = { outDir: "dist", rootDir: "src", types: ["node"] }) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo);
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ecg\n");
  // A minimal tsconfig.base.json AND packages/daemon/tsconfig.json, both with no emitDecoratorMetadata:
  // emitCompareSoundnessOk reads BOTH from the WORKTREE (not the real Loom repo, mirroring the real
  // extends chain: packages/daemon/tsconfig.json extends tsconfig.base.json and carries its OWN
  // compilerOptions block) — without both present, every .ts scenario would fail closed for the WRONG
  // reason (a missing fixture file), masking whether the real comparison logic is what decided eligibility.
  fs.writeFileSync(path.join(p.repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
  mkdirp(path.join(p.repo, "packages", "daemon", "src"));
  fs.writeFileSync(path.join(p.repo, "packages", "daemon", "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: packageTsconfigOpts }));
  fs.writeFileSync(path.join(p.repo, "packages", "daemon", "src", "example.ts"), srcContent);
  execSync(`git init -q && git config user.email ecg@loom && git config user.name ecg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}
