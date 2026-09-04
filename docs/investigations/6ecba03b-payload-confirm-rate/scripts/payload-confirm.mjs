#!/usr/bin/env node
// Card 6ecba03b instrument: does write-confirm probability fall as PAYLOAD size rises?
// OBSERVATIONAL analysis of real daemon-output.log history (6 contiguous rotated files,
// ~15.6 days, self-hosting Loom daemon). Positive-controlled stamp/regex parsing, modeled on
// docs/investigations/04de8bbf-giveup-confirmation-lag/scripts/parse-log-events.mjs but with
// regexes re-verified against the CURRENT log wording (04de8bbf's own GIVEUP_RE — "no engine
// output observed" — does NOT match the current code's "no confirming hook observed" text;
// confirmed stale, not reused blindly).
//
// Usage: node payload-confirm.mjs <log1> <log2> ... (chronological order, oldest first)
import fs from "fs";
import readline from "readline";

const STAMP_MIN = 1.7e12;
function extractStamp(line) {
  const idx = line.lastIndexOf(" ");
  if (idx === -1) return null;
  const tok = line.slice(idx + 1).trim();
  if (!/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  if (!Number.isFinite(n) || n < STAMP_MIN) return null;
  return n;
}

const SUBMIT_WRITE_RE = /^\[submit-write\] (\S+) reason=(\S+) busyBefore=(\S+) len=(\d+) head=/;
const ENTER1_RE = /^\[submit\] (\S+) Enter attempt 1\/4 written(?: gen=(\d+))?/;
// The corpus spans a wording change mid-history (card 441499ee's awaitGiveUpConfirmSettle hardening):
// OLDER lines (daemon-output.log.5/.4/.3, roughly pre-2026-08-3x) say "no engine output observed";
// NEWER lines (.2/.1/current) say "no confirming hook observed". Confirmed by direct grep against this
// exact corpus (86/94/53 vs 0/0/0 for "no confirming hook observed" on the old files, and the reverse
// on the new ones) rather than assumed from the sibling investigation's regex, which only had the OLD
// wording and would silently undercount 233/302 (77%) of true give-ups in this corpus if reused as-is.
const GIVEUP_TRUE_RE = /^\[submit\] (\S+) GIVE-UP RECOVERY after (\d+) Enter attempts — no (?:engine output|confirming hook) observed/;
const GIVEUP_FALSE_RE = /^\[submit\] (\S+) GIVE-UP SUPPRESSED after (\d+) Enter attempts — a confirming hook arrived/;
const GIVEUP_DECOY_RE = /^\[submit\] (\S+) GIVE-UP RECOVERY: re-queued/; // old, non-classification line (04de8bbf trap #4)

// ============ Positive/negative control on the REGEXES themselves ============
function selfCheck() {
  let ok = true;
  const cases = [
    ["[submit-write] abc reason=immediate busyBefore=false len=215 head=<redacted len=60 hash=x> 1788523077686", SUBMIT_WRITE_RE, true],
    ["[submit] abc Enter attempt 1/4 written gen=6 — awaiting confirmation 1788523077845", ENTER1_RE, true],
    ["[submit] abc Enter attempt 2/4 written gen=6 — awaiting confirmation 1788523077845", ENTER1_RE, false],
    ["[submit] abc GIVE-UP RECOVERY after 4 Enter attempts — no confirming hook observed since the final Enter write; turn never confirmed started; recovering busy so the session doesn't wedge 1788357372970", GIVEUP_TRUE_RE, true],
    ["[submit] abc GIVE-UP RECOVERY after 4 Enter attempts — no engine output observed since the final Enter write; turn never confirmed started; recovering busy so the session doesn't wedge 1787572129588", GIVEUP_TRUE_RE, true],
    ["[submit] abc GIVE-UP RECOVERY after 4 Enter attempts — no confirming hook observed despite output after the final Enter write (the output discriminator's suppression was never confirmed by an actual hook); turn never confirmed started 1788357372970", GIVEUP_TRUE_RE, true],
    ["[submit] abc GIVE-UP SUPPRESSED after 4 Enter attempts — a confirming hook arrived (turn actually started); leaving busy/composer untouched 1788396133333", GIVEUP_TRUE_RE, false], // must NOT match the TRUE regex
    ["[submit] abc GIVE-UP SUPPRESSED after 4 Enter attempts — engine produced output after the final Enter write (turn likely already running; hook confirmation just late); verifying before committing to this suppression 1788396132843", GIVEUP_TRUE_RE, false], // provisional line, must NOT match
    ["[submit] abc GIVE-UP RECOVERY: re-queued 3 message(s) at the front of pending, HELD from drain for up to 20000ms 1788357372970", GIVEUP_TRUE_RE, false], // old decoy line (04de8bbf trap #4)
    ["[submit] abc GIVE-UP SUPPRESSED after 4 Enter attempts — a confirming hook arrived (turn actually started); leaving busy/composer untouched 1788396133333", GIVEUP_FALSE_RE, true],
  ];
  for (const [line, re, expect] of cases) {
    const got = re.test(line);
    if (got !== expect) { ok = false; console.error(`SELF-CHECK FAILED: expected ${expect} got ${got} for regex ${re} against: ${line}`); }
  }
  // stamp positive control (04de8bbf's own three known-unstamped cases + one known-stamped)
  const knownUnstamped = [
    "[pty] listening on 127.0.0.1:60848",
    "[submit] abc GIVE-UP RECOVERY: re-queued 3 message(s) at the front of pending, HELD from drain for up to 20000ms",
    "[hook] abc SessionStart session_id=1234",
  ];
  for (const c of knownUnstamped) { if (extractStamp(c) !== null) { ok = false; console.error(`STAMP SELF-CHECK FAILED (should be null): ${c}`); } }
  if (extractStamp("x GIVE-UP RECOVERY after 4 Enter attempts 1785314994518") !== 1785314994518) { ok = false; console.error("STAMP SELF-CHECK FAILED on known-stamped case"); }
  if (ok) console.error("SELF-CHECK: all regex + stamp positive/negative controls passed");
  return ok;
}

if (!selfCheck()) { console.error("Aborting — self-check failed."); process.exit(1); }

async function parseFile(path, sink) {
  const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    const stamp = extractStamp(line);
    if (stamp === null) continue; // unstamped lines carry no reliable time-order info; excluded (matches 04de8bbf's convention)
    let m;
    if ((m = SUBMIT_WRITE_RE.exec(line))) sink.submitWrites.push({ sid: m[1], reason: m[2], len: Number(m[4]), stamp });
    else if ((m = ENTER1_RE.exec(line))) sink.enter1s.push({ sid: m[1], gen: m[2] !== undefined ? Number(m[2]) : null, stamp });
    else if (GIVEUP_TRUE_RE.test(line)) { m = GIVEUP_TRUE_RE.exec(line); sink.giveupsTrue.push({ sid: m[1], stamp }); }
    else if (GIVEUP_FALSE_RE.test(line)) { m = GIVEUP_FALSE_RE.exec(line); sink.giveupsFalseSuppressed.push({ sid: m[1], stamp }); }
  }
  return n;
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error("usage: node payload-confirm.mjs <log1> <log2> ... (chronological, oldest first)"); process.exit(1); }

const sink = { submitWrites: [], enter1s: [], giveupsTrue: [], giveupsFalseSuppressed: [] };
let totalLines = 0;
for (const f of files) {
  const n = await parseFile(f, sink);
  totalLines += n;
  console.error(`parsed ${f}: ${n} lines`);
}
for (const arr of [sink.submitWrites, sink.enter1s, sink.giveupsTrue, sink.giveupsFalseSuppressed]) arr.sort((a, b) => a.stamp - b.stamp);

console.error(`\nRAW COUNTS across ${files.length} files, ${totalLines} total lines:`);
console.error(`  submit-write events: ${sink.submitWrites.length}`);
console.error(`  Enter-attempt-1 events: ${sink.enter1s.length}`);
console.error(`  GIVE-UP RECOVERY (true give-up) events: ${sink.giveupsTrue.length}`);
console.error(`  GIVE-UP SUPPRESSED (confirmed late, NOT a give-up) events: ${sink.giveupsFalseSuppressed.length}`);
const timeRange = sink.enter1s.length ? [new Date(sink.enter1s[0].stamp).toISOString(), new Date(sink.enter1s[sink.enter1s.length - 1].stamp).toISOString()] : null;
console.error(`  stamped range (Enter-attempt-1): ${timeRange?.[0]} -> ${timeRange?.[1]}`);

// ============ Join 1: each Enter-attempt-1 -> nearest preceding submit-write, SAME session, within LOOKBACK_MS ============
// PTY_WRITE_CHUNK_UNITS=1024B/PTY_WRITE_CHUNK_DELAY_MS=8ms -> a 185KB payload takes ~1.5s to fully
// chunk-write; 30s lookback is generous headroom over that, sized from the production pacing
// constants rather than guessed.
const LOOKBACK_MS = 30_000;
const submitWritesBySid = new Map();
for (const sw of sink.submitWrites) {
  if (!submitWritesBySid.has(sw.sid)) submitWritesBySid.set(sw.sid, []);
  submitWritesBySid.get(sw.sid).push(sw);
}

function nearestPrecedingSubmitWrite(sid, stamp) {
  const arr = submitWritesBySid.get(sid);
  if (!arr) return null;
  // arr is sorted by stamp (sink.submitWrites was sorted globally, and per-sid subsets preserve order)
  let best = null;
  for (const sw of arr) {
    if (sw.stamp > stamp) break;
    if (stamp - sw.stamp > LOOKBACK_MS) continue;
    best = sw; // keep advancing to the LATEST one still <= stamp and within window
  }
  return best;
}

let enter1Resolved = 0, enter1Unresolved = 0;
const enter1Len = new Map(); // keyed by `${sid}|${stamp}` -> len
const enter1Reason = new Map(); // keyed by `${sid}|${stamp}` -> reason (for the reason confound check)
for (const e of sink.enter1s) {
  const sw = nearestPrecedingSubmitWrite(e.sid, e.stamp);
  if (sw) { enter1Resolved++; enter1Len.set(`${e.sid}|${e.stamp}`, sw.len); enter1Reason.set(`${e.sid}|${e.stamp}`, sw.reason); }
  else enter1Unresolved++;
}
console.error(`\nJOIN 1 (Enter-attempt-1 -> len via nearest preceding same-session submit-write, <= ${LOOKBACK_MS}ms lookback):`);
console.error(`  resolved: ${enter1Resolved}  unresolved (no matching submit-write in window): ${enter1Unresolved}`);

// ============ Join 2: each GIVE-UP RECOVERY (true) -> nearest preceding same-session Enter-attempt-1, <=15s ============
// 15s window per 04de8bbf's own validated join (4 attempts x 900ms + settle wait ~ 3.6-4s; 15s is
// their margin, reused unchanged here, not re-derived).
const GIVEUP_JOIN_MS = 15_000;
const enter1sBySid = new Map();
for (const e of sink.enter1s) {
  if (!enter1sBySid.has(e.sid)) enter1sBySid.set(e.sid, []);
  enter1sBySid.get(e.sid).push(e);
}
function nearestPrecedingEnter1(sid, stamp) {
  const arr = enter1sBySid.get(sid);
  if (!arr) return null;
  let best = null;
  for (const e of arr) {
    if (e.stamp > stamp) break;
    if (stamp - e.stamp > GIVEUP_JOIN_MS) continue;
    best = e;
  }
  return best;
}

let giveupLinked = 0, giveupUnlinked = 0;
const linkedEnter1Keys = new Set(); // to check for double-claims (04de8bbf's own cleanliness check)
let doubleClaims = 0;
const giveupTrueLens = [];
const giveupTrueReasons = [];
for (const g of sink.giveupsTrue) {
  const e = nearestPrecedingEnter1(g.sid, g.stamp);
  if (!e) { giveupUnlinked++; continue; }
  giveupLinked++;
  const key = `${e.sid}|${e.stamp}`;
  if (linkedEnter1Keys.has(key)) doubleClaims++;
  linkedEnter1Keys.add(key);
  const len = enter1Len.get(key);
  if (len !== undefined) { giveupTrueLens.push(len); giveupTrueReasons.push(enter1Reason.get(key)); }
}
console.error(`\nJOIN 2 (GIVE-UP RECOVERY(true) -> nearest preceding same-session Enter-attempt-1, <= ${GIVEUP_JOIN_MS}ms):`);
console.error(`  linked: ${giveupLinked}  unlinked (no Enter-attempt-1 in window): ${giveupUnlinked}  double-claims: ${doubleClaims}`);
console.error(`  of linked give-ups, ${giveupTrueLens.length} also resolved a len via Join 1`);

// ============ Bucket everything by len ============
function bucketOf(len) {
  if (len < 5_000) return "<5KB";
  if (len < 20_000) return "5-20KB";
  if (len < 60_000) return "20-60KB";
  if (len < 120_000) return "60-120KB";
  return "120KB+";
}
const BUCKET_ORDER = ["<5KB", "5-20KB", "20-60KB", "60-120KB", "120KB+"];

const denomByBucket = new Map(BUCKET_ORDER.map((b) => [b, 0]));
for (const [, len] of enter1Len) denomByBucket.set(bucketOf(len), (denomByBucket.get(bucketOf(len)) || 0) + 1);

const numerByBucket = new Map(BUCKET_ORDER.map((b) => [b, 0]));
for (const len of giveupTrueLens) numerByBucket.set(bucketOf(len), (numerByBucket.get(bucketOf(len)) || 0) + 1);

console.error(`\n============ RESULT: give-up rate by payload-size bucket ============`);
console.error(`INSTRUMENT: real daemon-output.log history (self-hosting Loom fleet), 6 contiguous rotated files, ${timeRange?.[0]} -> ${timeRange?.[1]}. OBSERVATIONAL, not a controlled sweep (role/machine/engine/mode-cycle/host-load NOT held constant).`);
console.error(`bucket        n(submits)   n(give-up)   rate`);
let totalN = 0, totalG = 0;
for (const b of BUCKET_ORDER) {
  const n = denomByBucket.get(b) || 0;
  const g = numerByBucket.get(b) || 0;
  totalN += n; totalG += g;
  const rate = n > 0 ? ((g / n) * 100).toFixed(2) + "%" : "n/a";
  console.error(`${b.padEnd(13)} ${String(n).padEnd(12)} ${String(g).padEnd(12)} ${rate}`);
}
console.error(`TOTAL         ${totalN}           ${totalG}           ${totalN ? ((totalG / totalN) * 100).toFixed(2) + "%" : "n/a"}`);

// simple 2x2 chi-square: <20KB vs >=20KB (a natural small/large split near the card's ~46KB midpoint)
function sumRange(map, pred) { let s = 0; for (const [k, v] of map) if (pred(k)) s += v; return s; }
const smallN = sumRange(denomByBucket, (b) => b === "<5KB" || b === "5-20KB");
const smallG = sumRange(numerByBucket, (b) => b === "<5KB" || b === "5-20KB");
const largeN = sumRange(denomByBucket, (b) => b === "20-60KB" || b === "60-120KB" || b === "120KB+");
const largeG = sumRange(numerByBucket, (b) => b === "20-60KB" || b === "60-120KB" || b === "120KB+");
console.error(`\n2x2 split (<20KB vs >=20KB): small n=${smallN} g=${smallG} rate=${smallN ? (smallG / smallN * 100).toFixed(2) : "n/a"}%   large n=${largeN} g=${largeG} rate=${largeN ? (largeG / largeN * 100).toFixed(2) : "n/a"}%`);
function chiSquare2x2(a, b, c, d) { // a=smallG, b=smallN-smallG, c=largeG, d=largeN-largeG
  const n = a + b + c + d;
  const num = n * Math.pow(a * d - b * c, 2);
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  return den === 0 ? null : num / den;
}
const chi = chiSquare2x2(smallG, smallN - smallG, largeG, largeN - largeG);
console.error(`chi-square (df=1): ${chi === null ? "n/a" : chi.toFixed(3)} (>=3.84 ~ p<0.05, >=6.63 ~ p<0.01)`);

// ============ Confound check: does the size effect survive WITHIN a single `reason` category? ============
// `reason` (from submit-write) names the delivery path (immediate/kickoff-guarantee/etc.) — a cheap,
// already-collected stratifier. If size only "predicts" give-up because one reason (e.g. large kickoffs)
// has a different baseline rate than another (e.g. small immediate messages), the raw bucket table above
// would show an effect that's really about REASON, not SIZE. Reusing the same <20KB/>=20KB split per reason.
const reasonSet = new Set([...enter1Reason.values()]);
console.error(`\n============ CONFOUND CHECK: size effect within each \`reason\` (submit-write path) ============`);
console.error(`reason               small n/g/rate            large n/g/rate            chi2`);
const byReason = [];
for (const reason of reasonSet) {
  let sN = 0, sG = 0, lN = 0, lG = 0;
  for (const [key, len] of enter1Len) {
    if (enter1Reason.get(key) !== reason) continue;
    if (len < 20_000) sN++; else lN++;
  }
  for (let i = 0; i < giveupTrueLens.length; i++) {
    if (giveupTrueReasons[i] !== reason) continue;
    if (giveupTrueLens[i] < 20_000) sG++; else lG++;
  }
  const sRate = sN ? (sG / sN * 100).toFixed(2) + "%" : "n/a";
  const lRate = lN ? (lG / lN * 100).toFixed(2) + "%" : "n/a";
  const chi2 = chiSquare2x2(sG, sN - sG, lG, lN - lG);
  console.error(`${reason.padEnd(20)} n=${String(sN).padEnd(5)} g=${String(sG).padEnd(4)} ${sRate.padEnd(8)}  n=${String(lN).padEnd(5)} g=${String(lG).padEnd(4)} ${lRate.padEnd(8)}  ${chi2 === null ? "n/a" : chi2.toFixed(2)}`);
  byReason.push({ reason, smallN: sN, smallG: sG, largeN: lN, largeG: lG, chiSquare: chi2 });
}

console.error(`\nOutput JSON below for archival:`);
console.log(JSON.stringify({
  files, totalLines, timeRange,
  rawCounts: { submitWrites: sink.submitWrites.length, enter1s: sink.enter1s.length, giveupsTrue: sink.giveupsTrue.length, giveupsFalseSuppressed: sink.giveupsFalseSuppressed.length },
  join1: { lookbackMs: LOOKBACK_MS, resolved: enter1Resolved, unresolved: enter1Unresolved },
  join2: { joinMs: GIVEUP_JOIN_MS, linked: giveupLinked, unlinked: giveupUnlinked, doubleClaims },
  buckets: BUCKET_ORDER.map((b) => ({ bucket: b, n: denomByBucket.get(b) || 0, g: numerByBucket.get(b) || 0 })),
  smallVsLarge: { smallN, smallG, largeN, largeG, chiSquare: chi },
  byReason,
}, null, 2));
