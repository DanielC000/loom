#!/usr/bin/env node
// Reverse-causality confound check for time-radius-concurrency.mjs's inverse result: a significant
// result in the UNEXPECTED direction is usually a confound, not a discovery. Candidate mechanism: a
// session whose engine is lagging doesn't cause LOW concurrency -- rather, the SAME shared host
// contention that's stalling this session's confirmation ALSO makes other sessions in the fleet submit
// less right then (a manager pausing to wait on a response, or every session's own event loop getting
// less CPU time at once). That would produce the identical inverse correlation while meaning the
// opposite thing.
//
// Test: for each give-up's triggering submit, compare concurrency in a PRIOR window (-300s to -60s,
// ending exactly where the AT window begins, no overlap) against the AT window (+/-60s, matching
// time-radius-concurrency.mjs's primary radius).
//   - PRIOR also low (<=1)  => genuinely idle neighborhood, the inverse effect is NOT explained by this
//     confound (though it could still be explained by another one).
//   - PRIOR notably higher, then AT drops => the neighborhood was active and specifically went quiet
//     right at the failure -- consistent with the confound, and the inverse result should NOT be read
//     as evidence against a shared-contention mechanism.
// Also computes the same PRIOR-vs-AT gap for ALL submits (not just give-ups) as a baseline, since some
// gap is expected from ordinary autocorrelation/decay-toward-now; the question is whether give-ups show
// a LARGER gap than that baseline.
//
// Usage: node confound-check-prior-window.mjs <events.json> <session-roles.json>
import fs from 'fs';

const [eventsPath, rolesPath] = process.argv.slice(2);
if (!eventsPath || !rolesPath) { console.error('usage: node confound-check-prior-window.mjs <events.json> <session-roles.json>'); process.exit(1); }

const roles = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
const { giveups, submit1s } = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const roleOf = (sid) => { const r = roles[sid]; return r ? (r.role || 'null') : 'UNKNOWN'; };
const LINK_WINDOW_MS = 15000;

const sGiveups = giveups.filter(g => g.stamp !== null);
const sSubmit1 = submit1s.filter(s => s.stamp !== null).map(s => ({ ...s, role: roleOf(s.sessionId) }));

const bySession = {};
for (const s of sSubmit1) (bySession[s.sessionId] ||= []).push(s);
for (const sid of Object.keys(bySession)) bySession[sid].sort((a, b) => a.stamp - b.stamp);

const triggers = [];
for (const g of sGiveups) {
  const subs = bySession[g.sessionId] || [];
  let best = null;
  for (const s of subs) { if (s.stamp > g.stamp) break; if (g.stamp - s.stamp <= LINK_WINDOW_MS) best = s; }
  if (best) triggers.push(best);
}
console.log('linked triggers:', triggers.length, '/', sGiveups.length);

const allSubmits = [...sSubmit1].sort((a, b) => a.stamp - b.stamp);
const stampsArr = allSubmits.map(s => s.stamp);
function lowerBound(arr, target) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; } return lo; }
function distinctOtherInRange(loMs, hiMs, excludeSessionId) {
  const lo = lowerBound(stampsArr, loMs), hi = lowerBound(stampsArr, hiMs + 1);
  const s = new Set();
  for (let i = lo; i < hi; i++) if (allSubmits[i].sessionId !== excludeSessionId) s.add(allSubmits[i].sessionId);
  return s.size;
}
const atConc = (t, excl) => distinctOtherInRange(t - 60000, t + 60000, excl);
const priorConc = (t, excl) => distinctOtherInRange(t - 300000, t - 60000, excl);

const rows = triggers.map(t => ({ role: t.role, at: atConc(t.stamp, t.sessionId), prior: priorConc(t.stamp, t.sessionId) }));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const meanAt = mean(rows.map(r => r.at)), meanPrior = mean(rows.map(r => r.prior));
console.log(`give-ups: mean AT=${meanAt.toFixed(3)} mean PRIOR=${meanPrior.toFixed(3)}`);

const genuinelyIdle = rows.filter(r => r.prior <= 1).length;
const wentQuiet = rows.filter(r => r.prior >= 2 && r.at < r.prior).length;
console.log(`genuinely-idle-both-windows(prior<=1): ${genuinelyIdle}/${rows.length}`);
console.log(`went-quiet-at-failure(prior>=2 & at<prior): ${wentQuiet}/${rows.length}`);

const baseRows = allSubmits.map(s => ({ at: atConc(s.stamp, s.sessionId), prior: priorConc(s.stamp, s.sessionId) }));
const baseMeanAt = mean(baseRows.map(r => r.at)), baseMeanPrior = mean(baseRows.map(r => r.prior));
console.log(`\nbaseline (all ${baseRows.length} submits): mean AT=${baseMeanAt.toFixed(3)} mean PRIOR=${baseMeanPrior.toFixed(3)} gap=${(baseMeanPrior - baseMeanAt).toFixed(3)}`);
console.log(`give-up gap (prior-at) = ${(meanPrior - meanAt).toFixed(3)} vs baseline gap = ${(baseMeanPrior - baseMeanAt).toFixed(3)} -- ratio ${((meanPrior - meanAt) / (baseMeanPrior - baseMeanAt)).toFixed(2)}x`);
