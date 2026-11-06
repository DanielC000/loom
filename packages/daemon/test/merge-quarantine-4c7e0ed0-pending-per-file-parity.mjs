import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 4c7e0ed0 — see docs/decisions/4c7e0ed0-pending-orphan-arm-files-one-entry-per-file.md.
// An UNRESOLVABLE foreign identity T kept behind two orphan files (or two tmp residues): the in-process
// arm must file the SAME per-file PENDING shape a reboot of the identical bytes does. Every "reboot" leg
// below is booted from a disk SNAPSHOT of the post-clear orphan files, never from in-process output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq4c7e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mqHref = pathToFileURL(path.join(__dirname, "..", "dist", "git", "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(__dirname, "..", "dist", "git", "repo-lock.js")).href);
const mod = await import(mqHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq4c7e@loom -c user.name=mq4c7e";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hex24 = (seed) => createHash("sha256").update(`${seed}-${freshSfx()}`).digest("hex").slice(0, 24);

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq4c7e-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-4c7e0ed0 (${tag})\n`);
  execSync(`git init -q && git config user.email mq4c7e@loom && git config user.name mq4c7e`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const neverExistsPath = (tag) => path.join(os.tmpdir(), `loom-mq4c7e-${tag}-never-exists-${freshSfx()}`); // never created

let bootCounter = 0;
const freshBootModule = async () => import(`${mqHref}?b=${++bootCounter}`);

function foldRefsIntoOwnFinal(repoPath, refs) {
  const dir = mod.MERGE_QUARANTINE_DIR;
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, x), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  if (!f) throw new Error(`no on-disk final for ${repoPath}`);
  const p = path.join(dir, f);
  const record = JSON.parse(fs.readFileSync(p, "utf8"));
  record.orphanLatchFiles = [...refs];
  fs.writeFileSync(p, JSON.stringify(record));
}
const writeForeign = (basename, repoPath, token, extra = {}) =>
  fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, basename), JSON.stringify({ repoPath, branch: "loom/t-branch", reason: "foreign raise for T (4c7e0ed0)", enteredAt: Date.now(), tokens: [token], ...extra }));

// Snapshot/restore MERGE_QUARANTINE_DIR plus the durable cleared-tokens sidecar (outside that dir by design,
// d2592cd5) so each leg is an independent derivation of the same bytes.
const sidecarPath = () => path.join(loomHome, "merge-quarantine-cleared-tokens.dat");
function snapshot() {
  const files = new Map();
  for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) files.set(f, fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, f)));
  let sidecar; try { sidecar = fs.readFileSync(sidecarPath()); } catch { sidecar = undefined; }
  return { files, sidecar };
}
function restore({ files, sidecar }) {
  for (const f of fs.readdirSync(mod.MERGE_QUARANTINE_DIR)) if (!files.has(f)) fs.rmSync(path.join(mod.MERGE_QUARANTINE_DIR, f), { force: true });
  for (const [f, c] of files) fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, f), c);
  if (sidecar === undefined) fs.rmSync(sidecarPath(), { force: true }); else fs.writeFileSync(sidecarPath(), sidecar);
}
const dirFiles = () => fs.readdirSync(mod.MERGE_QUARANTINE_DIR).sort();

// Per-entry shape of T's pending entries: sorted `sourceFile=tokens` strings (order-independent).
const shapeOf = (m, T) => m.listPendingTokensTestOnly().filter((p) => p.repoPath === T)
  .map((p) => `${p.sourceFile}=${[...p.tokens].sort().join("+")}`).sort();

// Follow the human id route to convergence: clear whatever id the live entry hands out, repeat. Returns the
// call count and whether the FIRST call left T still quarantined.
function followIdRoute(m, T) {
  let calls = 0, firstStillQuarantined;
  while (m.stillBlockedEntryFor(T) && calls < 6) {
    const id = m.quarantineLatchFileIdsFor(m.stillBlockedEntryFor(T))[0];
    const r = m.clearMergeQuarantineLatchFile(id);
    if (calls === 0) firstStillQuarantined = r.ok && r.stillQuarantined === true;
    calls++;
  }
  return { calls, firstStillQuarantined, unblocked: !m.stillBlockedEntryFor(T) && m.assertRepoNotQuarantined(T).ok };
}

// ── Orphan-file scenario ──────────────────────────────────────────────────────────────────────────────
// Builds the in-process leg from the PRE snapshot; the first build also captures the POST snapshot every
// reboot leg is restored from (post-clear: the clearer's own file gone, O1/O2 still holding T's content).
async function orphanScenario(tag, refOrder) {
  const A = makeRepo(`${tag}-a`);
  const T = neverExistsPath(`${tag}-t`);
  const tk1 = `tk1-${randomUUID()}`, tk2 = `tk2-${randomUUID()}`;
  const o1 = `${hex24(`${tag}-o1`)}.json`, o2 = `${hex24(`${tag}-o2`)}.json`;
  const clearerToken = enterMergeQuarantine(A, `loom/${tag}`, `merge in progress for ${tag} (4c7e0ed0)`);
  foldRefsIntoOwnFinal(A, refOrder === "o2-first" ? [o2, o1] : [o1, o2]);
  const pre = snapshot();
  const inProcessLeg = async () => {
    restore(pre);
    const b = await freshBootModule();
    b.reenterMergeQuarantinesAtBoot([A]);
    writeForeign(o1, T, tk1); writeForeign(o2, T, tk2); // AFTER the boot, see 9f387d7e's two-step fixture rule
    b.clearMergeQuarantineByToken(A, clearerToken);
    return b;
  };
  await inProcessLeg();
  const post = snapshot();
  const rebootLeg = async () => { restore(post); const b = await freshBootModule(); b.reenterMergeQuarantinesAtBoot([A]); return b; };
  return { A, T, tk1, tk2, o1, o2, inProcessLeg, rebootLeg };
}

try {
  for (const refOrder of ["o1-first", "o2-first"]) {
    const s = await orphanScenario(`orph-${refOrder}`, refOrder);
    const { T, tk1, tk2, o1, o2 } = s;
    const expected = [`${o1}=${tk1}`, `${o2}=${tk2}`].sort();
    const L = `ORPHAN ${refOrder}`;

    const ip = await s.inProcessLeg();
    const ipShape = shapeOf(ip, T);
    const ipOk = ip.assertRepoNotQuarantined(T).ok;
    const rb = await s.rebootLeg();
    const rbShape = shapeOf(rb, T);
    const rbOk = rb.assertRepoNotQuarantined(T).ok;
    check(`(${L}) *** THE FIX *** in-process files ONE pending entry per orphan file, each with its own tokens only`, JSON.stringify(ipShape) === JSON.stringify(expected));
    check(`(${L}) ...and a reboot from the post-clear snapshot files the identical per-file shape`, JSON.stringify(rbShape) === JSON.stringify(expected));
    check(`(${L}) ...and both shapes still BLOCK T`, ipOk === false && rbOk === false);

    // Partial clear: the cleared token's own file goes, the other survives — same on-disk state both ways.
    const afterPartial = {};
    for (const [name, leg] of [["inProcess", s.inProcessLeg], ["reboot", s.rebootLeg]]) {
      const m = await leg();
      m.clearMergeQuarantineByToken(T, tk1);
      const e = m.stillBlockedEntryFor(T);
      afterPartial[name] = { files: dirFiles().filter((f) => f === o1 || f === o2), tokens: e ? [...e.tokens].sort() : null, ok: m.assertRepoNotQuarantined(T).ok };
    }
    check(`(${L}) clearing tk1 leaves exactly O2 on disk and exactly tk2 outstanding, in-process`,
      JSON.stringify(afterPartial.inProcess.files) === JSON.stringify([o2]) && JSON.stringify(afterPartial.inProcess.tokens) === JSON.stringify([tk2]) && afterPartial.inProcess.ok === false);
    check(`(${L}) ...and the reboot leg ends in the identical state`, JSON.stringify(afterPartial.inProcess) === JSON.stringify(afterPartial.reboot));

    // Path clear: everything goes, in both shapes.
    const pathClear = {};
    for (const [name, leg] of [["inProcess", s.inProcessLeg], ["reboot", s.rebootLeg]]) {
      const m = await leg();
      m.clearMergeQuarantine(T);
      pathClear[name] = { left: dirFiles().filter((f) => f === o1 || f === o2).length, ok: m.assertRepoNotQuarantined(T).ok };
    }
    check(`(${L}) clear-by-path lifts T and removes both orphan files, in-process and after a reboot`,
      pathClear.inProcess.left === 0 && pathClear.inProcess.ok === true && pathClear.reboot.left === 0 && pathClear.reboot.ok === true);

    // Id route: follow the handed-out id to convergence. The FIRST id handed out depends on pending order
    // (in-process: the order the sweep saw the files; reboot: readdir order) — which is fine now that the
    // shapes match, because the refusal then names the other entry's id and the route converges in the same
    // number of steps either way.
    const route = {};
    for (const [name, leg] of [["inProcess", s.inProcessLeg], ["reboot", s.rebootLeg]]) {
      const m = await leg();
      route[name] = followIdRoute(m, T);
      route[name].left = dirFiles().filter((f) => f === o1 || f === o2).length;
    }
    check(`(${L}) the id route takes the SAME number of clears in both shapes (one per file) and the first leaves T quarantined`,
      route.inProcess.calls === 2 && route.reboot.calls === 2 && route.inProcess.firstStillQuarantined === true && route.reboot.firstStillQuarantined === true);
    check(`(${L}) ...and converges to unblocked with both files gone in both shapes`,
      route.inProcess.unblocked && route.reboot.unblocked && route.inProcess.left === 0 && route.reboot.left === 0);

    // Durability: a reboot after an in-process partial clear must not resurrect the cleared token.
    {
      const m = await s.inProcessLeg();
      m.clearMergeQuarantineByToken(T, tk1);
      const mid = snapshot();
      restore(mid);
      const b2 = await freshBootModule();
      b2.reenterMergeQuarantinesAtBoot([s.A]);
      check(`(${L}) a reboot after the in-process partial clear still has exactly tk2 outstanding (tk1 stays cleared)`,
        JSON.stringify(shapeOf(b2, T)) === JSON.stringify([`${o2}=${tk2}`]));
    }
  }

  // ── Secondary keys (Step B) per file: unresolvable T whose two orphans carry a resolvedKey naming live repos ──
  // DISTINCT: O1 -> R1's key, O2 -> R2's key. Each per-file entry must arm ONLY its own file's key, so clearing
  // tk1 frees R1 while R2 stays blocked by tk2 — identically in-process and after a reboot. (A union `record`
  // handed to the secondary-key loop would arm BOTH keys from every file's entry.)
  // SHARED: both orphans carry the SAME key; armQuarantineKey's same-identity union then makes both entries
  // carry tk1+tk2 — in-process must equal what a reboot of the same bytes produces, whatever that is.
  for (const kind of ["distinct", "shared"]) {
    const A = makeRepo(`key-${kind}-a`);
    const R1 = makeRepo(`key-${kind}-r1`), R2 = makeRepo(`key-${kind}-r2`);
    const T = neverExistsPath(`key-${kind}-t`);
    const K1 = canonicalRepoLockKey(R1), K2 = kind === "shared" ? K1 : canonicalRepoLockKey(R2);
    const tk1 = `tk1-${randomUUID()}`, tk2 = `tk2-${randomUUID()}`;
    const o1 = `${hex24(`key-${kind}-o1`)}.json`, o2 = `${hex24(`key-${kind}-o2`)}.json`;
    const clearerToken = enterMergeQuarantine(A, `loom/key-${kind}`, `merge in progress (4c7e0ed0 keyed ${kind})`);
    foldRefsIntoOwnFinal(A, [o1, o2]);
    const pre = snapshot();
    const registered = [A, R1, R2];
    const ipLeg = async () => {
      restore(pre);
      const b = await freshBootModule();
      b.reenterMergeQuarantinesAtBoot(registered);
      writeForeign(o1, T, tk1, { resolvedKey: K1 }); writeForeign(o2, T, tk2, { resolvedKey: K2 });
      b.clearMergeQuarantineByToken(A, clearerToken);
      return b;
    };
    await ipLeg();
    const post = snapshot();
    const rbLeg = async () => { restore(post); const b = await freshBootModule(); b.reenterMergeQuarantinesAtBoot(registered); return b; };
    const verdicts = (m) => ({ t: m.assertRepoNotQuarantined(T).ok, r1: m.assertRepoNotQuarantined(R1).ok, r2: m.assertRepoNotQuarantined(R2).ok });
    const ip = await ipLeg(), ipShape = shapeOf(ip, T), ipV = verdicts(ip);
    const rb = await rbLeg(), rbShape = shapeOf(rb, T), rbV = verdicts(rb);
    check(`(KEYED ${kind}) in-process pending shape equals a reboot's from the same snapshot`, JSON.stringify(ipShape) === JSON.stringify(rbShape) && ipShape.length === 2);
    check(`(KEYED ${kind}) ...and the verdicts for T, R1 and R2 agree (T blocked${kind === "distinct" ? ", R1 and R2 each blocked by their own file's key" : ", the shared key blocked"})`,
      JSON.stringify(ipV) === JSON.stringify(rbV) && ipV.t === false && ipV.r1 === false && ipV.r2 === (kind === "shared"));
    const afterClear = {};
    for (const [name, leg] of [["inProcess", ipLeg], ["reboot", rbLeg]]) {
      const m = await leg();
      m.clearMergeQuarantineByToken(T, tk1);
      afterClear[name] = verdicts(m);
    }
    check(`(KEYED ${kind}) after clearing tk1 the in-process and reboot verdicts agree`, JSON.stringify(afterClear.inProcess) === JSON.stringify(afterClear.reboot));
    if (kind === "distinct") {
      check("(KEYED distinct) *** after clearing tk1, R1 is FREE and R2 (and T) are still BLOCKED, in both shapes ***",
        afterClear.inProcess.r1 === true && afterClear.inProcess.r2 === false && afterClear.inProcess.t === false);
    } else {
      check("(KEYED shared) after clearing tk1 the shared key stays blocked by tk2 in both shapes", afterClear.inProcess.r1 === false && afterClear.inProcess.t === false);
    }
  }

  // ── Tmp-residue caller (card 63569b55's shape, doubled): two UNARMABLE (no `branch`) foreign tmp residues
  // for ONE unresolvable ghost X under y, filed at a DIFFERENT repo's hash, kept by y's clear ─────────────
  {
    const y = makeRepo("tmp-y");
    const rr = makeRepo("tmp-r");
    const X = path.join(y, "absent-ghost-4c7e0ed0"); // never created -> unresolvable
    const tkA = `tkA-${randomUUID()}`, tkB = `tkB-${randomUUID()}`;
    enterMergeQuarantine(y, "loom/y", "y's own raise (4c7e0ed0 tmp)");
    const rrHash = createHash("sha256").update(canonicalRepoLockKey(rr)).digest("hex").slice(0, 24);
    const plant = (suffix, token) => {
      const base = `${rrHash}.json.tmp-${suffix}`;
      fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, base), JSON.stringify({ repoPath: X, reason: "no branch", enteredAt: Date.now() - 1000, tokens: [token] }));
      return base;
    };
    const tmpA = plant("70001-aaaa0001", tkA), tmpB = plant("70002-aaaa0002", tkB);
    mod.clearMergeQuarantine(y);
    const ipShape = shapeOf(mod, X);
    const ipOk = mod.assertRepoNotQuarantined(X).ok;
    const post = snapshot();
    restore(post);
    const rb = await freshBootModule();
    rb.reenterMergeQuarantinesAtBoot([y, rr]);
    const rbShape = shapeOf(rb, X);
    const expected = [`${tmpA}=${tkA}`, `${tmpB}=${tkB}`].sort();
    check("(TMP) *** THE FIX *** in-process files ONE pending entry per kept tmp residue, each with its own salvaged tokens only", JSON.stringify(ipShape) === JSON.stringify(expected));
    // Boot mints its OWN placeholder token for an unarmable tmp (63569b55 salvages the file's tokens in-process
    // instead), so tokens are deliberately not compared here — only the per-file entry/sourceFile shape.
    const sourceFilesOf = (shape) => shape.map((e) => e.split("=")[0]);
    check("(TMP) ...and a reboot from the post-clear snapshot files the same per-file entries (one per tmp, sourceFile = that tmp)", JSON.stringify(sourceFilesOf(rbShape)) === JSON.stringify(sourceFilesOf(expected)));
    check("(TMP) ...and both shapes still BLOCK X", ipOk === false && rb.assertRepoNotQuarantined(X).ok === false);
  }

  // ── Resolvable T stays ONE unioned ACTIVE entry (the active path is unchanged, matching boot) ──────────
  {
    const A = makeRepo("res-a");
    const T = makeRepo("res-t");
    const tk1 = `tk1-${randomUUID()}`, tk2 = `tk2-${randomUUID()}`;
    const o1 = `${hex24("res-o1")}.json`, o2 = `${hex24("res-o2")}.json`;
    const clearerToken = enterMergeQuarantine(A, "loom/res", "merge in progress (4c7e0ed0 resolvable)");
    foldRefsIntoOwnFinal(A, [o1, o2]);
    const b = await freshBootModule();
    b.reenterMergeQuarantinesAtBoot([A]);
    writeForeign(o1, T, tk1); writeForeign(o2, T, tk2);
    b.clearMergeQuarantineByToken(A, clearerToken);
    const e = b.stillBlockedEntryFor(T);
    check("(RESOLVABLE control) a resolvable T is armed as ONE active entry carrying BOTH tokens, and no pending entry",
      !!e && e.tokens.includes(tk1) && e.tokens.includes(tk2) && b.listPendingTokensTestOnly().filter((p) => p.repoPath === T).length === 0);
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 4c7e0ed0: an unresolvable foreign identity's orphans/tmp residues are armed in-process as one pending entry per file, exactly as a reboot files them."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
