// Hermetic unit test for scripts/lib/rotating-log.mjs (the daemon-supervisor's output-log bound).
// NO daemon, NO build — pure fs against a throwaway temp dir. Run: node scripts/test-rotating-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotatingLog } from "./lib/rotating-log.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-rotlog-"));
const basePath = path.join(dir, "sub", "output.log"); // nested — exercises the mkdir-recursive path
const maxBytes = 50;
const maxFiles = 3;
const log = createRotatingLog({ basePath, maxBytes, maxFiles });

// A single append under the cap just appends — no rotation, no siblings created yet.
log.append("hello\n");
check("small append lands in the base file", fs.readFileSync(basePath, "utf8") === "hello\n");
check("no rotation slot created yet", !fs.existsSync(`${basePath}.1`));

// Push it over maxBytes repeatedly and confirm rotation kicks in and bounds total disk usage.
for (let i = 0; i < 40; i++) log.append(`line-${i}-xxxxxxxxxxxxxxxxxxxx\n`); // ~30 bytes each

check("rotation created .1", fs.existsSync(`${basePath}.1`));
check("rotation created .2", fs.existsSync(`${basePath}.2`));
check("rotation did not create a .3 (maxFiles=3 caps the slots)", !fs.existsSync(`${basePath}.3`));

const sizes = [basePath, `${basePath}.1`, `${basePath}.2`]
  .map((p) => (fs.existsSync(p) ? fs.statSync(p).size : 0));
const total = sizes.reduce((a, b) => a + b, 0);
check(`total size across all slots is bounded (~maxBytes*maxFiles): ${total} <= ${maxBytes * maxFiles * 1.5}`, total <= maxBytes * maxFiles * 1.5);
check("each existing slot individually respects the cap", sizes.every((s) => s <= maxBytes + 40)); // + one chunk's slack

// append() must never throw, even when its parent directory can't be created (best-effort sink) —
// put a plain FILE where the log's parent directory needs to go, so mkdirSync(recursive) fails ENOTDIR.
const blockerFile = path.join(dir, "blocker");
fs.writeFileSync(blockerFile, "not a directory");
const blockedLog = createRotatingLog({ basePath: path.join(blockerFile, "output.log"), maxBytes, maxFiles });
try {
  blockedLog.append("should be swallowed\n");
  check("append swallows a mkdir failure instead of throwing", true);
} catch {
  check("append swallows a mkdir failure instead of throwing", false);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅" : "❌"} rotating-log: ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
