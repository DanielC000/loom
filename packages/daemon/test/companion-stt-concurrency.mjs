import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — bounded global STT concurrency (card 986bdddd). Fully hermetic: exercises the real
// acquire/release semaphore `stt.ts` exports (the exact mechanism `createFasterWhisperTranscriber().
// transcribe()` calls), with NO real python/venv/subprocess and NO fixed real-time waits — contention is
// resolved by explicit `releaseSttSlot()` calls, and the one timeout case uses a tiny test-overridden bound.
// Run: 1) build (turbo builds shared first), 2) node test/companion-stt-concurrency.mjs
import {
  acquireSttSlot,
  releaseSttSlot,
  __setSttConcurrencyForTest,
  __resetSttConcurrencyGateForTest,
  createFasterWhisperTranscriber,
  __setSttPythonBinForTest,
  __setTranscribeRunnerForTest,
} from "../dist/companion/stt.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function flushMicrotasks(n = 5) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

try {
  // ============ 1 — cap=1: a second acquire while the first holds the slot does NOT resolve until release ============
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 60_000 });

    const a1 = await acquireSttSlot();
    check("1: first acquire succeeds immediately (slot free)", a1 === true);

    let a2Resolved = false;
    const p2 = acquireSttSlot().then((ok) => { a2Resolved = true; return ok; });
    await flushMicrotasks();
    check("1: second acquire is STILL PENDING while the first holds the slot", a2Resolved === false);

    releaseSttSlot();
    const a2 = await p2;
    check("1: second acquire resolves true once the slot is released", a2 === true && a2Resolved === true);
    releaseSttSlot();
  }

  // ============ 2 — bounded acquire: a wait that outlives the bound resolves false, never hangs ============
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 20 });

    const a1 = await acquireSttSlot();
    check("2: first acquire succeeds (slot free)", a1 === true);
    // Deliberately never release a1 before awaiting a2 — proves the BOUND, not a real release, is what
    // lets a2 resolve.
    const a2 = await acquireSttSlot();
    check("2: a second acquire that outlives the bound resolves FALSE (degrades cleanly, never hangs)", a2 === false);

    // State integrity after a timed-out acquire: releasing the ORIGINAL holder must free exactly one slot
    // (a timed-out waiter must not have corrupted the active count by secretly holding one anyway).
    releaseSttSlot();
    const a3 = await acquireSttSlot();
    check("2: after releasing the original holder, a fresh acquire succeeds immediately (no count leak)", a3 === true);
    releaseSttSlot();
  }

  // ============ 3 — FIFO wake order: queued acquirers are woken in the order they queued ============
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 60_000 });

    const a1 = await acquireSttSlot();
    check("3: first acquire succeeds (slot free)", a1 === true);

    const order = [];
    const p2 = acquireSttSlot().then((ok) => { order.push("second"); return ok; });
    await flushMicrotasks();
    const p3 = acquireSttSlot().then((ok) => { order.push("third"); return ok; });
    await flushMicrotasks();

    releaseSttSlot(); // wakes "second"
    await p2;
    check("3: the longest-waiting acquirer (second) is woken first", order[0] === "second");
    releaseSttSlot(); // wakes "third"
    await p3;
    check("3: the next-longest-waiting acquirer (third) is woken next", order[1] === "third");
    releaseSttSlot();
  }

  // ============ 4 — through the REAL transcribe() surface: two concurrent calls serialize on the global slot ============
  // (card 986bdddd round 2, Minor 3: cases 1-3 above only drive acquireSttSlot/releaseSttSlot directly, so
  // deleting the acquire/finally pairing INSIDE createFasterWhisperTranscriber().transcribe() itself would
  // have stayed green. This drives the real public surface with a stubbed decode runner instead.)
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 60_000 });
    __setSttPythonBinForTest("fake-python-bin");

    const order = [];
    let resolveFirst;
    const firstHeld = new Promise((r) => { resolveFirst = r; });
    __setTranscribeRunnerForTest(async (bin, filePath) => {
      if (filePath === "first.ogg") {
        order.push("first-start");
        await firstHeld;
        order.push("first-end");
        return "first transcript";
      }
      order.push("second-start");
      return "second transcript";
    });

    const transcriber = createFasterWhisperTranscriber();
    const p1 = transcriber.transcribe({ filePath: "first.ogg", langHint: null });
    await flushMicrotasks();
    const p2 = transcriber.transcribe({ filePath: "second.ogg", langHint: null });
    await flushMicrotasks();
    check("4: the second call's runner has NOT started while the first holds the slot", order.length === 1 && order[0] === "first-start");
    resolveFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    check("4: both calls resolved their own transcripts", r1 === "first transcript" && r2 === "second transcript");
    check("4: the second runner only started AFTER the first released the slot", order.indexOf("second-start") > order.indexOf("first-end"));
  }

  // ============ 5 — a THROWING runner still releases the slot (the next transcribe() is not stuck) ============
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 60_000 });
    __setSttPythonBinForTest("fake-python-bin");
    __setTranscribeRunnerForTest(async () => { throw new Error("boom — simulated decode crash"); });

    const transcriber = createFasterWhisperTranscriber();
    let threw = false;
    try {
      await transcriber.transcribe({ filePath: "x.ogg", langHint: null });
    } catch {
      threw = true;
    }
    check("5: a throwing runner's rejection propagates out of transcribe()", threw === true);

    __setTranscribeRunnerForTest(async () => "after-crash transcript");
    const r2 = await transcriber.transcribe({ filePath: "y.ogg", langHint: null });
    check("5: the slot was released despite the throw — the next transcribe() is NOT stuck", r2 === "after-crash transcript");
  }

  // ============ 6 — a TIMED-OUT run (resolves null, mirrors the real subprocess-timeout contract) still releases the slot ============
  {
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: 60_000 });
    __setSttPythonBinForTest("fake-python-bin");
    __setTranscribeRunnerForTest(async () => null); // mirrors runTranscribeScript's own timeout-degrades-to-null contract

    const transcriber = createFasterWhisperTranscriber();
    const r1 = await transcriber.transcribe({ filePath: "x.ogg", langHint: null });
    check("6: a timed-out run resolves null (degrades like a real STT failure)", r1 === null);

    __setTranscribeRunnerForTest(async () => "after-timeout transcript");
    const r2 = await transcriber.transcribe({ filePath: "y.ogg", langHint: null });
    check("6: the slot was released despite the null/timeout — the next transcribe() is NOT stuck", r2 === "after-timeout transcript");
  }

  __setTranscribeRunnerForTest();
  __setSttPythonBinForTest(undefined);

  // Leave the gate at its real defaults for any OTHER test file sharing this process (none today — each
  // test runs as its own `node` invocation — but this keeps the module in a clean, default state).
  __resetSttConcurrencyGateForTest();
  __setSttConcurrencyForTest();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("UNCAUGHT:", err);
  process.exit(1);
}
