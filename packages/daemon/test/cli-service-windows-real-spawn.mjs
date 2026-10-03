import "./_guard.mjs"; // suite consistency (sets LOOM_TEST=1)
// Real-spawn smoke for bin/service.mjs's Windows Task Scheduler Exec action (card db3b731f follow-up,
// manager-requested). cli-service.mjs's own tests only assert on the GENERATED XML TEXT — they never
// prove the Command+Arguments pair windowsTaskXml() builds actually EXECUTES correctly under real
// Windows argv parsing. A quoting slip there (a stray missing/misplaced quote around a `set`
// assignment) would make an end user's autostarted daemon silently never start, and no amount of
// text-matching on the XML would catch it — mocking the exec path never exercises the actual
// cross-platform spawn.
//
// This test parses the Command/Arguments PAIR straight out of a REAL windowsTaskXml() output (the exact
// text Task Scheduler itself would decode and run), then spawns Command with Arguments as ONE single
// `windowsVerbatimArguments: true` array entry — the standard Node recipe for "hand this raw string to
// CreateProcess verbatim", which is exactly how Task Scheduler itself invokes an Exec action's own
// Command+Arguments pair. It NEVER calls schtasks and NEVER registers a real task — only cmd.exe (a
// stock Windows component) and a throwaway fixture script get spawned.
//
// win32-only: Command is an absolute System32 path and the whole point is Windows cmd.exe/Task
// Scheduler quoting semantics — skipped elsewhere with a printed reason.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log(`SKIP  cli-service-windows-real-spawn.mjs — win32-only (Task Scheduler Exec-action quoting via cmd.exe); this host is '${process.platform}'.`);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_BIN = path.join(__dirname, "..", "..", "..", "bin"); // packages/daemon/test → repo root/bin
const svc = await import(pathToFileURL(path.join(REPO_BIN, "service.mjs")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Reverse of service.mjs's own (unexported) xmlEscape — decodes the entities Command/Arguments are
// wrapped in back to the literal text cmd.exe/CreateProcess actually receive. &amp; decoded LAST so a
// just-decoded "&" can never be mistaken for the start of another entity.
function xmlUnescape(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function extractExec(xml) {
  const cmd = xml.match(/<Command>([\s\S]*?)<\/Command>/);
  const args = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  if (!cmd || !args) throw new Error("windowsTaskXml output missing <Command>/<Arguments> — generator contract changed?");
  return { command: xmlUnescape(cmd[1]), argsStr: xmlUnescape(args[1]) };
}

// --- fixture setup: a temp root WHOSE PATH CONTAINS A SPACE, housing loomBin + a LOOM_HOME value that
// ALSO carries a `&` and a `%` — the three characters a quoting slip would most plausibly mishandle.
const root = mkdtempManaged("loom-svc-winspawn-");
const spaceDir = path.join(root, "svc smoke test");
fs.mkdirSync(spaceDir, { recursive: true });
const loomHomeDir = path.join(spaceDir, "lo&om %home");
fs.mkdirSync(loomHomeDir, { recursive: true });
const loomBinPath = path.join(spaceDir, "fixture.mjs");
const outFile = path.join(spaceDir, "out.json");

// The fixture: writes {argv, LOOM_HOME, LOOM_PORT} to a file named by LOOM_SVC_SMOKE_OUT (an env var
// THIS TEST injects on the outer spawnSync call, entirely separate from the LOOM_HOME/LOOM_PORT `set`
// statements windowsTaskXml() itself bakes into the Arguments string) and exits 0.
fs.writeFileSync(loomBinPath, [
  'import fs from "node:fs";',
  "fs.writeFileSync(process.env.LOOM_SVC_SMOKE_OUT, JSON.stringify({",
  "  argv: process.argv.slice(2),",
  "  LOOM_HOME: process.env.LOOM_HOME ?? null,",
  "  LOOM_PORT: process.env.LOOM_PORT ?? null,",
  "}));",
].join("\n"));

const PORT = 48213;
// `node` is the REAL system node (process.execPath) so the child genuinely executes — unlike loomBin and
// LOOM_HOME (fully test-owned, and exactly what this test is proving the quoting for), we don't relocate
// the system node binary into the space-containing temp dir; on a standard Windows install it already
// lives under "C:\Program Files\nodejs\node.exe" (itself space-containing), and cli-service.mjs's own
// generator-level tests already cover a spaced NODE path textually (WIN_NODE fixture) — this test's job
// is proving the REAL EXECUTION path for the values that are fully under this test's own control.
const xml = svc.windowsTaskXml({
  node: process.execPath,
  loomBin: loomBinPath,
  port: PORT,
  workingDir: spaceDir,
  userId: "TESTDOMAIN\\testuser",
  loomHome: loomHomeDir,
});
const { command, argsStr } = extractExec(xml);

check("extracted Command is an absolute cmd.exe path", /cmd\.exe$/i.test(command) && path.isAbsolute(command));
check("extracted Arguments carries both the LOOM_PORT and LOOM_HOME `set` statements",
  argsStr.includes("LOOM_PORT=") && argsStr.includes(`LOOM_HOME=${loomHomeDir}`));

const result = spawnSync(command, [argsStr], {
  windowsVerbatimArguments: true, // reproduces Task Scheduler handing Arguments to CreateProcess verbatim
  cwd: spaceDir, // mirrors the generated <WorkingDirectory>
  env: { ...process.env, LOOM_SVC_SMOKE_OUT: outFile },
  encoding: "utf8",
  timeout: 30_000,
});

check("real spawn exits 0 (no stray quote/escape broke the command line)", !result.error && result.status === 0);
if (result.error || result.status !== 0) {
  console.log(`  argsStr: ${argsStr}`);
  console.log(`  status=${result.status} error=${result.error?.message ?? "(none)"}`);
  console.log(`  stdout: ${result.stdout}`);
  console.log(`  stderr: ${result.stderr}`);
}

let payload = null;
if (fs.existsSync(outFile)) {
  try { payload = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { /* reported as a failed check below */ }
}
check("fixture ran and wrote a parseable output file", payload !== null);

if (payload) {
  check("fixture's argv is exactly `start --no-open --port <port>`",
    JSON.stringify(payload.argv) === JSON.stringify(svc.startArgv(PORT)));
  check("fixture saw LOOM_HOME exactly as given (space + & + % intact, no stray quotes)",
    payload.LOOM_HOME === loomHomeDir);
  check("fixture saw LOOM_PORT exactly as given", payload.LOOM_PORT === String(PORT));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — windowsTaskXml()'s generated Command+Arguments pair, spawned exactly the way Task\n   Scheduler invokes an Exec action (windowsVerbatimArguments:true), really executes and really\n   carries LOOM_HOME/LOOM_PORT through — including a LOOM_HOME containing a space, `&`, and `%`."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
