#!/usr/bin/env node
// The card's real open question, replacing its confounded LINE-radius proxy (a give-up's own retry
// cascade fills a line window with its OWN session's lines regardless of true concurrency -- see
// decluster-incidents.mjs for why raw events cascade). This is a proper TIME-radius proxy: for every
// submit-attempt-1 event, count DISTINCT OTHER sessions with a submit within +/-radiusMs, then compare
// the mean at give-up-triggering submits against the mean at all submits (the baseline).
//
// Usage: node time-radius-concurrency.mjs <events.json> <session-roles.json>
import fs from 'fs';

const [eventsPath, rolesPath] = process.argv.slice(2);
if (!eventsPath || !rolesPath) { console.error('usage: node time-radius-concurrency.mjs <events.json> <session-roles.json>'); process.exit(1); }

const { giveups, submit1s } = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const roles = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
const roleOf = (sid) => { const r = roles[sid]; return r ? (r.role || 'null') : 'UNKNOWN(not-in-db)'; };
const LINK_WINDOW_MS = 15_000;

const sGiveups = giveups.filter(g => g.stamp !== null);
const sSubmit1 = submit1s.filter(s => s.stamp !== null).map(s => ({ ...s, role: roleOf(s.sessionId), gaveUp: false }));

const bySession = {};
for (const s of sSubmit1) (bySession[s.sessionId] ||= []).push(s);
for (const sid of Object.keys(bySession)) bySession[sid].sort((a, b) => a.stamp - b.stamp);

for (const g of sGiveups) {
  const subs = bySession[g.sessionId] || [];
  let best = null;
  for (const s of subs) { if (s.stamp > g.stamp) break; if (g.stamp - s.stamp <= LINK_WINDOW_MS) best = s; }
  if (best) best.gaveUp = true;
}

const allSubmits = [...sSubmit1].sort((a, b) => a.stamp - b.stamp);
const stampsArr = allSubmits.map(s => s.stamp);
function lowerBound(arr, target) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; } return lo; }
function concurrencyAt(centerStamp, excludeSessionId, radiusMs) {
  const lo = lowerBound(stampsArr, centerStamp - radiusMs);
  const hi = lowerBound(stampsArr, centerStamp + radiusMs + 1);
  const distinctOther = new Set();
  for (let i = lo; i < hi; i++) if (allSubmits[i].sessionId !== excludeSessionId) distinctOther.add(allSubmits[i].sessionId);
  return distinctOther.size;
}

for (const radiusMs of [30000, 60000, 120000]) {
  console.log(`\n================ radius +/-${radiusMs / 1000}s ================`);
  for (const s of allSubmits) s._conc = concurrencyAt(s.stamp, s.sessionId, radiusMs);

  const bucket = (c) => (c >= 3 ? '3+' : String(c));
  const bins = {};
  for (const s of allSubmits) {
    const b = bucket(s._conc);
    (bins[b] ||= { submits: 0, giveups: 0 }).submits++;
    if (s.gaveUp) bins[b].giveups++;
  }
  console.log('per-submit give-up rate by concurrency bucket:');
  for (const b of ['0', '1', '2', '3+']) {
    if (!bins[b]) continue;
    console.log(`  concurrency=${b}: submits=${bins[b].submits} giveups=${bins[b].giveups} rate=${(100 * bins[b].giveups / bins[b].submits).toFixed(2)}%`);
  }

  const gu = allSubmits.filter(s => s.gaveUp).map(s => s._conc);
  const ok = allSubmits.filter(s => !s.gaveUp).map(s => s._conc);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`mean concurrency: gave-up submits (n=${gu.length}) = ${mean(gu).toFixed(3)}; other submits (n=${ok.length}) = ${mean(ok).toFixed(3)}`);

  // low(0-1) vs high(2+) chi-square, one line
  const low = allSubmits.filter(s => s._conc < 2), high = allSubmits.filter(s => s._conc >= 2);
  const lowGU = low.filter(s => s.gaveUp).length, highGU = high.filter(s => s.gaveUp).length;
  const totalSub = low.length + high.length, totalGU = lowGU + highGU, p = totalGU / totalSub;
  const expLow = low.length * p, expHigh = high.length * p;
  const expLowOK = low.length * (1 - p), expHighOK = high.length * (1 - p);
  const chi = ((lowGU - expLow) ** 2) / expLow + ((low.length - lowGU - expLowOK) ** 2) / expLowOK
    + ((highGU - expHigh) ** 2) / expHigh + ((high.length - highGU - expHighOK) ** 2) / expHighOK;
  console.log(`low(0-1) rate=${(100 * lowGU / low.length).toFixed(1)}% (${lowGU}/${low.length}) vs high(2+) rate=${(100 * highGU / high.length).toFixed(1)}% (${highGU}/${high.length}) -- chi2(df=1)=${chi.toFixed(2)} (>10.83 means p<0.001)`);
}
