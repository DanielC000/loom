// Child process for settle-by-opid-no-timer-leak.mjs. Deliberately does NOT call process.exit() — the
// only thing that decides when this process actually exits is whether anything (a timer, a handle) is
// still keeping the Node event loop alive. That makes this the right instrument for a timer-leak check:
// a logical assertion on the returned value can't see an armed-but-irrelevant setTimeout; only the
// process's own natural exit time can.
import { PendingOpRegistry } from "../dist/orchestration/pending-ops.js";

const reg = new PendingOpRegistry();
const owner = { exempt: true, reason: "settle-by-opid-no-timer-leak.mjs child" };
const run = async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: true }; };
// waitMs=1 << run()'s 50ms, so the mint itself observes {settled:false} — the RUNNING-entry branch of
// awaitSettleByOpId (the one that races Promise.race([e.settle, <timer>])) is what we're checking here.
const r = await reg.attach("leak-check", "merge", "mgr1", 1, run, undefined, { classifyOutcome: () => "cancelled" }, owner);
// A big, realistic budget — the SAME order of magnitude the real converted callers pass (e.g. 240_000ms)
// — so a leaked timer's effect (the process staying alive) is unmistakable rather than lost in noise.
const settled = await reg.awaitSettleByOpId(r.op.opId, 240_000);
console.log(JSON.stringify(settled ?? null));
// No process.exit() here on purpose — see the header.
