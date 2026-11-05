// Hermetic unit test for the size cap in api.questionAttachmentText (card 08a3a908; feature c7f999f4). The inbox
// text viewer reads an attachment through a BOUNDED stream: once more than `maxBytes` has arrived the read is
// cancelled and `{ tooLarge: true }` comes back, so an under-reported `sizeBytes` (or a route that sends no
// content-length) can never pull an unbounded body into memory. Before this file nothing pinned that cap, so a
// regression that dropped it passed every test.
// Run: node --experimental-strip-types packages/web/test/attachment-text-cap.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// api.ts has a runtime import written extensionless (bundler style); see companion.mjs for why the loader
// hook is registered first and the import is dynamic.
register("./_tsxLoaderHook.mjs", import.meta.url);
const { api } = await import("../src/lib/api.ts");

const MAX = 1024;
const realFetch = globalThis.fetch;
let pass = 0;
async function acheck(name, fn) {
  try { await fn(); pass++; console.log(`ok   ${name}`); } finally { globalThis.fetch = realFetch; }
}

// A Response whose body is a stream of the given chunk sizes and which carries NO content-length header, plus
// a record of how many chunks the reader actually pulled and whether it cancelled.
function streamed(chunkSizes, headers = {}) {
  const state = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunkSizes.length) { controller.close(); return; }
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkSizes[i++]).fill(0x61));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 }); // pull only on a real read(), so `pulled` counts what the code under test asked for
  return { res: new Response(body, { status: 200, headers }), state };
}

await acheck("a stream over maxBytes with NO content-length comes back tooLarge, and the read is cancelled early", async () => {
  const { res, state } = streamed([400, 400, 400, 400, 400, 400, 400, 400]); // 3200 bytes total
  assert.equal(res.headers.get("content-length"), null, "precondition: the stubbed response declares no length");
  globalThis.fetch = async () => res;
  const r = await api.questionAttachmentText("q1", "0", MAX);
  assert.deepEqual(r, { tooLarge: true });
  assert.ok(state.pulled < 8, `the reader must stop pulling once the cap is crossed (pulled ${state.pulled} of 8 chunks)`);
  assert.equal(state.cancelled, true, "the stream is cancelled, not drained");
});

await acheck("a declared content-length over maxBytes is refused WITHOUT reading the body", async () => {
  const { res, state } = streamed([10], { "content-length": String(MAX + 1) });
  globalThis.fetch = async () => res;
  assert.deepEqual(await api.questionAttachmentText("q1", "0", MAX), { tooLarge: true });
  assert.equal(state.pulled, 0, "no chunk was pulled");
});

await acheck("positive control: a stream at exactly maxBytes is returned as text, in full", async () => {
  const { res } = streamed([MAX / 2, MAX / 2]);
  globalThis.fetch = async () => res;
  const r = await api.questionAttachmentText("q1", "0", MAX);
  assert.ok("text" in r, "at the cap is NOT too large (the bound is strictly greater-than)");
  assert.equal(r.text.length, MAX);
});

await acheck("positive control: one byte over maxBytes IS too large", async () => {
  const { res } = streamed([MAX, 1]);
  globalThis.fetch = async () => res;
  assert.deepEqual(await api.questionAttachmentText("q1", "0", MAX), { tooLarge: true });
});

console.log(`\n${pass} passed`);
