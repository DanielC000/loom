// Card 8ef582d0 (follow-up round): two SOURCE-TEXT wiring censuses for the per-call MCP recorder.
//   (A) COVERAGE: every `new McpServer(` in packages/daemon/src/mcp/*.ts is followed, before the next
//       `new McpServer(` / EOF, by `instrumentServer(` — so a router added later (or an edit dropping the
//       line) cannot silently go unrecorded. mcp-call-record.mjs only exercises TaskMcpRouter end to end.
//   (B) SHUTDOWN: index.ts's shared `flushVaultsAndStopCodescape` cleanup — registered via
//       setShutdownCleanup so BOTH exit paths (gracefulShutdown AND daemon_restart's exit-75) run it —
//       calls stopMcpCallRecorder(), and gracefulShutdown actually runs that shared closure.
// Reads real src text (comment-stripped), so it is a member of CHANGED_TS_TEXT_SCANNER_REPO_PATHS.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Returns the routers (by index) whose `new McpServer(` has no `instrumentServer(` before the next one. */
function uninstrumented(text) {
  const t = strip(text);
  const starts = [...t.matchAll(/new McpServer\(/g)].map((m) => m.index);
  const bad = [];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : t.length;
    if (!/instrumentServer\(/.test(t.slice(s, end))) bad.push(i);
  });
  return { total: starts.length, bad };
}

// ---- (A) coverage ----
{
  const dir = path.join(SRC, "mcp");
  let routers = 0;
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const r = uninstrumented(fs.readFileSync(path.join(dir, f), "utf8"));
    routers += r.total;
    if (r.bad.length) offenders.push(f);
  }
  check(`(A) the census sees the 8 routers' \`new McpServer(\` sites (saw ${routers})`, routers === 8);
  check(`(A) every \`new McpServer(\` is followed by instrumentServer( (offenders: ${JSON.stringify(offenders)})`, offenders.length === 0);
  // negative control on the detector itself, against a real router's text with the call removed
  const real = fs.readFileSync(path.join(dir, "run.ts"), "utf8");
  check("(A) control: the real run.ts is clean", uninstrumented(real).bad.length === 0);
  const mutated = real.replace(/^.*instrumentServer\(server.*$/m, "");
  check("(A) control: deleting its instrumentServer line is detected", mutated !== real && uninstrumented(mutated).bad.length === 1);
  check("(A) control: a commented-out instrumentServer call does not count",
    uninstrumented(real.replace(/^(.*)instrumentServer\(server/m, "// instrumentServer(server")).bad.length === 1);
}

// ---- (B) shutdown wiring ----
{
  const idx = strip(fs.readFileSync(path.join(SRC, "index.ts"), "utf8"));
  const open = idx.indexOf("const flushVaultsAndStopCodescape = async");
  const reg = idx.indexOf("sessions.setShutdownCleanup(flushVaultsAndStopCodescape");
  check("(B) the shared cleanup closure and its setShutdownCleanup registration both exist", open > 0 && reg > open);
  const body = open > 0 && reg > open ? idx.slice(open, reg) : "";
  check("(B) the shared cleanup closure calls stopMcpCallRecorder() (so daemon_restart's exit-75 flushes too)", /stopMcpCallRecorder\(\)/.test(body));
  const gs = idx.indexOf("gracefulShutdown = (reason: string)");
  check("(B) gracefulShutdown awaits the same shared closure", gs > 0 && /await flushVaultsAndStopCodescape\(\)/.test(idx.slice(gs)));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
