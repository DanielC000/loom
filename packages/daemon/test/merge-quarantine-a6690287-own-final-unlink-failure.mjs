import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a6690287 — an EPERM/EBUSY on the active entry's OWN final `<id>.json` unlink used to report a bare
// success (200, wasQuarantined, repo lifted, NO latchKept, NO reason) while the file stayed on disk holding
// the token and a reboot re-armed the latch. Now it reports latchKept + a reason naming the stranded file.
// Shapes: (R) resolvable repo, three routes (/clear, /clear-by-path {repoPath}, /clear-by-path {id});
// (U) unresolvable repo (dir deleted before a fresh boot), two routes; (P) pending-only own file — already
// disclosed before this card (regression pin); (retry) a second clear after the fault is removed lifts it;
// (ENOENT) an unlink that finds the file already gone is CONFIRMED, never reported kept; (control) no fault.
// The reboot assertion is a DISCLOSURE-CONSISTENCY check (the response says it re-diverts, and it does),
// NOT in-process == reboot equality: in-process stays lifted by design (option (a), see the record).
// P's `fileStays`-looks-false oddity was a probe artefact: it was read AFTER the reboot, which consumed the
// file; the reboot re-arms from that same still-present pending file.
// Run: 1) pnpm build, 2) node test/merge-quarantine-a6690287-own-final-unlink-failure.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const loomHome = useOwnLoomHome("loom-mqa669-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { enterMergeQuarantine, MERGE_QUARANTINE_DIR } = await import(mqHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=a669@loom -c user.name=a669";
let bootCounter = 0;
const freshBoot = async () => await import(`${mqHref}?b=${++bootCounter}`);

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-a669-${tag}-`);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${tag}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "a669@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "a669"], { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
// `mode`: "eperm" throws EPERM for `target`; "enoent" really removes it then throws ENOENT (already gone).
function injectUnlinkFault(target, mode = "eperm") {
  const real = fs.unlinkSync;
  let hits = 0;
  fs.unlinkSync = (p, ...rest) => {
    if (p === target) {
      hits++;
      if (mode === "enoent") { real(p, ...rest); throw Object.assign(new Error("ENOENT: already gone"), { code: "ENOENT" }); }
      throw Object.assign(new Error("EPERM: simulated unlink failure"), { code: "EPERM" });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.unlinkSync = real; }, hits: () => hits };
}
const sidecarPath = path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
const tombstoned = (tok) => fs.existsSync(sidecarPath) && JSON.parse(fs.readFileSync(sidecarPath, "utf8"))[tok] !== undefined;
const ownFinalOf = (repo) => {
  const f = fs.readdirSync(MERGE_QUARANTINE_DIR).filter((n) => n.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, n), "utf8")).repoPath === repo)[0];
  return { name: f, full: path.join(MERGE_QUARANTINE_DIR, f) };
};
const runRoute = (m, route, repo, finalName) => route === "clear" ? m.clearMergeQuarantineReporting(repo)
  : route === "by-path-repoPath" ? m.clearMergeQuarantineByRecordedPath(repo)
  : m.clearMergeQuarantineLatchFile(finalName.replace(/\.json$/, ""));

// ── (R)/(U)/(ENOENT)/(control)/(retry) — an ACTIVE entry's own final ──────────────────────────────────────
for (const shape of ["R", "U"]) {
  const routes = shape === "R" ? ["clear", "by-path-repoPath", "by-path-id"] : ["clear", "by-path-repoPath"];
  for (const route of routes) {
    for (const variant of ["fault", "control", "enoent"]) {
      if (variant === "enoent" && route !== "clear") continue;
      const tag = `${shape} ${route} ${variant}`;
      const repo = makeRepo(`${shape}-${route}-${variant}`);
      const tok = enterMergeQuarantine(repo, "b", "first");
      const fin = ownFinalOf(repo);
      if (shape === "U") fs.rmSync(repo, { recursive: true, force: true });
      const m = await freshBoot();
      m.reenterMergeQuarantinesAtBoot([repo]);
      const inj = variant === "control" ? undefined : injectUnlinkFault(fin.full, variant === "enoent" ? "enoent" : "eperm");
      let res;
      try { res = runRoute(m, route, repo, fin.name); } finally { inj?.restore(); }
      if (variant === "fault") {
        check(`(${tag}) precondition: the own-final unlink was forced to fail`, inj.hits() >= 1);
        check(`(${tag}) the file still holds the token`, fs.existsSync(fin.full) && fs.readFileSync(fin.full, "utf8").includes(tok));
        check(`(${tag}) *** THE FIX *** reports latchKept`, res.latchKept === true);
        check(`(${tag}) *** THE FIX *** the reason names the stranded file`, typeof res.reason === "string" && res.reason.includes(fin.name));
        check(`(${tag}) the token is NOT durably tombstoned`, !tombstoned(tok));
        // Disclosure consistency: the response said it re-diverts on restart, and a fresh boot does.
        check(`(${tag}) reason says it re-diverts on restart`, /next restart/.test(res.reason ?? ""));
        const m2 = await freshBoot();
        m2.reenterMergeQuarantinesAtBoot([repo]);
        check(`(${tag}) disclosure-consistent: a fresh boot re-arms from the surviving file`, m2.assertRepoNotQuarantined(repo).ok === false);
        // Retry-clears-it: with the fault gone, a later clear lifts it, removes the file, and a boot stays clear.
        const m3 = await freshBoot();
        m3.reenterMergeQuarantinesAtBoot([repo]);
        const res3 = runRoute(m3, route, repo, fin.name);
        check(`(${tag}) retry: the second clear reports no keep`, res3.latchKept !== true);
        check(`(${tag}) retry: the file is gone and the token is tombstoned`, !fs.existsSync(fin.full) && tombstoned(tok));
        const m4 = await freshBoot();
        m4.reenterMergeQuarantinesAtBoot([repo]);
        check(`(${tag}) retry: a reboot stays clear`, m4.assertRepoNotQuarantined(repo).ok === true);
      } else {
        check(`(${tag}) control: reaches the delete, no latchKept, file gone, token tombstoned`,
          res.latchKept !== true && !fs.existsSync(fin.full) && tombstoned(tok) && (variant === "control" || inj.hits() >= 1));
      }
    }
  }
}

// ── (M) the provenCoverage sub-branch: the own final's basename is MARKED unreadable, and its content is ─────
// fully covered by the clear, so the unlink runs under `provenCoverage` rather than the plain path. Pins that
// the fix covers BOTH sub-branches of the finalProtectOk unlink site.
for (const route of ["clear", "by-path-repoPath", "by-path-id"]) {
  for (const variant of ["fault", "control"]) {
    const tag = `M ${route} ${variant}`;
    const repo = makeRepo(`M-${route}-${variant}`);
    const tok = enterMergeQuarantine(repo, "b", "first");
    const fin = ownFinalOf(repo);
    const m = await freshBoot();
    m.reenterMergeQuarantinesAtBoot([repo]);
    m.markLatchFileUnreadableTestOnly(fin.name);
    const inj = variant === "control" ? undefined : injectUnlinkFault(fin.full);
    let res;
    try { res = runRoute(m, route, repo, fin.name); } finally { inj?.restore(); }
    if (variant === "fault") {
      check(`(${tag}) precondition: the own-final unlink was forced to fail`, inj.hits() >= 1);
      check(`(${tag}) *** THE FIX *** reports latchKept`, res.latchKept === true);
      check(`(${tag}) *** THE FIX *** the reason names the stranded file`, typeof res.reason === "string" && res.reason.includes(fin.name));
      check(`(${tag}) the token is NOT durably tombstoned`, !tombstoned(tok));
      const m2 = await freshBoot();
      m2.reenterMergeQuarantinesAtBoot([repo]);
      check(`(${tag}) a fresh boot re-blocks from the surviving file`, fs.existsSync(fin.full) && m2.assertRepoNotQuarantined(repo).ok === false);
    } else {
      check(`(${tag}) control: no latchKept, file gone, token tombstoned`, res.latchKept !== true && !fs.existsSync(fin.full) && tombstoned(tok));
    }
  }
}

// ── (P) pending-only own file — regression pin (already disclosed before this card) ───────────────────────
for (const route of ["clear", "by-path-repoPath"]) {
  const repo = makeRepo(`P-${route}`);
  const m = await freshBoot();
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const tok = `tok-a6690287-p-${route}`;
  const src = `pending-a6690287-${route}.json`;
  const target = path.join(MERGE_QUARANTINE_DIR, src);
  const e = { repoPath: repo, branch: "b", reason: "pending only", enteredAt: Date.now(), tokens: [tok] };
  fs.writeFileSync(target, JSON.stringify(e));
  m.pushPendingQuarantineTestOnly(e, src);
  const inj = injectUnlinkFault(target);
  let res;
  try { res = runRoute(m, route, repo, src); } finally { inj.restore(); }
  check(`(P ${route}) precondition: the pending file's unlink was forced to fail`, inj.hits() >= 1);
  check(`(P ${route}) the pending file is still present and holds the token (read BEFORE any reboot)`, fs.existsSync(target) && fs.readFileSync(target, "utf8").includes(tok));
  check(`(P ${route}) reports latchKept with the unattributed reason`, res.latchKept === true && /still on disk/.test(res.reason ?? ""));
  check(`(P ${route}) the token is NOT durably tombstoned`, !tombstoned(tok));
}

finishAndExit(failures);
