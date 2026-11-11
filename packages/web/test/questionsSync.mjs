// Hermetic unit test for src/lib/questionsSync.ts (card 55de3b68): the client half of the contentless
// `{t:"questions"}` /ws/fleet signal. No socket, no DOM; a REAL react-query QueryClient + QueryObserver so the
// in-flight/dirty branch runs against the library's own state machine. Also source-scans the shipped
// provider + readers for the three properties a unit test of the pure helpers cannot see (the frame is
// handled, the disconnected fallback re-reads the inbox, and no inbox reader still polls).
//   node --experimental-strip-types packages/web/test/questionsSync.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  cancelPendingQuestionsSignal, hasFailedQuestionQuery, invalidateQuestionQueries, isQuestionsQuery, resyncQuestions, signalQuestionsChanged,
} from "../src/lib/questionsSync.ts";

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`ok   ${name}`); };
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond, what) => { for (let i = 0; i < 500; i++) { if (cond()) return; await tick(); } throw new Error(`timed out waiting for: ${what}`); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
/** Mount an ACTIVE observer (what useQuery does) over a scripted fetcher. */
function mount(qc, queryKey, queryFn) {
  const obs = new QueryObserver(qc, { queryKey, queryFn });
  const unsub = obs.subscribe(() => {});
  return { obs, unsub };
}

await check("isQuestionsQuery: the list and its history variant — not the (never-polled) single-row detail, nothing else", () => {
  for (const k of [["openQuestions"], ["openQuestions", "history"]]) assert.equal(isQuestionsQuery({ queryKey: k }), true, JSON.stringify(k));
  for (const k of [["question", "q1"], ["allSessions"], ["orchEvents", "m1"], ["questions"], ["orchStatus"]]) assert.equal(isQuestionsQuery({ queryKey: k }), false, JSON.stringify(k));
});

await check("an idle signal re-reads every mounted inbox LIST query (list, history) and leaves other queries (incl. the single-row detail) alone", async () => {
  const qc = newClient();
  const calls = { list: 0, hist: 0, row: 0, other: 0 };
  const ms = [
    mount(qc, ["openQuestions"], async () => ++calls.list),
    mount(qc, ["openQuestions", "history"], async () => ++calls.hist),
    mount(qc, ["question", "q1"], async () => ++calls.row), // the detail query: never polled, so never signalled
    mount(qc, ["allSessions"], async () => ++calls.other),
  ];
  await until(() => calls.list === 1 && calls.hist === 1 && calls.row === 1 && calls.other === 1, "initial reads");
  signalQuestionsChanged(qc);
  await until(() => calls.list === 2 && calls.hist === 2, "signal re-reads");
  await tick();
  assert.deepEqual(calls, { list: 2, hist: 2, row: 1, other: 1 }, "exactly one extra read per list query; the detail and unrelated queries are untouched");
  ms.forEach((m) => m.unsub());
});

await check("a signal DURING an in-flight read does not abort it, and triggers exactly ONE re-read after it settles (bursts collapse)", async () => {
  const qc = newClient();
  let calls = 0;
  const gates = [deferred(), deferred()];
  let aborted = 0;
  const m = mount(qc, ["openQuestions"], async ({ signal }) => {
    const mine = calls++;
    signal.addEventListener("abort", () => { aborted++; });
    return gates[mine]?.promise ?? "late";
  });
  await until(() => calls === 1, "first read started");
  for (let i = 0; i < 5; i++) signalQuestionsChanged(qc); // a burst while the first read is still in flight
  await tick();
  assert.equal(calls, 1, "no second read starts while the first is in flight");
  gates[0].resolve("STALE"); // the response that may predate the change
  await until(() => calls === 2, "the dirty re-read starts after the first settles");
  gates[1].resolve("FRESH");
  await until(() => m.obs.getCurrentResult().data === "FRESH", "fresh data lands");
  await tick();
  assert.equal(calls, 2, "five signals → exactly one re-read, not five");
  assert.equal(aborted, 0, "the in-flight read was never aborted client-side");
  m.unsub();
});

await check("the pre-change response is NOT the last word: data ends up the post-change read", async () => {
  const qc = newClient();
  let server = "before";
  const gate = deferred();
  let n = 0;
  const m = mount(qc, ["openQuestions"], async () => { if (n++ === 0) { const snap = server; await gate.promise; return snap; } return server; });
  await until(() => n === 1, "first read in flight (snapshotted 'before')");
  server = "after";
  signalQuestionsChanged(qc);
  gate.resolve();
  await until(() => m.obs.getCurrentResult().data === "after", "converges to the post-change state");
  m.unsub();
});

await check("cancelPendingQuestionsSignal drops a queued re-read (a closed socket's reconnect re-reads anyway)", async () => {
  const qc = newClient();
  let calls = 0;
  const gate = deferred();
  const m = mount(qc, ["openQuestions"], async () => { calls++; if (calls === 1) await gate.promise; return calls; });
  await until(() => calls === 1, "in flight");
  signalQuestionsChanged(qc);
  cancelPendingQuestionsSignal(qc);
  gate.resolve();
  await until(() => m.obs.getCurrentResult().data === 1, "first read settled");
  await tick(); await tick();
  assert.equal(calls, 1, "the cancelled signal produced no re-read");
  m.unsub();
});

await check("resync: re-reads once; a FAILED active read is retried on the ladder, a clean one resets it", async () => {
  const qc = newClient();
  let fail = true, calls = 0;
  const m = mount(qc, ["openQuestions"], async () => { calls++; if (fail && calls > 1) throw new Error("outage"); return calls; });
  await until(() => m.obs.getCurrentResult().data === 1, "initial read settled");
  const scheduled = []; let resets = 0;
  const retry = { schedule: (fn) => scheduled.push(fn), reset: () => { resets++; }, stopped: () => false };
  let again = 0;
  resyncQuestions(qc, { retry, isCurrent: () => true, again: () => { again++; } });
  await until(() => scheduled.length === 1, "failure schedules a retry");
  assert.equal(hasFailedQuestionQuery(qc), true);
  assert.equal(resets, 0);
  fail = false;
  qc.invalidateQueries({ queryKey: ["openQuestions"] });
  await until(() => !hasFailedQuestionQuery(qc), "recovered");
  resyncQuestions(qc, { retry, isCurrent: () => true, again: () => {} });
  await until(() => resets === 1, "success resets the ladder");
  assert.equal(scheduled.length, 1, "no further retry once clean");
  m.unsub();
});

await check("resync while a read is in flight ⇒ final data is fresh (the read that predates socket registration is superseded, not joined)", async () => {
  const qc = newClient();
  let server = "before";
  const gate = deferred();
  let reads = 0;
  const m = mount(qc, ["openQuestions"], async () => { if (reads++ === 0) { const snap = server; await gate.promise; return snap; } return server; });
  await until(() => reads === 1, "mount read in flight");
  server = "after"; // committed in the gap before the socket registered: no frame will ever announce it
  const retry = { schedule: () => {}, reset: () => {}, stopped: () => false };
  resyncQuestions(qc, { retry, isCurrent: () => true, again: () => {} });
  await tick();
  assert.equal(reads, 1, "resync does not abort the in-flight read");
  gate.resolve("x"); // releases the pre-registration read, which snapshotted "before"
  await until(() => reads === 2, "resync re-reads once the in-flight read settles instead of trusting it");
  await until(() => m.obs.getCurrentResult().data === "after", "fresh data lands");
  assert.equal(reads, 2);
  m.unsub();
});

await check("resync: a superseded attempt (isCurrent false) neither retries nor resets; a stopped ladder is not re-armed", async () => {
  const qc = newClient();
  let calls = 0;
  const m = mount(qc, ["openQuestions"], async () => { if (++calls > 1) throw new Error("x"); return 1; });
  await until(() => m.obs.getCurrentResult().data === 1, "initial read settled");
  const sched = []; let resets = 0;
  resyncQuestions(qc, { retry: { schedule: (f) => sched.push(f), reset: () => { resets++; }, stopped: () => false }, isCurrent: () => false, again: () => {} });
  await until(() => calls === 2, "the superseded attempt still read");
  await tick(); await tick();
  assert.equal(sched.length + resets, 0, "superseded → inert");
  resyncQuestions(qc, { retry: { schedule: (f) => sched.push(f), reset: () => { resets++; }, stopped: () => true }, isCurrent: () => true, again: () => {} });
  await until(() => calls === 3, "stopped-ladder attempt read");
  await tick(); await tick();
  assert.equal(sched.length, 0, "a stopped ladder is never re-armed");
  m.unsub();
});

await check("invalidateQuestionQueries marks UNMOUNTED inbox queries stale for their next mount (no fetch for an idle cache)", async () => {
  const qc = newClient();
  qc.setQueryData(["openQuestions"], [1]);
  await invalidateQuestionQueries(qc);
  assert.equal(qc.getQueryState(["openQuestions"]).isInvalidated, true);
});

// ---- source scans over the shipped files -------------------------------------------------------------
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const provider = read("components/FleetSocketProvider.tsx");

await check("provider: handles the `questions` frame by signalling, and the disconnected fallback timer re-reads the inbox", () => {
  assert.match(provider, /msg\.t === "questions"\)\s*\{\s*signalQuestionsChanged\(qc\)/);
  const timerBody = /fallbackPollTimer = setInterval\(\(\) => \{([\s\S]*?)\}, FALLBACK_POLL_MS\)/.exec(provider)?.[1] ?? "";
  assert.match(timerBody, /invalidateQuestionQueries\(qc\)/, "fallback poll re-reads the inbox while disconnected");
  assert.match(provider, /resyncQuestionsOnOpen\(\);/, "every (re)open re-reads the inbox once");
});

await check("no inbox reader still carries a refetchInterval (positive control: the scanner flags a planted one)", () => {
  const offenders = (text) => text.split("\n").filter((l) => /queryKey:\s*\["openQuestions"/.test(l) && /refetchInterval/.test(l));
  assert.equal(offenders('const q = useQuery({ queryKey: ["openQuestions"], queryFn: f, refetchInterval: 3000 });').length, 1, "control: the scanner detects a polling reader");
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) for (const l of offenders(fs.readFileSync(p, "utf8"))) bad.push(`${path.relative(SRC, p)}: ${l.trim()}`);
    }
  })(SRC);
  assert.deepEqual(bad, []);
  const readers = ["lib/attention.ts", "pages/Board.tsx", "pages/WorkspaceHome.tsx", "components/requests.tsx"].reduce((n, f) => n + (read(f).match(/queryKey:\s*\["openQuestions"/g) ?? []).length, 0);
  assert.ok(readers >= 7, `control: the scan really covers the 7 known readers (saw ${readers})`);
});

console.log(`\n${pass} passed`);
