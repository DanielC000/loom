import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bba7a8ec — computeDeployStalenessAsync() runs EVERY git read of the staleness computation through its
// async seam, not only the three unconditional history walks. HERMETIC: fake `.git` dir + dist/tsconfig
// fixtures for the stubbed scenarios (no git at all), and a throwaway real git repo for the equivalence ones.
//
// Proves:
//   (A) EACH READ IS CONSUMED: every read the computation can issue returns DISTINCTIVE output from the
//       stub, and the result carries it (HEAD sha, both history counts, the ancestor verdict, the commit
//       date, the content diff, the behavioural diff + both `git show` snapshots). An unknown argv throws
//       from the stub, so a drifted argv cannot silently fall through to a real read.
//   (B) EQUIVALENCE with processBuiltSha set, against REAL git: ancestor (inert diff), ancestor (behavioural
//       diff), non-ancestor, and not-stale-with-signature-mismatch — async result deep-equals the sync one.
//   (C) NON-BLOCKING ON THE CONDITIONAL READS: with every read slowed, a ticking timer keeps firing across the
//       is-ancestor / diff / show reads too, not just the first three.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dsar-"));
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { computeDeployStaleness, computeDeployStalenessAsync, MAX_ANCESTOR_BEHAVIOURAL_CHECK_FILES } = await import("../dist/deploy-staleness.js");

const SEP = "\x1f";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeTsconfigs = (root) => {
  for (const rel of ["tsconfig.base.json", "packages/daemon/tsconfig.json", "packages/shared/tsconfig.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '{ "compilerOptions": {} }\n');
  }
};
const makeDist = (root, mtime) => {
  const out = {};
  for (const [k, rel, file] of [["distEntry", "packages/daemon/dist", "index.js"], ["sharedDist", "packages/shared/dist", "x.js"], ["webDist", "packages/web/dist", "index.html"]]) {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, file);
    fs.writeFileSync(f, "x");
    fs.utimesSync(f, mtime, mtime);
    out[k] = k === "distEntry" ? f : dir;
  }
  return out;
};

// ===================== (A) each read consumed — fully stubbed, no git =====================
const stubRoot = path.join(tmpHome, "stub-repo");
fs.mkdirSync(path.join(stubRoot, ".git"), { recursive: true });
writeTsconfigs(stubRoot);
fs.mkdirSync(path.join(stubRoot, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(stubRoot, "packages", "shared", "src"), { recursive: true });
fs.writeFileSync(path.join(stubRoot, "packages", "daemon", "src", "a.ts"), "export const a = 1;\n");
const stubDist = makeDist(stubRoot, new Date("2026-01-01T12:00:00Z"));
const stubOpts = { ...stubDist, repoRoot: stubRoot, processStartedAt: "2026-01-04T00:00:00Z", processBuiltDirty: false };

const HEAD = "b".repeat(40);
const BUILT = "a".repeat(40);
const headLine = `${HEAD}${SEP}2026-02-01T00:00:00Z`;
// 2 commits after the dist clock (Jan 1 12:00), 1 before it.
const relevantLog = [`${"1".repeat(40)}${SEP}2026-02-01T00:00:00Z`, `${"2".repeat(40)}${SEP}2026-01-05T00:00:00Z`, `${"3".repeat(40)}${SEP}2025-12-01T00:00:00Z`].join("\n");
// 3 web commits, all after the (same) web dist clock.
const webLog = [1, 2, 3].map((i) => `${String(i).repeat(40)}${SEP}2026-01-0${i + 4}T00:00:00Z`).join("\n");

const ancestorErr = (code) => Object.assign(new Error(`exit ${code}`), { code });
/** Builds a stub whose answers are chosen per read; ANY unlisted argv throws (never silently succeeds). */
const makeStub = (answers) => {
  const calls = [];
  const fn = async (repoRoot, args) => {
    calls.push(args);
    const key = args[0] === "-c" ? args.slice(2, 3).join(" ") === "diff" ? "diff-name-status" : "?" : args[0];
    let answer;
    if (args[0] === "log" && args[1] === "-1" && args[2].startsWith("--pretty=%H")) answer = answers.head;
    else if (args[0] === "log" && args.includes("--max-count=2000") && args.includes("packages/daemon/src")) answer = answers.relevant;
    else if (args[0] === "log" && args.includes("--max-count=2000") && args.includes("packages/web/src")) answer = answers.web;
    else if (args[0] === "log" && args[1] === "-1" && args[2] === "--pretty=%cI") answer = answers.commitDate;
    else if (args[0] === "merge-base") answer = answers.isAncestor;
    else if (args[0] === "diff" && args[1] === "--name-only") answer = answers.contentDiff;
    else if (key === "diff-name-status") answer = answers.nameStatus;
    else if (args[0] === "show" && args[1].startsWith(`${BUILT}:`)) answer = answers.showBefore;
    else if (args[0] === "show" && args[1].startsWith(`${HEAD}:`)) answer = answers.showAfter;
    if (answer === undefined) throw new Error(`UNEXPECTED READ (drifted argv?): git ${args.join(" ")}`);
    if (typeof answer === "function") return answer();
    return answer;
  };
  return { fn, calls };
};
const base = { head: headLine, relevant: relevantLog, web: webLog };
const throwing = (e) => () => { throw e; };
const sawArg = (calls, pred) => calls.some(pred);

{
  // A1: ancestor + stale ⇒ behavioural check; comment-only difference between the two snapshots ⇒ true.
  const { fn, calls } = makeStub({
    ...base, isAncestor: "",
    nameStatus: "M\tpackages/daemon/src/a.ts\n",
    showBefore: "export const a = 1; // one\n", showAfter: "export const a = 1; // two\n",
  });
  const r = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: fn });
  check("A1 HEAD read consumed (stub sha returned verbatim)", r.mainlineHeadSha === HEAD);
  check("A1 daemon/shared history read consumed (commitsBehind 2 from the stub's 3 lines)", r.commitsBehind === 2);
  check("A1 web history read consumed (webCommitsBehind 3 from the stub's 3 lines)", r.webCommitsBehind === 3);
  check("A1 is-ancestor read + name-status diff + BOTH git-show snapshots consumed: comment-only diff ⇒ builtContentMatchesHead true ⇒ stale overridden to false",
    r.builtContentMatchesHead === true && r.stale === false);
  check("A1 exactly the 7 expected reads were issued (3 history, is-ancestor, name-status, 2 shows)", calls.length === 7);
  check("A1 the two git-show reads name the BUILT sha and the HEAD sha respectively",
    sawArg(calls, (a) => a[0] === "show" && a[1].startsWith(`${BUILT}:packages/daemon/src/a.ts`)) && sawArg(calls, (a) => a[0] === "show" && a[1].startsWith(`${HEAD}:packages/daemon/src/a.ts`)));
}
{
  // A2: same, but the AFTER snapshot differs in code ⇒ false. Proves BOTH show outputs are what is compared.
  const { fn } = makeStub({
    ...base, isAncestor: "",
    nameStatus: "M\tpackages/daemon/src/a.ts\n",
    showBefore: "export const a = 1;\n", showAfter: "export const a = 2;\n",
  });
  const r = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: fn });
  check("A2 a real code difference between the snapshots ⇒ builtContentMatchesHead false, stale stays true", r.builtContentMatchesHead === false && r.stale === true);
  const swapped = makeStub({
    ...base, isAncestor: "",
    nameStatus: "M\tpackages/daemon/src/a.ts\n",
    showBefore: "export const a = 2;\n", showAfter: "export const a = 2; // only a comment\n",
  });
  const r2 = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: swapped.fn });
  check("A2 control: swapping which snapshot carries the code difference flips the verdict (outputs are consumed by position)", r2.builtContentMatchesHead === true);
}
{
  // A3: a failed git-show ⇒ null (fail closed), never a fabricated verdict.
  const { fn } = makeStub({
    ...base, isAncestor: "",
    nameStatus: "M\tpackages/daemon/src/a.ts\n",
    showBefore: throwing(new Error("boom: bad object")), showAfter: "export const a = 2;\n",
  });
  const r = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: fn });
  check("A3 a rejected git-show degrades builtContentMatchesHead to null (stale stays true)", r.builtContentMatchesHead === null && r.stale === true);
}
{
  // A4: a name-status diff over the file cap fails closed to null without reading any `git show`.
  const many = Array.from({ length: MAX_ANCESTOR_BEHAVIOURAL_CHECK_FILES + 1 }, (_, i) => `M\tpackages/daemon/src/f${i}.ts`).join("\n");
  const { fn, calls } = makeStub({ ...base, isAncestor: "", nameStatus: many });
  const r = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: fn });
  check("A4 over-cap name-status ⇒ null, no git-show issued (the cap is applied to the STUB's diff output)", r.builtContentMatchesHead === null && !sawArg(calls, (a) => a[0] === "show"));
}
{
  // A5: NOT an ancestor (exit status 1 as async execFile reports it: numeric `code`) ⇒ content diff read.
  const empty = makeStub({ ...base, isAncestor: throwing(ancestorErr(1)), contentDiff: "" });
  const r1 = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: empty.fn });
  check("A5 non-ancestor + EMPTY content diff ⇒ builtContentMatchesHead true (diff --name-only read consumed)", r1.builtContentMatchesHead === true && r1.stale === false);
  const nonEmpty = makeStub({ ...base, isAncestor: throwing(ancestorErr(1)), contentDiff: "packages/daemon/src/a.ts\n" });
  const r2 = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: nonEmpty.fn });
  check("A5 non-ancestor + NON-empty content diff ⇒ builtContentMatchesHead false", r2.builtContentMatchesHead === false && r2.stale === true);
  const statusForm = makeStub({ ...base, isAncestor: throwing(Object.assign(new Error("exit 1"), { status: 1 })), contentDiff: "" });
  const r3 = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: statusForm.fn });
  check("A5 the sync-style `status: 1` failure shape is read as non-ancestor too", r3.builtContentMatchesHead === true);
  const unknown = makeStub({ ...base, isAncestor: throwing(ancestorErr("ENOENT")) });
  const r4 = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: unknown.fn });
  check("A5 a non-numeric failure code (ENOENT) is UNKNOWN, not non-ancestor: no content diff issued, builtContentMatchesHead null",
    r4.builtContentMatchesHead === null && !sawArg(unknown.calls, (a) => a[0] === "diff"));
}
{
  // A6: not stale (dist clock after every relevant commit) + sha differs from HEAD ⇒ the commit-date read.
  const freshDist = makeDist(path.join(tmpHome, "stub-repo"), new Date("2026-03-01T00:00:00Z"));
  const opts = { ...stubOpts, ...freshDist, processStartedAt: "2026-04-01T00:00:00Z" };
  const early = makeStub({ ...base, commitDate: "2025-11-01T00:00:00Z", isAncestor: "" });
  const r1 = await computeDeployStalenessAsync({ ...opts, processBuiltSha: BUILT, asyncGit: early.fn });
  check("A6 not stale (commitsBehind 0) and a built-sha commit date EARLIER than the relevant commits ⇒ deploySignatureMismatch true (commit-date read consumed)",
    r1.stale === false && r1.commitsBehind === 0 && r1.deploySignatureMismatch === true);
  const late = makeStub({ ...base, commitDate: "2027-01-01T00:00:00Z", isAncestor: "" });
  const r2 = await computeDeployStalenessAsync({ ...opts, processBuiltSha: BUILT, asyncGit: late.fn });
  check("A6 the same with a LATE commit date ⇒ deploySignatureMismatch false (the verdict follows the stub's date)", r2.deploySignatureMismatch === false);
}
{
  // A7: a failing HEAD read short-circuits the reason; a failing web read names the web history.
  const noHead = makeStub({ ...base, head: throwing(new Error("boom: head")) });
  const r1 = await computeDeployStalenessAsync({ ...stubOpts, asyncGit: noHead.fn });
  check("A7 a failed HEAD read ⇒ could-not-measure naming mainline HEAD", r1.available === false && /could not read mainline HEAD: boom: head/.test(r1.reason));
  const noWeb = makeStub({ ...base, web: throwing(new Error("boom: web")) });
  const r2 = await computeDeployStalenessAsync({ ...stubOpts, asyncGit: noWeb.fn });
  check("A7 a failed web read ⇒ could-not-measure naming web-src history", r2.available === false && /web-src commit history: boom: web/.test(r2.reason));
}

// ===================== (B) equivalence against REAL git =====================
const repo = path.join(tmpHome, "real-repo");
fs.mkdirSync(repo, { recursive: true });
const git = (args, env = {}) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } }).trim();
git("init -q -b main");
git("config user.email t@loom"); git("config user.name t");
git("config core.autocrlf false");
writeTsconfigs(repo);
fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "shared", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "web", "src"), { recursive: true });
const commit = (rel, body, when, msg) => {
  fs.writeFileSync(path.join(repo, rel), body);
  git("add -A");
  git(`commit -q -m "${msg}"`, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  return git("rev-parse HEAD");
};
const c0 = commit("packages/daemon/src/a.ts", "export const a = 1;\n", "2026-01-01T00:00:00Z", "c0");
const realDist = makeDist(repo, new Date("2026-01-02T00:00:00Z"));
const realOpts = { ...realDist, repoRoot: repo, processStartedAt: "2026-01-10T00:00:00Z", processBuiltDirty: false };
const same = async (label, extra) => {
  const o = { ...realOpts, ...extra };
  const s = computeDeployStaleness(o);
  const a = await computeDeployStalenessAsync(o);
  check(`B ${label}: async deep-equals sync`, JSON.stringify(a) === JSON.stringify(s));
  return a;
};

const c1 = commit("packages/daemon/src/a.ts", "export const a = 1; // a note\n", "2026-01-03T00:00:00Z", "c1 comment only");
git(`branch side ${c0}`);
{
  const r = await same("ancestor + stale + inert (comment-only) diff", { processBuiltSha: c0 });
  check("B ancestor/inert fixture is a real measurement (HEAD = c1, commitsBehind 1, builtContentMatchesHead true, stale false)",
    r.available === true && r.mainlineHeadSha === c1 && r.commitsBehind === 1 && r.builtContentMatchesHead === true && r.stale === false);
}
const c2 = commit("packages/daemon/src/a.ts", "export const a = 2;\n", "2026-01-05T00:00:00Z", "c2 behavioural");
{
  const r = await same("ancestor + stale + behavioural diff", { processBuiltSha: c0 });
  check("B ancestor/behavioural fixture is real (HEAD = c2, commitsBehind 2, builtContentMatchesHead false, stale true)",
    r.mainlineHeadSha === c2 && r.commitsBehind === 2 && r.builtContentMatchesHead === false && r.stale === true);
}
git("checkout -q side");
const d1 = commit("packages/daemon/src/a.ts", "export const a = 3;\n", "2026-01-04T00:00:00Z", "d1 side");
git("checkout -q main");
{
  const r = await same("non-ancestor", { processBuiltSha: d1 });
  check("B non-ancestor fixture is real (processBuiltSha not an ancestor ⇒ content diff non-empty ⇒ builtContentMatchesHead false)",
    r.builtContentMatchesHead === false && r.processBuiltShaMatchesHead === false);
}
{
  const fresh = makeDist(repo, new Date("2026-03-01T00:00:00Z"));
  const r = await same("not stale + signature mismatch", { ...fresh, processBuiltSha: c0 });
  check("B not-stale fixture is real (commitsBehind 0, built sha older than the newest relevant commit ⇒ deploySignatureMismatch true)",
    r.stale === false && r.commitsBehind === 0 && r.deploySignatureMismatch === true);
}
{
  const r = await same("processBuiltSha equal to HEAD", { processBuiltSha: c2 });
  check("B built sha == HEAD and clean ⇒ processBuiltShaMatchesHead true", r.processBuiltShaMatchesHead === true);
}

// ===================== (C) conditional reads do not block the event loop =====================
{
  const READ_MS = 120;
  const { fn } = makeStub({
    ...base, isAncestor: "",
    nameStatus: "M\tpackages/daemon/src/a.ts\n",
    showBefore: "export const a = 1; // one\n", showAfter: "export const a = 1; // two\n",
  });
  const slow = async (root, args) => { await sleep(READ_MS); return fn(root, args); };
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 10);
  const t0 = performance.now();
  const r = await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: slow });
  const elapsed = performance.now() - t0;
  clearInterval(ticker);
  // 4 sequential waits (history batch, is-ancestor, name-status, show batch) ≈ 480 ms ⇒ ~48 ticks if the loop
  // is free the whole time. A conditional read that blocked would remove its ~120 ms share (≥ 10 ticks).
  check(`C the call spanned all four sequential waits (${Math.round(elapsed)} ms ≥ 4×${READ_MS - 20})`, elapsed >= 4 * (READ_MS - 20));
  check(`C the 10 ms ticker kept firing across the whole call (${ticks} ticks ≥ ${Math.floor(elapsed / 10 * 0.6)})`, ticks >= Math.floor(elapsed / 10 * 0.6));
  check("C the slow run still computed the behavioural verdict", r.builtContentMatchesHead === true);
}

// ===================== (D) no `.git` ⇒ not applicable, ZERO git calls =====================
{
  const noGitRoot = path.join(tmpHome, "no-git-repo");
  fs.mkdirSync(noGitRoot, { recursive: true });
  let gitCalls = 0;
  const counting = async () => { gitCalls++; return ""; };
  const r = await computeDeployStalenessAsync({ ...stubOpts, repoRoot: noGitRoot, processBuiltSha: BUILT, asyncGit: counting });
  check(`D a repoRoot with no .git makes ZERO asyncGit calls (got ${gitCalls})`, gitCalls === 0);
  // Negative control: the SAME call against a root WITH a .git does hit git, so the counter can see a call.
  let controlCalls = 0;
  await computeDeployStalenessAsync({ ...stubOpts, processBuiltSha: BUILT, asyncGit: async () => { controlCalls++; return ""; } });
  check(`D (control) a repoRoot WITH a .git does call asyncGit (${controlCalls} calls)`, controlCalls > 0);
  void r;
}

try { cleanupPathSync(tmpHome); } catch { /* best effort */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — every staleness git read is consumed through the async seam, async deep-equals sync with processBuiltSha set, and the conditional reads leave the event loop free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
