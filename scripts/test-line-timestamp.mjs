// Hermetic unit test for scripts/lib/line-timestamp.mjs (the daemon-supervisor's per-line
// timestamp stamper). NO daemon, NO build, NO real clock. Run: node scripts/test-line-timestamp.mjs
import { createLineTimestamper } from "./lib/line-timestamp.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Fake, controllable clock so assertions don't race a real Date.now().
let clock = 1000;
const now = () => clock;

// A single chunk holding exactly one complete line.
{
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("[submit] hello\n");
  check("one complete line yields one timestamped line", lines.length === 1);
  check("timestamp is appended at END of line, preserving ^ anchoring", lines[0] === "[submit] hello 1000\n");
}

// One chunk containing several lines at once (the common real case — a burst of console.log
// output can land in a single 'data' event).
{
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("a\nb\nc\n");
  check("multi-line chunk splits into one stamp per line", lines.length === 3);
  check("each line gets its own trailing timestamp", lines.every((l) => l.endsWith(" 1000\n")));
  check("line content before the stamp is untouched", lines[0] === "a 1000\n" && lines[1] === "b 1000\n" && lines[2] === "c 1000\n");
}

// A line split across two chunks — the exact case a naive per-chunk stamp would get wrong.
{
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("[submit] par");
  check("an incomplete line is buffered, not emitted early", lines.length === 0);
  clock = 2000; // time can move between chunks; the line should still get ONE stamp, taken at completion
  ts.write("tial\n");
  check("the split line is reassembled into exactly one stamped line", lines.length === 1 && lines[0] === "[submit] partial 2000\n");
}

// CRLF tolerance — a stray \r before the newline must not end up between the content and the stamp.
{
  clock = 1000;
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("windows-line\r\n");
  check("a trailing \\r is stripped before the timestamp is appended", lines[0] === "windows-line 1000\n");
}

// flush() emits a final line that never got a trailing newline (e.g. the child exited mid-write).
{
  clock = 1000;
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("no newline at all");
  check("an unterminated tail is not emitted before flush", lines.length === 0);
  ts.flush();
  check("flush() emits the buffered tail with a timestamp", lines.length === 1 && lines[0] === "no newline at all 1000\n");
  ts.flush();
  check("flush() is idempotent once the buffer is empty", lines.length === 1);
}

// A blank line still gets stamped (so a lone timestamp signals "blank line here", not silence).
{
  clock = 1000;
  const lines = [];
  const ts = createLineTimestamper((l) => lines.push(l), now);
  ts.write("\n");
  check("a blank line is still stamped", lines[0] === " 1000\n");
}

console.log(`\n${failures === 0 ? "✅" : "❌"} line-timestamp: ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
