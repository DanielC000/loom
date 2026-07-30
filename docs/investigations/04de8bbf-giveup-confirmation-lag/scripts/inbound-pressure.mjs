#!/usr/bin/env node
// The axis every other measurement on this card missed: not "how many OTHER sessions are active
// nearby" (cross-session concurrency -- tested in time-radius-concurrency.mjs, retracted as evidence
// either way per the confound-check-prior-window.mjs result) but "how many messages are being pushed
// INTO the session that's about to give up" -- per-session INBOUND delivery pressure.
//
// `[submit-write] <sessionId> reason=... busyBefore=... len=... head="..."` (pty/host.ts's submit())
// fires once per actual message delivered into a session's composer, from ANY source (manager
// direction, merge-done pushes, idle/context nudges, a human turn, ...) and regardless of whether that
// delivery is the queue-mediated ("immediate"/"drain") or direct-write-bypass path -- it is the log's
// closest proxy for "inbound traffic landing on this specific session."
//
// Method: for each give-up's linked trigger (reusing the same 1:1 join as the other scripts), count
// [submit-write] events targeting THAT SAME session in a PRIOR window (-300s to -60s before the
// trigger -- the identical window confound-check-prior-window.mjs uses), then compare against the same
// measure computed for the 505-submit baseline (every submit, not just give-ups).
//
// Usage: node inbound-pressure.mjs <frozen-daemon-output.log> <events.json> <session-roles.json>
import fs from 'fs';
import readline from 'readline';

const STAMP_MIN = 1.7e12;
function extractStamp(line) {
  const idx = line.lastIndexOf(' ');
  if (idx === -1) return null;
  const tok = line.slice(idx + 1).trim();
  if (!/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  if (!Number.isFinite(n) || n < STAMP_MIN) return null;
  return n;
}
function positiveControl() {
  const s = extractStamp('[pty] listening on 127.0.0.1:60848');
  if (s !== null) { console.error('POSITIVE CONTROL FAILED: known-unstamped case classified as stamped'); return false; }
  return true;
}

const [logPath, eventsPath, rolesPath] = process.argv.slice(2);
if (!logPath || !eventsPath || !rolesPath) {
  console.error('usage: node inbound-pressure.mjs <frozen-daemon-output.log> <events.json> <session-roles.json>');
  process.exit(1);
}
if (!positiveControl()) process.exit(1);
console.error('positive control: OK');

const SUBMITWRITE_RE = /^\[submit-write\] (\S+) reason=(\S+) busyBefore=(\S+) len=(\d+)/;
const inboundEvents = [];
const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  const m = SUBMITWRITE_RE.exec(line);
  if (!m) continue;
  const stamp = extractStamp(line);
  if (stamp !== null) inboundEvents.push({ sessionId: m[1], stamp });
}
console.log('stamped [submit-write] (inbound delivery) events:', inboundEvents.length);

const roles = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
const roleOf = (sid) => { const r = roles[sid]; return r ? (r.role || 'null') : 'UNKNOWN'; };
const { giveups, submit1s } = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const sGiveups = giveups.filter(g => g.stamp !== null);
const sSubmit1 = submit1s.filter(s => s.stamp !== null);

const bySession1 = {};
for (const s of sSubmit1) (bySession1[s.sessionId] ||= []).push(s);
for (const sid of Object.keys(bySession1)) bySession1[sid].sort((a, b) => a.stamp - b.stamp);

const LINK_WINDOW_MS = 15000;
const triggers = [];
for (const g of sGiveups) {
  const subs = bySession1[g.sessionId] || [];
  let best = null;
  for (const s of subs) { if (s.stamp > g.stamp) break; if (g.stamp - s.stamp <= LINK_WINDOW_MS) best = s; }
  if (best) triggers.push({ sessionId: g.sessionId, stamp: best.stamp, role: roleOf(g.sessionId) });
}
console.log('linked triggers:', triggers.length, '/', sGiveups.length);

const inboundBySession = {};
for (const e of inboundEvents) (inboundBySession[e.sessionId] ||= []).push(e.stamp);
for (const sid of Object.keys(inboundBySession)) inboundBySession[sid].sort((a, b) => a - b);
function lowerBound(arr, target) { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; } return lo; }
function inboundCountInRange(sessionId, loMs, hiMs) {
  const arr = inboundBySession[sessionId] || [];
  return lowerBound(arr, hiMs + 1) - lowerBound(arr, loMs);
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const rows = triggers.map(t => ({ role: t.role, priorInbound: inboundCountInRange(t.sessionId, t.stamp - 300000, t.stamp - 60000) }));
console.log('\n=== GIVE-UP triggers: own-session inbound deliveries, prior window (-300s..-60s) ===');
console.log('mean prior inbound (give-ups):', mean(rows.map(r => r.priorInbound)).toFixed(3), 'n=', rows.length);
for (const role of ['manager', 'worker']) {
  const arr = rows.filter(r => r.role === role).map(r => r.priorInbound);
  if (arr.length) console.log(`  role=${role}: n=${arr.length} mean=${mean(arr).toFixed(3)}`);
}

const baseRows = sSubmit1.map(s => ({ role: roleOf(s.sessionId), priorInbound: inboundCountInRange(s.sessionId, s.stamp - 300000, s.stamp - 60000) }));
console.log(`\n=== BASELINE (all ${baseRows.length} submits): own-session inbound deliveries, same window ===`);
console.log('mean prior inbound (baseline):', mean(baseRows.map(r => r.priorInbound)).toFixed(3));
for (const role of ['manager', 'worker']) {
  const arr = baseRows.filter(r => r.role === role).map(r => r.priorInbound);
  if (arr.length) console.log(`  role=${role}: n=${arr.length} mean=${mean(arr).toFixed(3)}`);
}
console.log('\nRATIO (give-up mean / baseline mean):', (mean(rows.map(r => r.priorInbound)) / mean(baseRows.map(r => r.priorInbound))).toFixed(3));

const triggerSet = new Set(triggers.map(t => `${t.sessionId}@${t.stamp}`));
const allRows = sSubmit1.map(s => ({ isGiveUp: triggerSet.has(`${s.sessionId}@${s.stamp}`), inbound: inboundCountInRange(s.sessionId, s.stamp - 300000, s.stamp - 60000) }));
const bucket = c => c >= 3 ? '3+' : String(c);
const bins = {};
for (const r of allRows) { const b = bucket(r.inbound); (bins[b] ||= { submits: 0, giveups: 0 }).submits++; if (r.isGiveUp) bins[b].giveups++; }
console.log('\n=== per-submit give-up rate by PRIOR inbound-pressure bucket ===');
for (const b of ['0', '1', '2', '3+']) { if (!bins[b]) continue; console.log(`  inbound=${b}: submits=${bins[b].submits} giveups=${bins[b].giveups} rate=${(100 * bins[b].giveups / bins[b].submits).toFixed(2)}%`); }

const low = allRows.filter(r => r.inbound < 2), high = allRows.filter(r => r.inbound >= 2);
const lowGU = low.filter(r => r.isGiveUp).length, highGU = high.filter(r => r.isGiveUp).length;
const totalSub = low.length + high.length, totalGU = lowGU + highGU, p = totalGU / totalSub;
const expLow = low.length * p, expHigh = high.length * p, expLowOK = low.length * (1 - p), expHighOK = high.length * (1 - p);
const chi = ((lowGU - expLow) ** 2) / expLow + ((low.length - lowGU - expLowOK) ** 2) / expLowOK
  + ((highGU - expHigh) ** 2) / expHigh + ((high.length - highGU - expHighOK) ** 2) / expHighOK;
console.log(`\nlow(0-1) rate=${(100 * lowGU / low.length).toFixed(1)}% (${lowGU}/${low.length}) vs high(2+) rate=${(100 * highGU / high.length).toFixed(1)}% (${highGU}/${high.length}) -- chi2(df=1)=${chi.toFixed(2)} (>10.83 means p<0.001)`);
