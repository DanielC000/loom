// Hermetic unit test for lib/imagePaste.ts — the decision of what an image-only terminal paste sends.
// Run: node --experimental-strip-types packages/web/test/image-paste.mjs
import assert from "node:assert/strict";
import { browserPlatform, imagePasteKey, imagePasteKeyFor } from "../src/lib/imagePaste.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const png = { kind: "file", type: "image/png" };
const plain = { kind: "string", type: "text/plain" };
const html = { kind: "string", type: "text/html" };

check("image-only clipboard on Windows → ESC v", () => {
  assert.equal(imagePasteKey([png], "", "Windows"), "\x1bv");
  assert.equal(imagePasteKey([png], "", "Win32"), "\x1bv");
});
check("image-only clipboard elsewhere → 0x16", () => {
  for (const p of ["macOS", "MacIntel", "Linux", "Linux x86_64", "", "Android"]) {
    assert.equal(imagePasteKey([png], "", p), "\x16", p);
  }
});
check("text-only clipboard → null (xterm's own paste, unchanged)", () => {
  assert.equal(imagePasteKey([plain], "hello", "Windows"), null);
});
check("mixed text+image clipboard behaves as text → null", () => {
  assert.equal(imagePasteKey([html, plain, png], "C:\\x\\shot.png", "Windows"), null);
  assert.equal(imagePasteKey([png, plain], "x", "Linux"), null);
});
check("empty clipboard and non-image files → null", () => {
  assert.equal(imagePasteKey([], "", "Windows"), null);
  assert.equal(imagePasteKey([{ kind: "file", type: "application/pdf" }], "", "Windows"), null);
  assert.equal(imagePasteKey([{ kind: "string", type: "image/png" }], "", "Windows"), null);
});
check("image MIME match is case-insensitive", () => {
  assert.equal(imagePasteKey([{ kind: "file", type: "IMAGE/JPEG" }], "", "Linux"), "\x16");
});
check("browserPlatform prefers userAgentData, falls back to navigator.platform", () => {
  assert.equal(browserPlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" }), "Windows");
  assert.equal(browserPlatform({ platform: "Win32" }), "Win32");
  assert.equal(browserPlatform({ userAgentData: { platform: "" }, platform: "Linux x86_64" }), "Linux x86_64");
  assert.equal(browserPlatform(undefined), "");
});
check("imagePasteKeyFor matches on the platform prefix only", () => {
  assert.equal(imagePasteKeyFor("Windows"), "\x1bv");
  assert.equal(imagePasteKeyFor("Darwin"), "\x16");
});

console.log(`${pass} checks passed`);
