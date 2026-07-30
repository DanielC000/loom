#!/usr/bin/env node
// Cluster raw give-up EVENTS into real INCIDENTS, and consistently decluster the submit DENOMINATOR
// too (a re-mint's redelivery goes back through drainPending -> submit(), which re-logs a fresh
// "Enter attempt 1/4 written" line -- confirmed both in code, requeueGiveUpOrigin() in pty/host.ts, and
// empirically here: every give-up links to its OWN distinct triggering submit1 with zero collisions).
//
// Why this matters: raw give-up EVENTS are not independent draws. A single stall cascades through
// GIVE_UP_REQUEUE_LIMIT+1 give-up/requeue/re-fire rounds ~20-30s apart before resolving or exhausting.
// Counting each round as an independent "risk" inflates the rate for whichever role happens to have
// longer individual cascades -- and inflates BOTH numerator (raw event count) and denominator (raw
// submit count) the same way unless both are declustered together.
//
// CLUSTER_GAP_MS=900_000 (15min) is a justified cut, not arbitrary: in this corpus, intra-incident gaps
// are <=424s and inter-incident gaps are >=4236s (70min) -- a ~10x natural break.
//
// Usage: node decluster-incidents.mjs <events.json> <session-roles.json>
import fs from 'fs';

const CLUSTER_GAP_MS = 900_000;
const LINK_WINDOW_MS = 15_000; // give-up fires ~3.6s after its trigger (4 attempts x 900ms) by construction

const [eventsPath, rolesPath] = process.argv.slice(2);
if (!eventsPath || !rolesPath) { console.error('usage: node decluster-incidents.mjs <events.json> <session-roles.json>'); process.exit(1); }

const { giveups, submit1s } = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const roles = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
const roleOf = (sid) => { const r = roles[sid]; return r ? (r.role || 'null') : 'UNKNOWN(not-in-db)'; };

const sGiveups = giveups.filter(g => g.stamp !== null);
const sSubmit1 = submit1s.filter(s => s.stamp !== null).map(s => ({ ...s, role: roleOf(s.sessionId) }));

const bySession = {};
for (const s of sSubmit1) (bySession[s.sessionId] ||= []).push(s);
for (const sid of Object.keys(bySession)) bySession[sid].sort((a, b) => a.stamp - b.stamp);

// Link each give-up to its triggering submit1: nearest preceding submit1, same session, within LINK_WINDOW_MS.
const linkedSubmitFor = new Map();
sGiveups.forEach((g, gi) => {
  const subs = bySession[g.sessionId] || [];
  let best = null;
  for (const s of subs) { if (s.stamp > g.stamp) break; if (g.stamp - s.stamp <= LINK_WINDOW_MS) best = s; }
  if (best) linkedSubmitFor.set(gi, best);
});
const linkedCount = linkedSubmitFor.size;
console.log(`give-ups linked to a triggering submit1: ${linkedCount}/${sGiveups.length}`);
// sanity: a submit1 claimed by >1 give-up would mean two cascade rounds shared one write -- shouldn't
// happen (each round re-logs its own line); verify it doesn't, so the join is a real 1:1.
const claimCounts = new Map();
for (const s of linkedSubmitFor.values()) claimCounts.set(s, (claimCounts.get(s) || 0) + 1);
const collisions = [...claimCounts.values()].filter(c => c > 1).length;
console.log(`collisions (a submit1 claimed by >1 give-up): ${collisions} -- ${collisions === 0 ? 'clean 1:1 join' : 'INVESTIGATE, join is not clean'}`);

// Cluster give-ups per session into incidents; within each incident, the FIRST give-up's linked submit is
// the "trial", any later ones are cascade "retries" to exclude from a consistently-declustered denominator.
const byGiveupSession = {};
sGiveups.forEach((g, gi) => (byGiveupSession[g.sessionId] ||= []).push({ ...g, gi }));
for (const sid of Object.keys(byGiveupSession)) byGiveupSession[sid].sort((a, b) => a.stamp - b.stamp);

let totalIncidents = 0;
const incidentByRole = {};
const retrySubmitObjs = new Set();
const incidentSizes = [];

for (const [sid, evs] of Object.entries(byGiveupSession)) {
  let cur = [evs[0]];
  const flush = (arr) => {
    totalIncidents++;
    incidentSizes.push({ sid, role: roleOf(sid), size: arr.length });
    const role = roleOf(sid);
    incidentByRole[role] = (incidentByRole[role] || 0) + 1;
    arr.forEach((ev, idx) => {
      const sub = linkedSubmitFor.get(ev.gi);
      if (sub && idx > 0) retrySubmitObjs.add(sub);
    });
  };
  for (let i = 1; i < evs.length; i++) {
    if (evs[i].stamp - evs[i - 1].stamp <= CLUSTER_GAP_MS) cur.push(evs[i]);
    else { flush(cur); cur = [evs[i]]; }
  }
  flush(cur);
}
console.log(`\ntotal incidents (declustered): ${totalIncidents}, by role:`, incidentByRole);
console.log('incident sizes (raw events per incident), sorted desc:');
for (const s of incidentSizes.sort((a, b) => b.size - a.size).slice(0, 10)) console.log(`  ${s.sid} role=${s.role} size=${s.size}`);

// Rate comparison: undeclustered (raw/raw) vs consistently-declustered (incidents/(submits-retries))
const rawSubmitsByRole = {}, rawGiveupsByRole = {};
for (const s of sSubmit1) rawSubmitsByRole[s.role] = (rawSubmitsByRole[s.role] || 0) + 1;
for (const g of sGiveups) { const r = roleOf(g.sessionId); rawGiveupsByRole[r] = (rawGiveupsByRole[r] || 0) + 1; }

const declusteredSubmitsByRole = {};
for (const s of sSubmit1) {
  if (retrySubmitObjs.has(s)) continue;
  declusteredSubmitsByRole[s.role] = (declusteredSubmitsByRole[s.role] || 0) + 1;
}

console.log('\n=== rate comparison: undeclustered vs consistently-declustered, by role ===');
for (const role of ['manager', 'worker']) {
  const rawSub = rawSubmitsByRole[role] || 0, rawGU = rawGiveupsByRole[role] || 0;
  const declSub = declusteredSubmitsByRole[role] || 0, declGU = incidentByRole[role] || 0;
  console.log(`role=${role}:`);
  console.log(`  UNDECLUSTERED (raw events / raw submits): ${rawGU}/${rawSub} = ${(100 * rawGU / rawSub).toFixed(2)}%`);
  console.log(`  DECLUSTERED   (incidents / trial-submits): ${declGU}/${declSub} = ${(100 * declGU / declSub).toFixed(2)}%`);
}
