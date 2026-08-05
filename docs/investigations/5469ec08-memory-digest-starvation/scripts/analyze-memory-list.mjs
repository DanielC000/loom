import { readFileSync } from "fs";

const path = process.argv[2];
const raw = readFileSync(path, "utf8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);

const notes = lines.map((l) => JSON.parse(l));

console.log("total notes:", notes.length);
const pinned = notes.filter((n) => n.pinned);
console.log("pinned:", pinned.length);
const neverDrop = pinned.filter((n) => (n.tags || []).includes("never-drop"));
console.log("never-drop (pinned+tag):", neverDrop.length);
const restPinned = pinned.filter((n) => !(n.tags || []).includes("never-drop"));
console.log("rest-pinned (pinned, no never-drop):", restPinned.length);
const unpinned = notes.filter((n) => !n.pinned);
console.log("unpinned:", unpinned.length);

const neverDelivered = notes.filter((n) => !n.everDelivered);
console.log("everDelivered:false total:", neverDelivered.length);
console.log("  of which pinned:", neverDelivered.filter((n) => n.pinned).length);
console.log("  of which unpinned:", neverDelivered.filter((n) => !n.pinned).length);
console.log("  of which never-drop:", neverDelivered.filter((n) => (n.tags||[]).includes("never-drop")).length);

// estimate tokens like estimateTokens: bytes/4, roughly, over title+text (not exact digest format but close)
function estTok(n) {
  const body = `### ${n.title || n.key} (${n.key})\n${(n.text||"").trim()}`;
  return Math.ceil(Buffer.byteLength(body, "utf8") / 4);
}
const floorTokTotal = neverDrop.reduce((s, n) => s + estTok(n), 0);
console.log("floor tier notes:", neverDrop.map((n) => n.key));
console.log("floor tier est tokens (approx, header not included):", floorTokTotal);

// unpinned average/median token size
const unpinnedToks = unpinned.map(estTok).sort((a,b)=>a-b);
const avg = unpinnedToks.reduce((a,b)=>a+b,0) / unpinnedToks.length;
const median = unpinnedToks[Math.floor(unpinnedToks.length/2)];
console.log("unpinned avg tok (approx):", avg.toFixed(1), "median:", median);

// cross-check keys named in this session's own kickoff drop lines
const droppedPinnedKeysFromKickoff = [
  "a-claim-crossing-a-project-boundary-loses-its-scope","dangling-worker-rows-do-not-consume-slots",
  "engine-confirmation-can-lag-minutes-timeouts-assume-seconds","commit-before-run-gate-or-forfeit-reuse",
  "a-resume-doc-is-a-rewrite-not-a-ledger","first-turn-pasted-text-placeholder-is-the-kickoff",
  "a-censored-instrument-manufactures-agreement","rarity-is-not-low-priority-price-the-exposure",
  "a-comment-is-a-claim-grep-them-when-you-fix","positive-control-your-searches-empty-is-not-evidence",
  "a-baseline-with-no-recorded-condition-is-not-a-baseline","two-states-one-signature-add-a-discriminator",
  "discriminating-control-and-proof-beats-measurement","codescape-is-private-no-user-visible-surface",
  "exoneration-proves-the-card-innocent-not-the-failure-spurious","read-which-assertions-failed-not-how-many"
];
const droppedRelatedKeysFromKickoff = [
  "did-it-land-check-by-title-or-content","a-tight-subset-is-the-most-persuasive-way-to-be-wrong",
  "tasks-list-summary-hides-held-flag","an-approximation-launders-into-a-settled-fact-by-citation",
  "windows-execfilesync-posix-cwd-silent-fail","release-cut-checklist-and-linux-ci-verify",
  "the-gate-reports-one-failure-sweep-the-cheap-guards-first","concurrent-gates-is-admission-instant-not-max-over-run"
];

console.log("\n--- cross-check: dropped-PINNED keys from my own kickoff ---");
for (const k of droppedPinnedKeysFromKickoff) {
  const n = notes.find((x) => x.key === k);
  if (!n) { console.log(k, "-> NOT FOUND in memory_list"); continue; }
  console.log(k, "pinned:", n.pinned, "neverDropTag:", (n.tags||[]).includes("never-drop"), "everDelivered:", n.everDelivered, "retrievalCount:", n.retrievalCount);
}
console.log("\n--- cross-check: dropped-RELATED keys from my own kickoff ---");
for (const k of droppedRelatedKeysFromKickoff) {
  const n = notes.find((x) => x.key === k);
  if (!n) { console.log(k, "-> NOT FOUND in memory_list"); continue; }
  console.log(k, "pinned:", n.pinned, "everDelivered:", n.everDelivered, "retrievalCount:", n.retrievalCount);
}

console.log("\n--- the 7 floor-tier notes actually delivered to me this kickoff (from my system prompt) ---");
const deliveredFloorKeysFromKickoff = [
  "shipping-a-detector-is-not-someone-reading-it",
  "corroborating-a-premise-is-not-corroborating-the-inference",
  "a-rule-stored-next-to-an-artifact-does-not-check-it",
  "read-the-artifact-before-you-send-not-after",
  "the-qualifier-dies-in-the-summary-label",
  "a-control-inherits-the-equivalence-you-assumed-building-it",
  "gate-cap-is-2-by-owner-decision-never-change-silently"
];
for (const k of deliveredFloorKeysFromKickoff) {
  const n = notes.find((x) => x.key === k);
  if (!n) { console.log(k, "-> NOT FOUND"); continue; }
  console.log(k, "pinned:", n.pinned, "neverDropTag:", (n.tags||[]).includes("never-drop"), "estTok:", estTok(n));
}
