#!/usr/bin/env node
// Approximate the engine-confirmation lag distribution: time between a submit-attempt-1 write and its
// session's next UserPromptSubmit hook.
//
// KNOWN METHODOLOGY GAP (see the write-up's Finding 4): the "[submit] ... Enter attempt 1/4 written" log
// line does not carry a generation/message id, so there is no exact join key from a submit to its true
// confirming hook. This script pairs by time-order per session instead, which breaks down across a
// give-up cascade: several submit1 lines can precede the ONE real hook that eventually confirms the
// (re-minted) message, so naive next-hook-in-time pairing assigns the cascade's LATER attempts to the
// session's NEXT UNRELATED turn -- sometimes hours later. CAP_MS excludes those as pairing artifacts
// (flagged, not silently dropped) rather than pretending they're real per-submission lags.
// The fix for this gap is a one-line log addition -- see the card's item 4 / this investigation's
// findings.md "observability fix" section, landed separately as a docs-adjacent code change.
//
// Usage: node confirmation-lag.mjs <events.json> <session-roles.json>
import fs from 'fs';

const CAP_MS = 900_000; // 15min, matches the incident-clustering gap threshold for the same reason

const [eventsPath, rolesPath] = process.argv.slice(2);
if (!eventsPath || !rolesPath) { console.error('usage: node confirmation-lag.mjs <events.json> <session-roles.json>'); process.exit(1); }

const { submit1s, hooks } = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const roles = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
const roleOf = (sid) => { const r = roles[sid]; return r ? (r.role || 'null') : 'UNKNOWN(not-in-db)'; };

const stampedHooks = hooks.filter(h => h.stamp !== null && h.event === 'UserPromptSubmit');
const hooksBySession = {};
for (const h of stampedHooks) (hooksBySession[h.sessionId] ||= []).push(h.stamp);
for (const sid of Object.keys(hooksBySession)) hooksBySession[sid].sort((a, b) => a - b);

const submitsBySession = {};
for (const s of submit1s.filter(s => s.stamp !== null)) (submitsBySession[s.sessionId] ||= []).push(s.stamp);
for (const sid of Object.keys(submitsBySession)) submitsBySession[sid].sort((a, b) => a - b);

const lags = [];
for (const [sid, subs] of Object.entries(submitsBySession)) {
  const hs = hooksBySession[sid] || [];
  let hi = 0;
  for (const sub of subs) {
    while (hi < hs.length && hs[hi] < sub) hi++;
    if (hi < hs.length) { lags.push({ sessionId: sid, role: roleOf(sid), submitStamp: sub, lagMs: hs[hi] - sub }); hi++; }
  }
}

console.log('total RAW paired samples:', lags.length);
const capped = lags.filter(l => l.lagMs <= CAP_MS);
console.log(`excluded as pairing-artifact (lag > ${CAP_MS / 1000}s): ${lags.length - capped.length} (${(100 * (lags.length - capped.length) / lags.length).toFixed(1)}%)`);

const vals = capped.map(l => l.lagMs).sort((a, b) => a - b);
const pct = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
console.log('clean (<=15min) sample n=', vals.length);
console.log('p50=', pct(0.5), 'p90=', pct(0.9), 'p95=', pct(0.95), 'max=', vals[vals.length - 1]);
for (const thresh of [900, 30000, 60000, 232000]) {
  const n = vals.filter(v => v > thresh).length;
  console.log(`  fraction > ${thresh}ms: ${n}/${vals.length} = ${(100 * n / vals.length).toFixed(1)}%`);
}

const byRole = {};
for (const l of capped) (byRole[l.role] ||= []).push(l.lagMs);
console.log('\nby role (clean set):');
for (const r of Object.keys(byRole)) {
  const arr = [...byRole[r]].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  console.log(`  role=${r}: n=${arr.length} median=${arr[Math.floor(arr.length / 2)]}ms mean=${mean.toFixed(0)}ms max=${arr[arr.length - 1]}ms`);
}
