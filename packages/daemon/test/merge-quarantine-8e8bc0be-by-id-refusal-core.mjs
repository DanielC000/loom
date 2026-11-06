import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 8e8bc0be — a route id is handed out ONLY if clearMergeQuarantineLatchFile would follow it. The
// ONE decision (byIdClearRefusalFor) is shared by the clear and every route-id builder; this file pins one
// fixture per refusal class (incl. the re-ingest flip the b6f573cf hand copy could not see), the own-entry
// route of classifyKeptRepoPath, and the id-less alsoClear producers reached with a real dead kept id.
// State is built through the module's own *TestOnly seams (setActive/pushPending), never a real daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq8e8b-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq8e8b@loom -c user.name=mq8e8b";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashOf = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq8e8b-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-8e8bc0be (${tag})\n`);
  execSync(`git init -q && git config user.email mq8e8b@loom && git config user.name mq8e8b`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let moduleCounter = 0;
async function freshModule() {
  moduleCounter++;
  const mod = await import(`${mergeQuarantineModuleHref}?b=${moduleCounter}`);
  // Each fixture gets a PRISTINE quarantine dir: earlier fixtures' latches must not leak into this one.
  fs.rmSync(mod.MERGE_QUARANTINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(mod.MERGE_QUARANTINE_DIR, { recursive: true });
  return mod;
}

// Never-existing repo paths: unresolvable, so no real-git side effects, and distinct identities.
const ghost = (tag) => path.join(os.tmpdir(), `loom-mq8e8b-ghost-${tag}-${freshSfx()}`);
const mkEntry = (repoPath, extra = {}) => ({ repoPath, branch: "br", reason: "8e8bc0be fixture", enteredAt: Date.now(), tokens: [randomUUID()], ...extra });

/** FOLLOWABLE = the clear succeeded AND lifted or released something (not a refusal, not a no-lift). */
function followable(res) {
  return res.ok === true && ((res.liftedRepoPaths?.length ?? 0) > 0 || (res.releasedRepoPaths?.length ?? 0) > 0);
}

/**
 * One refusal-class scenario. `build()` constructs fresh state in a fresh module and returns `{ mod, id }`.
 * Asserts: the predicate refuses the id AND the real by-id clear does not follow it (so the two agree), on
 * a second fresh build (following mutates state).
 */
async function refusedClass(label, build) {
  const a = await build();
  check(`${label}: the route-id predicate refuses the id`, a.mod.routeIdWouldBeRefusedTestOnly(a.id) === true);
  const b = await build();
  const res = b.mod.clearMergeQuarantineLatchFile(b.id);
  check(`${label}: *** the by-id clear really does not follow it (agreement) ***`, !followable(res));
  check(`${label}: the by-id clear is an actual REFUSAL (ok:false), not merely a no-lift`, res.ok === false);
}

try {
  // ── One fixture per refusal class ────────────────────────────────────────────────────────────────
  await refusedClass("R1 ambiguous-active (contributorRepoPaths)", async () => {
    const mod = await freshModule();
    const k = `mq8e8b-k1-${freshSfx()}`;
    mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("a1"), { contributorRepoPaths: [ghost("c1")], armedKeys: [k] }));
    return { mod, id: hashOf(k) };
  });
  await refusedClass("R2 ambiguous-active (provenanceUnknown)", async () => {
    const mod = await freshModule();
    const k = `mq8e8b-k2-${freshSfx()}`;
    mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("a2"), { provenanceUnknown: true, armedKeys: [k] }));
    return { mod, id: hashOf(k) };
  });
  await refusedClass("R3 ambiguous-active (resolvable pending SIBLING canonically colliding at the key)", async () => {
    const mod = await freshModule();
    const r = makeRepo("r3");
    const k = canonicalRepoLockKey(r);
    mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("z3"), { armedKeys: [k] }));
    mod.pushPendingQuarantineTestOnly(mkEntry(r), `${hashOf(`other-${freshSfx()}`)}.json`);
    return { mod, id: hashOf(k) };
  });
  await refusedClass("R4 active-vs-different-identity-pending", async () => {
    const mod = await freshModule();
    const k = `mq8e8b-k4-${freshSfx()}`;
    mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("a4"), { armedKeys: [k] }));
    mod.pushPendingQuarantineTestOnly(mkEntry(ghost("q4")), `${hashOf(k)}.json`);
    return { mod, id: hashOf(k) };
  });
  await refusedClass("R5 pending contributor", async () => {
    const mod = await freshModule();
    const h = hashOf(`mq8e8b-k5-${freshSfx()}`);
    mod.pushPendingQuarantineTestOnly(mkEntry(ghost("p5"), { contributorRepoPaths: [ghost("c5")] }), `${h}.json`);
    return { mod, id: h };
  });
  await refusedClass("R6 pending unknown provenance", async () => {
    const mod = await freshModule();
    const h = hashOf(`mq8e8b-k6-${freshSfx()}`);
    mod.pushPendingQuarantineTestOnly(mkEntry(ghost("p6"), { provenanceUnknown: true }), `${h}.json`);
    return { mod, id: h };
  });

  // ── The re-ingest flip: a bare placeholder is CLEAN until the clear re-ingests its disk content ───
  await refusedClass("R7 PENDING placeholder whose disk record carries a contributor (re-ingest flips it)", async () => {
    const mod = await freshModule();
    const h = hashOf(`mq8e8b-k7-${freshSfx()}`);
    const p = ghost("p7");
    mod.pushPendingQuarantineTestOnly(mkEntry(p, { placeholder: true, branch: mod.PLACEHOLDER_BRANCH_UNREADABLE }), `${h}.json`);
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, `${h}.json`), JSON.stringify({ repoPath: p, branch: "real-branch", reason: "real", tokens: [randomUUID()], contributorRepoPaths: [ghost("c7")] }));
    return { mod, id: h };
  });
  await refusedClass("R8 ACTIVE placeholder whose disk record carries a contributor (re-ingest flips it)", async () => {
    const mod = await freshModule();
    const k = `mq8e8b-k8-${freshSfx()}`;
    const a = ghost("a8");
    mod.setActiveQuarantineTestOnly(k, mkEntry(a, { placeholder: true, branch: mod.PLACEHOLDER_BRANCH_UNREADABLE, armedKeys: [k] }));
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, `${hashOf(k)}.json`), JSON.stringify({ repoPath: a, branch: "real-branch", reason: "real", tokens: [randomUUID()], contributorRepoPaths: [ghost("c8")] }));
    return { mod, id: hashOf(k) };
  });

  // ── Controls: a clean entry's id is NOT refused and IS followable ────────────────────────────────
  {
    const mod = await freshModule();
    const k = `mq8e8b-kc-${freshSfx()}`;
    mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("ac"), { armedKeys: [k] }));
    check("C1 control: a clean active entry's id is not refused", mod.routeIdWouldBeRefusedTestOnly(hashOf(k)) === false);
    const res = mod.clearMergeQuarantineLatchFile(hashOf(k));
    check("C1 control: following it lifts something", followable(res));
  }
  {
    // c4: the id's entry is released but another raise-group of the SAME identity still blocks it — the
    // clear reports it as released (lifted:[]), which COUNTS as followable.
    const mod = await freshModule();
    const k = `mq8e8b-kc4-${freshSfx()}`;
    const a = ghost("ac4");
    mod.setActiveQuarantineTestOnly(k, mkEntry(a, { armedKeys: [k] }));
    mod.pushPendingQuarantineTestOnly(mkEntry(a), `${hashOf(`other-${freshSfx()}`)}.json`);
    check("C4 released-but-still-blocked: the id is not refused", mod.routeIdWouldBeRefusedTestOnly(hashOf(k)) === false);
    const res = mod.clearMergeQuarantineLatchFile(hashOf(k));
    check("C4 released-but-still-blocked counts as FOLLOWABLE (released non-empty)", res.ok === true && (res.releasedRepoPaths?.length ?? 0) > 0);
    check("C4 (shape) it is the lifted:[] + stillQuarantined shape", res.stillQuarantined === true && (res.liftedRepoPaths?.length ?? 0) === 0);
  }

  // ── classifyKeptRepoPath's own-entry route: a PENDING entry that owns live armed keys ────────────
  for (const variant of ["different-identity pending shares the armed key's id", "the owning entry carries a contributor"]) {
    const mod = await freshModule();
    const x = ghost("x");
    const kP = `mq8e8b-kp-${freshSfx()}`;
    const diffPending = variant.startsWith("different");
    // P is BOTH pending (its own sourceFile) and live-armed at kP: the 883e29bc dual-tracked twin shape.
    const p = mkEntry(x, { armedKeys: [kP], ...(diffPending ? {} : { contributorRepoPaths: [ghost("cx")] }) });
    mod.setActiveQuarantineTestOnly(kP, p);
    mod.pushPendingQuarantineTestOnly(p, `${hashOf(`p-own-${freshSfx()}`)}.json`);
    const sharedSf = `${hashOf(kP)}.json`;
    if (diffPending) mod.pushPendingQuarantineTestOnly(mkEntry(ghost("q")), sharedSf);
    check(`K1 (${variant}) precondition: the entry's raw own id is the armed key's id`, mod.quarantineLatchFileIdsFor(p)[0] === hashOf(kP));
    // A kept file X does NOT physically own (an unrelated name), so the route falls to the OWN-ENTRY branch.
    const cls = mod.classifyKeptRepoPathTestOnly(x, `${hashOf(`kept-elsewhere-${freshSfx()}`)}.json`);
    check(`K1 (${variant}) the own-entry route is classified live`, cls.live === true);
    check(`K1 (${variant}) *** the own-entry route does NOT carry the id the clear would refuse ***`, cls.live === true && cls.coOccupant.route.id === undefined && cls.coOccupant.route.repoPath === x);
    check(`K1 (${variant}) predicate agrees: the raw id IS refused`, mod.routeIdWouldBeRefusedTestOnly(hashOf(kP)) === true);
  }
  {
    // K1 positive control: with nothing blocking, the same own-entry route DOES carry a followable id.
    const mod = await freshModule();
    const x = ghost("xc");
    const kP = `mq8e8b-kpc-${freshSfx()}`;
    const p = mkEntry(x, { armedKeys: [kP] });
    mod.setActiveQuarantineTestOnly(kP, p);
    mod.pushPendingQuarantineTestOnly(p, `${hashOf(`p-own-${freshSfx()}`)}.json`);
    const cls = mod.classifyKeptRepoPathTestOnly(x, `${hashOf(`unrelated-${freshSfx()}`)}.json`);
    check("K1 control: an unblocked own-entry route keeps its id", cls.live === true && cls.coOccupant.route.id === hashOf(kP));
    check("K1 control: that id is followable", followable(mod.clearMergeQuarantineLatchFile(hashOf(kP))));
  }

  // ── classifyKeptRepoPath's blockedBy.id: a DIFFERENT identity's entry refuses the content-kept repoPath ──
  {
    const buildBlocked = async (dead) => {
      const mod = await freshModule();
      const r = makeRepo("bb"); // resolvable: its canonical key is where W's entry is armed
      const k = canonicalRepoLockKey(r);
      mod.setActiveQuarantineTestOnly(k, mkEntry(ghost("w"), { armedKeys: [k] }));
      if (dead) mod.pushPendingQuarantineTestOnly(mkEntry(ghost("qb")), `${hashOf(k)}.json`); // makes hash(k) a dead id
      return { mod, r, k };
    };
    const live = await buildBlocked(false);
    const cl = live.mod.classifyKeptRepoPathTestOnly(live.r, `${hashOf(`kept-elsewhere-${freshSfx()}`)}.json`);
    check("B1 control: blockedBy keeps a followable id", cl.live === false && cl.blockedBy?.id === hashOf(live.k));
    const dead = await buildBlocked(true);
    const cd = dead.mod.classifyKeptRepoPathTestOnly(dead.r, `${hashOf(`kept-elsewhere-${freshSfx()}`)}.json`);
    check("B1 *** blockedBy names the blocker but NOT its dead id ***", cd.live === false && cd.blockedBy !== undefined && cd.blockedBy.id === undefined);
    check("B1 the raw id really is refused by the clear", dead.mod.routeIdWouldBeRefusedTestOnly(hashOf(dead.k)) === true && dead.mod.clearMergeQuarantineLatchFile(hashOf(dead.k)).ok === false);
  }

  // ── The two TEXT sites (assertRepoNotQuarantined / stillQuarantinedReason) go through the same core ──
  {
    // b6f573cf's shape: Y active at hash(Key(Y)); absent subdirs Y/a, Y/b pending at the SAME corrupt file.
    // Y has no sibling/contributor (ambiguousCount 0), yet its id is refused as "matches BOTH".
    const mod = await freshModule();
    const y = makeRepo("txt");
    const a = path.join(y, "a");
    const b = path.join(y, "b");
    const h = hashOf(canonicalRepoLockKey(y));
    fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, `${h}.json`), "{");
    mod.reenterMergeQuarantinesAtBoot([a, b]);
    mod.enterMergeQuarantine(y, "br", "Y real");
    const idJson = JSON.stringify({ id: h });
    const refused = mod.clearMergeQuarantineLatchFile(h);
    check("T1 (precondition) the real by-id clear refuses Y's id as ambiguous", refused.ok === false && /matches BOTH/.test(refused.reason));
    const asserted = mod.assertRepoNotQuarantined(y);
    check("T1 assertRepoNotQuarantined(Y) is blocked and still names the {repoPath} route", asserted.ok === false && asserted.reason.includes("clear-by-path with"));
    check("T1 *** assertRepoNotQuarantined(Y) does NOT name the dead {id} ***", asserted.ok === false && !asserted.reason.includes(idJson));
    const stillText = mod.clearMergeQuarantine(b).reason ?? "";
    check("T1 stillQuarantinedReason (via clear(Y/b)) is produced and does NOT name the dead {id}", /still quarantined|quarantined by ANOTHER/.test(stillText) && !stillText.includes(idJson));
    // Control: Y alone (no pending sharers) still names its {id}.
    const mod2 = await freshModule();
    const y2 = makeRepo("txt2");
    mod2.enterMergeQuarantine(y2, "br", "Y alone");
    const alone = mod2.assertRepoNotQuarantined(y2);
    const id2 = hashOf(canonicalRepoLockKey(y2));
    check("T1 control: an unshared entry's text still names its {id}", alone.ok === false && alone.reason.includes(JSON.stringify({ id: id2 })));
  }

  // ── id-less alsoClear producers reached with a real DEAD kept id ─────────────────────────────────
  {
    const buildDead = async () => {
      const mod = await freshModule();
      const kA = `mq8e8b-kd-${freshSfx()}`;
      mod.setActiveQuarantineTestOnly(kA, mkEntry(ghost("ad"), { armedKeys: [kA] }));
      mod.pushPendingQuarantineTestOnly(mkEntry(ghost("qd")), `${hashOf(kA)}.json`); // makes hash(kA) ambiguous
      const x = ghost("xd");
      const relocSf = `${hashOf(`reloc-${freshSfx()}`)}.json`;
      mod.pushPendingQuarantineTestOnly(mkEntry(x), relocSf); // x's own relocated latch: a clean, followable id
      return { mod, x, relocSf, keptSf: `${hashOf(kA)}.json` };
    };
    const d = await buildDead();
    const both = d.mod.blockedCoOccupantBothRoutesTestOnly(d.x, d.relocSf, d.keptSf);
    check("D1 blockedCoOccupantBothRoutes: the relocated route keeps its followable id", both.route.id === path.basename(d.relocSf, ".json"));
    check("D1 *** the dead kept id is dropped, the second STEP stays (id-less alsoClear) ***", both.alsoClear !== undefined && both.alsoClear.id === undefined && both.alsoClear.repoPath === d.x);
    const text = d.mod.relocatedCoOccupantsReasonTestOnly([both]);
    check("D1 the reason text still renders both steps and never prints undefined", /FIRST/.test(text) && /THEN/.test(text) && !/undefined/.test(text));
    const d2 = await buildDead();
    const relocCo = d2.mod.blockedCoOccupantTestOnly(d2.x, d2.relocSf);
    const keptCo = d2.mod.blockedCoOccupantTestOnly(d2.x, d2.keptSf);
    check("D2 (precondition) the kept-side builder produced an id-less route for the dead id", keptCo.route.id === undefined);
    const merged = d2.mod.mergeKeptAndRelocatedCoOccupantTestOnly(relocCo, keptCo);
    check("D2 *** mergeKeptAndRelocatedCoOccupant keeps the second step id-less ***", merged.alsoClear !== undefined && merged.alsoClear.id === undefined && merged.route.id === relocCo.route.id);
    const d3 = await buildDead();
    const both3 = d3.mod.blockedCoOccupantBothRoutesTestOnly(d3.x, d3.relocSf, d3.keptSf);
    check("D1 every returned id is followable (the relocated one lifts)", followable(d3.mod.clearMergeQuarantineLatchFile(both3.route.id)));
    // Control: when the kept id is NOT dead, it is handed out.
    const mod = await freshModule();
    const x = ghost("xk");
    const r = `${hashOf(`r-${freshSfx()}`)}.json`;
    const k = `${hashOf(`k-${freshSfx()}`)}.json`;
    mod.pushPendingQuarantineTestOnly(mkEntry(x), r);
    mod.pushPendingQuarantineTestOnly(mkEntry(x), k);
    const ctl = mod.blockedCoOccupantBothRoutesTestOnly(x, r, k);
    check("D1 control: two followable ids are both handed out", ctl.route.id === path.basename(r, ".json") && ctl.alsoClear?.id === path.basename(k, ".json"));
  }

  console.log(failures === 0
    ? "\n✅ ALL SCENARIOS PASS — the by-id refusal decision is shared; no route id is handed out that the clear would refuse."
    : `\n❌ ${failures} CHECK(S) FAILED — board card 8e8bc0be.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
