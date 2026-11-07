import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dff9a607 — a clear that keeps a latch file because an unlink FAILED must advise a route that
// actually works. The old text said "remove it or retry the clear", but a SAME-PROCESS retry does not
// reliably reach the kept file: the first clear evicts the in-memory entry, so on retry nothing is active.
//
// Pinned observed behaviour (the PREMISE the advice rests on), own final, each route x marked/unmarked:
//   unmarked  /clear + by-id retry : deletes the file silently (wasQuarantined:false, NO tombstone)
//   unmarked  by-path {repoPath}   : silent not-quarantined, file stays
//   marked    /clear + by-id retry : latchKept, file stays (coverage can't be proven without the entry)
//   marked    by-path {repoPath}   : silent not-quarantined, file stays
// Orphan source: an in-process retry leaves the orphan. Every source: restart (fresh boot) + clear removes
// the file, tombstones the token, and a SECOND boot stays clear.
// Run: 1) pnpm build, 2) node test/merge-quarantine-dff9a607-retry-advice.mjs
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mqdff9-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqdff9@loom -c user.name=mqdff9";
let bootCounter = 0;
const freshBoot = async (repo) => { const m = await import(`${mqHref}?b=${++bootCounter}`); m.reenterMergeQuarantinesAtBoot([repo]); return m; };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-mqdff9-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mqdff9@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "mqdff9"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
function injectUnlinkFault(target) {
  const real = fs.unlinkSync;
  let hits = 0, armed = true;
  fs.unlinkSync = (p, ...rest) => {
    if (armed && p === target) { hits++; throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" }); }
    return real(p, ...rest);
  };
  return { restore: () => { armed = false; fs.unlinkSync = real; }, hits: () => hits };
}
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;
const hashFor = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const runRoute = (m, route, repo, finalName) => route === "clear" ? m.clearMergeQuarantineReporting(repo)
  : route === "by-path" ? m.clearMergeQuarantineByRecordedPath(repo)
  : m.clearMergeQuarantineLatchFile(finalName.replace(/\.json$/, ""));
const ADVICE = "remove it by hand, or restart the daemon and clear again";
const adviceOk = (reason) => typeof reason === "string" && reason.includes(ADVICE) && reason.includes("a retry in the same process may not reach it");
const noOldAdvice = (reason) => typeof reason === "string" && !reason.includes("or retry the clear") && !reason.includes("until a later successful clear resolves it");

// Sets up an active own-final entry, boots a module, optionally marks the file, faults its unlink, clears via the
// route. Returns everything the legs need.
async function ownFinalFaulted(variant, route, tag) {
  const repo = makeRepo(`own-${variant}-${route}-${tag}`);
  const tok = enterMergeQuarantine(repo, "b", "first");
  const finalName = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n), "utf8")).repoPath === repo)[0];
  const finalPath = path.join(MERGE_QUARANTINE_DIR, finalName);
  const m1 = await freshBoot(repo);
  if (variant === "marked") m1.markLatchFileUnreadableTestOnly(finalName);
  const inj = injectUnlinkFault(finalPath);
  const first = runRoute(m1, route, repo, finalName);
  inj.restore();
  return { repo, tok, finalName, finalPath, m1, first, hits: inj.hits() };
}

for (const variant of ["unmarked", "marked"]) {
  for (const route of ["clear", "by-id", "by-path"]) {
    const L = `${variant} ${route}`;
    // ── (S) restart + clear: the advised route works ──────────────────────────────────────────────────────
    {
      const c = await ownFinalFaulted(variant, route, "S");
      check(`(${L}) precondition: the own-final unlink was forced to fail`, c.hits >= 1);
      check(`(${L}) first clear reports latchKept`, c.first.latchKept === true);
      check(`(${L}) *** THE FIX *** the first clear's reason advises remove-by-hand / restart-and-clear, not an in-process retry`, adviceOk(c.first.reason) && noOldAdvice(c.first.reason) && c.first.reason.includes(c.finalName));
      check(`(${L}) the file still holds the token and nothing is tombstoned`, fs.existsSync(c.finalPath) && fs.readFileSync(c.finalPath, "utf8").includes(c.tok) && !tombstoned(c.tok));
      const m2 = await freshBoot(c.repo);
      check(`(${L}) restart: the surviving file re-blocks the repo (the advice is needed)`, m2.assertRepoNotQuarantined(c.repo).ok === false);
      const res2 = runRoute(m2, route, c.repo, c.finalName);
      check(`(${L}) *** THE FIX *** restart + clear: no keep reported`, res2.latchKept !== true);
      check(`(${L}) restart + clear: the file is removed`, !fs.existsSync(c.finalPath));
      check(`(${L}) restart + clear: the token is tombstoned`, tombstoned(c.tok));
      const m3 = await freshBoot(c.repo);
      check(`(${L}) a SECOND reboot stays clear`, m3.assertRepoNotQuarantined(c.repo).ok === true && !fs.existsSync(c.finalPath));
    }
    // ── (R) in-process retry: the premise that makes "retry the clear" bad advice ─────────────────────────────
    {
      const c = await ownFinalFaulted(variant, route, "R");
      const retry = runRoute(c.m1, route, c.repo, c.finalName);
      const fileKept = fs.existsSync(c.finalPath);
      if (variant === "unmarked" && route !== "by-path") {
        check(`(${L} retry) PREMISE: the retry deletes the file but reports wasQuarantined:false`, !fileKept && retry.wasQuarantined === false);
        check(`(${L} retry) PREMISE: ...and writes NO tombstone`, !tombstoned(c.tok));
      } else if (variant === "unmarked") {
        check(`(${L} retry) PREMISE: the {repoPath} retry is a silent not-quarantined and the file stays`, fileKept && retry.wasQuarantined === false && retry.latchKept !== true);
      } else if (route === "by-path") {
        check(`(${L} retry) PREMISE: the {repoPath} retry is a silent not-quarantined and the file stays`, fileKept && retry.wasQuarantined === false && retry.latchKept !== true);
      } else {
        check(`(${L} retry) PREMISE: the retry keeps the file (latchKept) and never deletes it`, fileKept && retry.latchKept === true && retry.wasQuarantined === false);
      }
      if (fileKept) {
        const m = await freshBoot(c.repo);
        check(`(${L} retry) PREMISE: the kept file re-blocks on the next reboot`, m.assertRepoNotQuarantined(c.repo).ok === false);
      }
    }
  }
}

// ── (orphan / tmp) other sources of the SAME clause ────────────────────────────────────────────────────────
for (const source of ["orphan", "tmp"]) {
  const repo = makeRepo(source);
  const tok = enterMergeQuarantine(repo, "b", "first");
  const finalName = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n), "utf8")).repoPath === repo)[0];
  const finalPath = path.join(MERGE_QUARANTINE_DIR, finalName);
  let victim, m1;
  if (source === "orphan") {
    const orphan = `${randomBytes(12).toString("hex")}.json`;
    const rec = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    rec.orphanLatchFiles = [orphan];
    fs.writeFileSync(finalPath, JSON.stringify(rec));
    m1 = await freshBoot(repo);
    victim = path.join(MERGE_QUARANTINE_DIR, orphan);
    fs.writeFileSync(victim, JSON.stringify({ repoPath: repo, branch: "b-stale", reason: "stale duplicate", enteredAt: Date.now(), tokens: [tok], resolvedKey: repo.toLowerCase(), provenanceTracked: true }));
  } else {
    m1 = await freshBoot(repo);
    victim = path.join(MERGE_QUARANTINE_DIR, `${hashFor(canonicalRepoLockKey(repo))}.json.tmp-88881-cafed001`);
    fs.writeFileSync(victim, JSON.stringify({ repoPath: repo, branch: "b", reason: "stranded tmp", enteredAt: Date.now() - 1000, tokens: [tok] }, null, 2) + "\n");
  }
  const inj = injectUnlinkFault(victim);
  const first = m1.clearMergeQuarantineReporting(repo);
  inj.restore();
  check(`(${source}) precondition: the ${source}'s unlink was forced to fail`, inj.hits() >= 1 && fs.existsSync(victim));
  check(`(${source}) *** THE FIX *** the reason names the file and advises remove-by-hand / restart-and-clear`, first.latchKept === true && adviceOk(first.reason) && noOldAdvice(first.reason) && first.reason.includes(path.basename(victim)));
  if (source === "orphan") {
    m1.clearMergeQuarantineReporting(repo);
    check(`(orphan) PREMISE: an in-process retry does not reach the orphan`, fs.existsSync(victim));
  }
  // Fresh scenario for the restart leg when the in-process retry may have removed the tmp.
  const m2 = source === "orphan" ? await freshBoot(repo) : undefined;
  if (source === "orphan") {
    check(`(orphan) restart: the surviving orphan re-blocks the repo`, m2.assertRepoNotQuarantined(repo).ok === false);
    const res2 = m2.clearMergeQuarantineReporting(repo);
    check(`(orphan) restart + clear: no keep, orphan removed, token tombstoned`, res2.latchKept !== true && !fs.existsSync(victim) && tombstoned(tok));
    const m3 = await freshBoot(repo);
    check(`(orphan) a SECOND reboot stays clear`, m3.assertRepoNotQuarantined(repo).ok === true);
  } else {
    const mb = await freshBoot(repo);
    check(`(tmp) restart: the surviving residue re-blocks the repo`, mb.assertRepoNotQuarantined(repo).ok === false);
    const res2 = mb.clearMergeQuarantineReporting(repo);
    check(`(tmp) restart + clear: no keep, residue removed, token tombstoned`, res2.latchKept !== true && !fs.existsSync(victim) && tombstoned(tok));
    const m3 = await freshBoot(repo);
    check(`(tmp) a SECOND reboot stays clear`, m3.assertRepoNotQuarantined(repo).ok === true);
  }
}

// ── (base) the shared unattributed sentence no longer promises a plain retry resolves it ───────────────────
{
  const c = await ownFinalFaulted("unmarked", "clear", "base");
  check(`(base) the unattributed sentence still says it re-diverts on the next restart`, /next restart/.test(c.first.reason ?? ""));
  check(`(base) ...and names removal by hand or a clear that may need a restart first`, (c.first.reason ?? "").includes("(by hand, or by a later successful clear, which may need a daemon restart first)"));
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
