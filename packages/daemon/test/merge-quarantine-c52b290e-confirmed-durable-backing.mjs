import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card c52b290e, Site 1 — confirmedDurableBackingElsewhere (merge-quarantine.ts) never checked a
// re-pointed multi-key twin's OTHER live-armed key(s) for durable backing, only its (possibly EMPTY)
// `armedKeys` field. `protectOccupantContentBeforeDelete`'s own both-indices re-point branch can arm an
// entry live at MULTIPLE keys (by reference, in `activeQuarantines`) while never stamping `armedKeys`
// onto the replacement object (the `c9114934`/`cd5a3cf9` union gate restricts its source to
// `toPersist`/`oldAtFilename` alone) — see @decision 6be6c9ff's own decision record for the proof this
// shape is production-reachable, and @decision c52b290e for the full residual audit this card closes.
//
// Mechanism (pre-fix): `confirmedDurableBackingElsewhere` scanned `entry.armedKeys ?? []` alone. For a
// re-pointed twin with armedKeys:[] but LIVE-armed at [K, K2] by reference, the loop body never ran even
// though K2's own real, on-disk latch genuinely, durably backs the token — the function wrongly reported
// `false` ("not backed elsewhere"). That feeds `survivingTokenHolderRepoPaths` -> `differentUnresolvableOccupantRepoPathAt`
// (the sole prod call site passing `excludeFinalPath`) -> an unnecessary "surviving holder"/occupant-to-
// protect flag — fail-closed (over-protective), never fail-open.
//
// Fix: scans {@link liveArmedKeysOf} (a new key-less helper: union of `entry.armedKeys` and a live
// `activeQuarantines` scan for `v === entry`) — the SAME live-occupancy source `liveArmedKeys(key, entry)`
// itself now calls, so there is one source for "every key this entry might be armed at right now".
//
// Run: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/merge-quarantine-c52b290e-confirmed-durable-backing.mjs
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqc52b290e-s1-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { confirmedDurableBackingElsewhere, setActiveQuarantineTestOnly, MERGE_QUARANTINE_DIR } = await import(mergeQuarantineModuleHref);

const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function writeLatch(key, repoPath, tokens) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashKey(key)}.json`), JSON.stringify({
    repoPath, branch: "b", reason: "r", enteredAt: Date.now(), tokens,
  }, null, 2) + "\n");
}

{
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s1-${sfx}-never`;
  const K = `mqc52b290e-s1-K-${sfx}`;
  const K2 = `mqc52b290e-s1-K2-${sfx}`;
  const tok = `tok-${sfx}`;
  const finalK = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K)}.json`);

  // *** THE CARD'S OWN SHAPE *** — re-pointed multi-key twin: LIVE-armed (by reference) at BOTH K and
  // K2, but `armedKeys` field is EMPTY.
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: [tok], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);

  // K2's own REAL on-disk latch durably backs `tok`, for the SAME identity.
  writeLatch(K2, X, [tok]);

  check("*** SITE 1 *** (card's own shape) K2's real durable backing IS recognized despite armedKeys:[]",
    confirmedDurableBackingElsewhere(entry, tok, finalK) === true);
}

{
  // NEGATIVE CONTROL A — same live-multi-key shape, but K2's own on-disk latch carries a DIFFERENT token
  // (not `tok`) — must NOT report backed for `tok`. Proves the check is token-specific, not merely
  // "some file exists at an armed key".
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s1-${sfx}-never`;
  const K = `mqc52b290e-s1-K-${sfx}`;
  const K2 = `mqc52b290e-s1-K2-${sfx}`;
  const tok = `tok-${sfx}`;
  const otherTok = `other-tok-${sfx}`;
  const finalK = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K)}.json`);
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: [tok], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);
  writeLatch(K2, X, [otherTok]);

  check("*** SITE 1 *** (negative control A) K2 holds a DIFFERENT token — not reported as backed",
    confirmedDurableBackingElsewhere(entry, tok, finalK) === false);
}

{
  // NEGATIVE CONTROL B — K2 is live-armed (by reference) but has NO physical latch file at all (ENOENT)
  // — must NOT report backed.
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s1-${sfx}-never`;
  const K = `mqc52b290e-s1-K-${sfx}`;
  const K2 = `mqc52b290e-s1-K2-${sfx}`;
  const tok = `tok-${sfx}`;
  const finalK = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K)}.json`);
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: [tok], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);
  // No writeLatch(K2, ...) at all.

  check("*** SITE 1 *** (negative control B) K2 has no physical file at all — not reported as backed",
    confirmedDurableBackingElsewhere(entry, tok, finalK) === false);
}

{
  // NEGATIVE CONTROL C — K2's own physical latch exists and carries `tok`, but for a DIFFERENT identity
  // — must NOT report backed (the identity check must still gate it).
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s1-${sfx}-never`;
  const Foreign = `C:\\mqc52b290e-s1-${sfx}-foreign-never`;
  const K = `mqc52b290e-s1-K-${sfx}`;
  const K2 = `mqc52b290e-s1-K2-${sfx}`;
  const tok = `tok-${sfx}`;
  const finalK = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K)}.json`);
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: [tok], armedKeys: [] };
  setActiveQuarantineTestOnly(K, entry);
  setActiveQuarantineTestOnly(K2, entry);
  writeLatch(K2, Foreign, [tok]);

  check("*** SITE 1 *** (negative control C) K2 holds `tok` but for a FOREIGN identity — not reported as backed",
    confirmedDurableBackingElsewhere(entry, tok, finalK) === false);
}

{
  // CONTROL D — pre-existing shape (armedKeys correctly lists K2, no live-occupancy reliance needed):
  // confirms the fix did not regress the already-working case `6be6c9ff`'s own audit never flagged.
  const sfx = freshSfx();
  const X = `C:\\mqc52b290e-s1-${sfx}-never`;
  const K = `mqc52b290e-s1-K-${sfx}`;
  const K2 = `mqc52b290e-s1-K2-${sfx}`;
  const tok = `tok-${sfx}`;
  const finalK = path.join(MERGE_QUARANTINE_DIR, `${hashKey(K)}.json`);
  const entry = { repoPath: X, branch: "b", reason: "twin", enteredAt: Date.now(), tokens: [tok], armedKeys: [K2] };
  writeLatch(K2, X, [tok]);

  check("*** SITE 1 *** (control D, pre-existing armedKeys:[K2] shape) still correctly reports backed",
    confirmedDurableBackingElsewhere(entry, tok, finalK) === true);
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — confirmedDurableBackingElsewhere now recognizes a re-pointed multi-key twin's "
    + "durable backing at its OTHER live-armed key(s), never just its (possibly empty) armedKeys field."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card c52b290e's Site 1 hazard.`);
process.exit(failures === 0 ? 0 : 1);
