import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 6de79dc0 — deliberate fail-closed PIN, not a bug: merging a precise pending entry with a
// contributor-unaware (placeholder/collision) one degrades genuineContributorKeys to legacy (undefined),
// never to `[]` — `[]` would be a false precision claim about content never actually verified.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq6b32-i2-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mod = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // T: an unresolvable ghost identity.
  const T = path.join(os.tmpdir(), `loom-mq6b32-ghost-T-${freshSfx()}`);

  // 1) Fresh raise -> PRECISE pending entry with genuineContributorKeys:[] (6de79dc0's own stamp).
  const t1 = enterMergeQuarantine(T, "loom/t-branch", "merge in progress for T (6b327712 item2, first raise)");
  const afterFirst = mod.activeMergeQuarantineFor(T);
  check("precondition: T lands PENDING after first raise", !!afterFirst && afterFirst.tokens.length === 1);
  check("precondition: fresh raise stamps genuineContributorKeys:[] (precise)", Array.isArray(afterFirst.genuineContributorKeys) && afterFirst.genuineContributorKeys.length === 0);

  // 2) Inject a SECOND, independent pending record for the SAME identity — a contributor-unaware
  // collision/placeholder shape. Every real boot-time PLACEHOLDER construction in merge-quarantine.ts
  // (CORRUPT/UNREADABLE/UNRESOLVED shapes) never stamps genuineContributorKeys either, since its own
  // content is, by definition, unverified — this models that SAME real, non-legacy shape directly
  // (mirrors 028837ad's own MULTI-EPERM collision-file construction technique).
  const collisionBasename = `mq6b32-i2-collision-${freshSfx()}.json`;
  const tB = "tok-collision-" + freshSfx();
  const collisionEntry = { repoPath: T, branch: "loom/t-collision-branch", reason: "merge in progress for T (6b327712 item2, collision)", tokens: [tB], enteredAt: Date.now() + 1000 };
  fs.writeFileSync(path.join(mod.MERGE_QUARANTINE_DIR, collisionBasename), JSON.stringify(collisionEntry));
  mod.pushPendingQuarantineTestOnly(collisionEntry, collisionBasename);
  check("precondition: T now has TWO independent pending records sharing one identity", mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === T).length === 2);
  check("precondition: the collision record genuinely lacks genuineContributorKeys", collisionEntry.genuineContributorKeys === undefined);

  // 3) Raise T a THIRD time -> matches BOTH pending indices -> mergeTokenIntoPendingEntries merges them.
  const t3 = enterMergeQuarantine(T, "loom/t-branch", "merge in progress for T (6b327712 item2, third raise, merges both)");
  check("precondition: T's two pending records are now merged into ONE", mod.listPendingMergeQuarantinesTestOnly().filter((p) => p.repoPath === T).length === 1);
  const merged = mod.activeMergeQuarantineFor(T);
  check("precondition: the merged record carries all three tokens", [t1, tB, t3].every((t) => merged.tokens.includes(t)));

  check("PIN: the merge degrades genuineContributorKeys to undefined (legacy), never [] — the precise entry's own [] is correctly NOT trusted once a contributor-unaware record is folded in", merged.genuineContributorKeys === undefined);

  // Durable: on-disk reflects the SAME degrade, not just in-process.
  const onDiskAfterMerge = JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, mod.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === T).sourceFile), "utf8"));
  check("PIN: on-disk merged record also lacks genuineContributorKeys (durable degrade, not just in-process)", onDiskAfterMerge.genuineContributorKeys === undefined);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
