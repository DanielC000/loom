import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 922a1a44 — CHARACTERIZATION (test-only; no production change). Boot re-entry DELIBERATELY
// leaves two non-reference-equal objects for one identity when a resolvable repo's stale migrate source
// (or tmp residue) collides with a DIFFERENT, currently-unresolvable occupant's trusted resolvedKey: the
// occupant's shared union (active, carrying BOTH sides' tokens) plus a standalone per-source pending entry
// (the source's own tokens only) — docs/decisions/97cff6db-migrate-source-owner-durable-before-write.md.
// Cards af948556 / 67136b71 showed a stale second object for one identity can FAIL OPEN under a
// clear-by-token ordering. This file pins that the boot dual objects do NOT reach that path.
//
// PINNED (per shape, per token ordering, with a REBOOT — fresh module import over the same disk — after
// EVERY clear): (1) every still-outstanding token stays in memory AND on disk; (2) the key's resolvable
// holder keeps reading blocked (assertRepoNotQuarantined) while any token of its group is outstanding;
// (3) in the non-fault variants, a cleared token leaves BOTH objects (memory) at once and does not
// resurrect at the next boot. Shapes: A = stale-named source beside an OLDER degraded occupant X;
// C = source as a tmp residue at X's hash; D = sibling-collision with a .tmp-safety residue (sub/teamA/X);
// E = two migrating sources (y, z) into one degraded key. Each asserts a WITNESS that two overlapping
// objects exist at boot (so a drifted branch cannot pass vacuously). One fault variant marks the
// involved latch files unreadable (markLatchFileUnreadableTestOnly) — the keptUnreadable precondition
// class of af948556/67136b71 — and pins (1)+(2) only.
//
// MUTANTS (negative-control --mutant, each RED then GREEN): skipping the non-twin pending clear in
// clearMergeQuarantineByToken, and removing replaceEntryEverywhere in clearActiveEntryTokenAtKey's
// partial-clear branch, both fail the "cleared token is gone from every object" check; making that same
// partial-clear branch keep only `remaining.slice(0, 1)` (drops a NON-cleared sibling token) fails the
// fail-open checks ("still in MEMORY", "still on DISK", "reads BLOCKED") — shape E.
//
// NOT COVERED: the pending-twin disk-rewrite loop in clearActiveEntryTokenAtKey (removing it leaves this
// file green, so it is deliberately unpinned here); a real EACCES injected inside a sweep read (only the unreadable MARK is exercised);
// ancestor-donor / walk-up shapes (67136b71's foreignGroups topology); the pending-only ghost-Y shape
// (ef651188) and a third identity sharing tokens; clear-by-path / clear-by-id orderings; X NEWER than the
// source (a single union object, not a dual-object shape); and the over-block cases (all tokens cleared
// yet still blocked) — deliberately not asserted either way here.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-922a1a44-boot-dual-bytoken-clear.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHAPES = {
  A_stale_source: { ids: { x: ["x1"], y: ["y1", "y2"] } },
  C_tmp_residue: { ids: { x: ["x1"], y: ["y1", "y2"] } },
  D_collide: { ids: { x: ["tx"], sub: ["ts1", "ts2"], teamA: ["ta"] } },
  E_two_sources: { ids: { x: ["x1"], y: ["y1", "y2"], z: ["z1"] } },
};

const runArg = process.argv.find((a) => a.startsWith("--run="));

if (!runArg) {
  // DRIVER MODE — one child per configuration, own fresh LOOM_HOME each.
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  const configs = [];
  for (const shape of Object.keys(SHAPES)) {
    const toks = Object.values(SHAPES[shape].ids).flat();
    const rev = [...toks].reverse();
    const rot = [...toks.slice(1), toks[0]];
    const mid = [...toks.slice(2), ...toks.slice(0, 2)];
    configs.push({ shape, perm: toks, route: "owner", fault: null });
    configs.push({ shape, perm: rev, route: "owner", fault: null });
    configs.push({ shape, perm: rot, route: "other", fault: null });
    configs.push({ shape, perm: mid, route: "other", fault: null });
    configs.push({ shape, perm: rev, route: "owner", fault: "both" });
  }
  let failed = 0;
  for (const cfg of configs) {
    const label = `${cfg.shape} perm=${cfg.perm.join(">")} route=${cfg.route} fault=${cfg.fault ?? "none"}`;
    try {
      execFileSync(process.execPath, [__filename, `--run=${JSON.stringify(cfg)}`], { env: envWithoutLoomHome, stdio: "pipe", encoding: "utf8" });
      console.log(`--- ${label}: PASS ---`);
    } catch (e) {
      console.log(`--- ${label}: FAIL ---`);
      console.log(String(e.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
      failed++;
    }
  }
  console.log(failed === 0
    ? `\n✅ ALL ${configs.length} CONFIGURATIONS PASS — boot dual objects stay token-synced under by-token clears (with a reboot after every clear)`
    : `\n❌ ${failed} CONFIGURATION(S) FAILED — card 922a1a44`);
  process.exit(failed === 0 ? 0 : 1);
}

// ═══ CHILD MODE — exactly one configuration, own fresh LOOM_HOME. ═══
const cfg = JSON.parse(runArg.slice("--run=".length));
useOwnLoomHome("loom-mq922-");
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mqHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
let gen = 0;
const loadMq = async () => { gen++; return await import(`${mqHref}?b=${gen}`); };
let mq = await loadMq();
const QDIR = mq.MERGE_QUARANTINE_DIR;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const hashFor = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const GID = "-c user.email=mq922@loom -c user.name=mq922";
const work = mkdtempManaged("loom-mq922-work-");

function mkRepo(tag, withSubs) {
  const r = path.join(work, `r-${tag}-${sfx()}`);
  fs.mkdirSync(r, { recursive: true });
  if (withSubs) { fs.mkdirSync(path.join(r, "sub")); fs.mkdirSync(path.join(r, "teamA")); }
  fs.writeFileSync(path.join(r, "README.md"), tag);
  execSync(`git init -q && git config user.email mq922@loom && git config user.name mq922 && git add -A && git ${GID} commit -q -m init`, { cwd: r, stdio: "ignore" });
  if (withSubs) {
    const s = path.join(r, "sub");
    execSync(`git init -q && git config user.email mq922@loom && git config user.name mq922`, { cwd: s, stdio: "ignore" });
    fs.writeFileSync(path.join(s, "README.md"), "s");
    execSync(`git add -A && git ${GID} commit -q -m init`, { cwd: s, stdio: "ignore" });
  }
  return r;
}
const wj = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
const ghost = () => path.join(work, `ghost-${sfx()}`); // NEVER created

fs.mkdirSync(QDIR, { recursive: true });
const now = Date.now();
const P = {};
let registered = [];
const OLD = now - 120000;

if (cfg.shape === "A_stale_source" || cfg.shape === "C_tmp_residue") {
  const y = mkRepo("y"); const ky = canonicalRepoLockKey(y); const x = ghost();
  P.x = x; P.y = y; registered = [y, x];
  wj(path.join(QDIR, `${hashFor(ky)}.json`), { repoPath: x, branch: "xb", reason: "x", enteredAt: OLD, tokens: ["x1"], resolvedKey: ky });
  const yRec = { repoPath: y, branch: "yb", reason: "y", enteredAt: now, tokens: ["y1", "y2"] };
  if (cfg.shape === "A_stale_source") wj(path.join(QDIR, `!stale-y-${sfx()}.json`), yRec);
  else wj(path.join(QDIR, `${hashFor(ky)}.json.tmp-4242-ab12`), yRec);
} else if (cfg.shape === "D_collide") {
  const repo = mkRepo("d", true); const sub = path.join(repo, "sub"); const teamA = path.join(repo, "teamA");
  const kp = canonicalRepoLockKey(repo); const ksub = canonicalRepoLockKey(sub); const x = ghost();
  P.x = x; P.sub = sub; P.teamA = teamA; registered = [repo, teamA, sub, x];
  wj(path.join(QDIR, `${hashFor(ksub)}.json`), { repoPath: x, branch: "xb", reason: "x", enteredAt: OLD, tokens: ["tx"], resolvedKey: ksub });
  wj(path.join(QDIR, `${hashFor(kp)}.json`), { repoPath: sub, branch: "sb", reason: "sub", enteredAt: now - 60000, tokens: ["ts1", "ts2"] });
  wj(path.join(QDIR, `!stale-teamA-${sfx()}.json`), { repoPath: teamA, branch: "tb", reason: "teamA", enteredAt: now, tokens: ["ta"] });
} else if (cfg.shape === "E_two_sources") {
  const y = mkRepo("y"); const z = mkRepo("z"); const ky = canonicalRepoLockKey(y); const x = ghost();
  P.x = x; P.y = y; P.z = z; registered = [y, z, x];
  wj(path.join(QDIR, `${hashFor(ky)}.json`), { repoPath: x, branch: "xb", reason: "x", enteredAt: OLD, tokens: ["x1"], resolvedKey: ky });
  wj(path.join(QDIR, `!stale-y-${sfx()}.json`), { repoPath: y, branch: "yb", reason: "y", enteredAt: now, tokens: ["y1", "y2"] });
  wj(path.join(QDIR, `!stale-z-${sfx()}.json`), { repoPath: z, branch: "zb", reason: "z", enteredAt: now - 30000, tokens: ["z1"], resolvedKey: ky });
}

const ids = SHAPES[cfg.shape].ids;
const idNames = Object.keys(ids);
const ownerOf = {};
for (const [n, ts] of Object.entries(ids)) for (const t of ts) ownerOf[t] = n;
const outstanding = new Set(Object.keys(ownerOf));
const cleared = new Set();
// The resolvable repo that holds the shared key blocked on behalf of the (never-existing) ghost X.
const holderFor = (owner) => (fs.existsSync(P[owner]) ? owner : (P.y ? "y" : "sub"));

const memTokens = () => {
  const s = new Set();
  for (const e of mq.listActiveMergeQuarantines()) for (const t of e.tokens ?? []) s.add(t);
  return s;
};
const diskText = () => fs.readdirSync(QDIR).map((f) => { try { return fs.readFileSync(path.join(QDIR, f), "utf8"); } catch { return ""; } }).join("\n");

function applyFault() {
  if (!cfg.fault) return;
  for (const f of fs.readdirSync(QDIR)) mq.markLatchFileUnreadableTestOnly(f);
}

function assertState(label) {
  const mem = memTokens(); const disk = diskText();
  for (const t of outstanding) {
    check(`[${label}] outstanding ${t} (owner ${ownerOf[t]}) still in MEMORY`, mem.has(t));
    check(`[${label}] outstanding ${t} (owner ${ownerOf[t]}) still on DISK`, disk.includes(`"${t}"`));
    const h = holderFor(ownerOf[t]);
    check(`[${label}] ${h} (holder for ${ownerOf[t]}) reads BLOCKED while ${t} is outstanding`, mq.assertRepoNotQuarantined(P[h]).ok === false);
  }
  if (!cfg.fault) {
    for (const t of cleared) check(`[${label}] cleared ${t} is gone from every object in MEMORY (both dual objects synced)`, !mem.has(t));
  }
}

async function reboot(label) {
  mq = await loadMq();
  mq.reenterMergeQuarantinesAtBoot(registered);
  applyFault();
  assertState(label);
}

const realError = console.error; const realWarn = console.warn;
console.error = () => {}; console.warn = () => {};
try {
  mq.reenterMergeQuarantinesAtBoot(registered);
  applyFault();
  // WITNESS: two distinct objects for the boot dual-object shape, sharing at least one token.
  const objs = mq.listActiveMergeQuarantines();
  let overlap = false;
  for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
    if ((objs[i].tokens ?? []).some((t) => (objs[j].tokens ?? []).includes(t))) overlap = true;
  }
  check("(witness) boot produced >= 2 distinct objects whose token sets overlap (the by-design dual objects)", overlap);
  assertState("boot0");

  const routePath = (tok) => {
    const owner = ownerOf[tok];
    if (cfg.route === "owner") return P[owner];
    return P[idNames.find((n) => n !== owner)];
  };
  let i = 0;
  for (const tok of cfg.perm) {
    i++;
    mq.clearMergeQuarantineByToken(routePath(tok), tok);
    outstanding.delete(tok); cleared.add(tok);
    assertState(`step${i}:clear(${tok})`);
    await reboot(`step${i}+reboot`);
  }
} finally {
  console.error = realError; console.warn = realWarn;
}
process.exit(failures === 0 ? 0 : 1);
