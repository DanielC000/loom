// Card 05056168 acceptance evidence — THE POSITIVE CONTROL, AND IT IS THE WHOLE CARD: start a REAL run of
// scripts/test-daemon.mjs, SIGKILL it mid-flight, and show the artifact names the file that was still in
// flight when it died. Before this card, both NDJSON row kinds were written only in a post-run block that
// a SIGKILLed process never reaches — a killed run left NOTHING, not even rows for files that had already
// finished. This test proves that no longer holds: a write-ahead "run-start" row (written before the first
// test spawn) survives the kill, a "file" row for a file that DID complete survives the kill, a "file" row
// never appears for the file that was still running when killed, and the never-completed file is nameable
// by subtracting the surviving "file" rows from the run-start row's "selected" list.
//
// Deliberately a REAL subprocess spawn of the whole script (via --only=/--concurrency=, card 6185fbfc) —
// every OTHER test-daemon.mjs test (test-daemon-cli-args.mjs, test-daemon-gate-timing.mjs, ...) exercises
// exported functions directly against synthetic inputs specifically to AVOID a real spawn; that pattern is
// wrong here, because a clean-exit path proves nothing about surviving a kill. The kill IS the test.
//
// SLOW is "merge-repo-mutex" — one of the TEST_TIMEOUT_OVERRIDES-listed real-git tests (documented there as
// 15 trials x 2 concurrent real merges + a full content-integrity sweep), chosen specifically because it
// reliably takes multiple seconds: with --concurrency=1 forcing strict sequential order, SLOW cannot even
// START until FAST's own completion row has already landed, so the kill (fired the instant FAST's row is
// observed) always lands while SLOW is still mid-setup — no timing race. Because SLOW forks its own real
// git subprocesses, killing only OUR directly-spawned child would orphan them to keep running in the
// background on every normal gate invocation (this file is itself a discovered hermetic test) — `killTree`
// below kills the whole process tree rooted at the PID we captured at spawn, never by name/port, so nothing
// survives the kill to linger after this test exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { neverCompletedFiles } from "../scripts/test-daemon.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DAEMON_SCRIPT = path.join(__dirname, "..", "scripts", "test-daemon.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Best-effort NDJSON read — tolerant of a line still mid-write (a partial JSON fragment) since our poller
// races the child process's own writes; a malformed line is simply skipped and re-read on the next poll,
// never treated as a fatal parse error.
function readRows(ndjsonPath) {
  if (!fs.existsSync(ndjsonPath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(ndjsonPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* mid-write partial line — skip, will re-read complete next poll */ }
  }
  return rows;
}

// Anchored to an OBSERVABLE event (the predicate becoming true), never a fixed sleep — a fixed wait guarding
// a negative assertion ("X never happened") can't distinguish "it won't happen" from "it hasn't happened
// YET" (see this project's own fixed-wait-negative-guard doctrine). Here the events we anchor to are always
// POSITIVE ("this row now exists" / "the process exited"), so polling to a bounded timeout is the correct
// shape, not a workaround for it.
async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = predicate();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Kills the WHOLE process tree rooted at `child`'s own PID — never by image name or port (this repo's
// standing rule against exactly that: a name/port kill can reach an unrelated process). Safe here because
// the tree is entirely attributable to the PID we captured ourselves at spawn, one level deeper than the
// usual "kill the pid you spawned" rule to also reach SLOW's own real-git grandchildren, which would
// otherwise survive killing only the immediate child and keep running in the background.
function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
}

const FAST = "test-daemon-cli-args"; // pure-logic self-test of this same script — near-instant, no subprocess of its own.
const SLOW = "merge-repo-mutex"; // TEST_TIMEOUT_OVERRIDES-listed real-git test — several seconds minimum.

async function runSigkillScenario() {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-td-sigkill-"));
  registerForCleanup(scratchHome);
  const ndjsonPath = path.join(scratchHome, "gate-timing", "daemon-per-file-timing.ndjson");

  const child = spawn(process.execPath, [TEST_DAEMON_SCRIPT, `--only=${FAST},${SLOW}`, "--concurrency=1"], {
    env: { ...process.env, LOOM_HOME: scratchHome, LOOM_TEST: "1" },
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", () => {}); // drained, not asserted on — this test reads the NDJSON artifact only
  child.stderr.on("data", () => {});

  const fastRowSeen = await waitFor(() => readRows(ndjsonPath).some((r) => r.kind === "file" && r.name === FAST));
  if (!fastRowSeen) {
    killTree(child);
    throw new Error(`${FAST}'s completion row never landed within the timeout — cannot run the SIGKILL scenario`);
  }

  const exited = waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 10_000 });
  killTree(child);
  await exited;

  return { ndjsonPath };
}

// [contrast case] the SAME kind of run, allowed to terminate normally — needed because this whole test is
// checking for an ABSENCE (no run-summary row) in the killed scenario below. A check for something's
// absence only proves the target CAN be absent unless paired with a run where it's KNOWN present; without
// this, a reader parsing bug that always returns "nothing found" would pass the killed-scenario assertions
// too, for the wrong reason (see this project's own control-polarity doctrine).
async function runCleanScenario() {
  const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-td-sigkill-clean-"));
  registerForCleanup(scratchHome);
  const ndjsonPath = path.join(scratchHome, "gate-timing", "daemon-per-file-timing.ndjson");

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TEST_DAEMON_SCRIPT, `--only=${FAST}`], {
      env: { ...process.env, LOOM_HOME: scratchHome, LOOM_TEST: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`clean-scenario run exited ${code}: ${stderr.slice(-2000)}`))));
  });

  return { ndjsonPath, exitCode };
}

const { ndjsonPath } = await runSigkillScenario();
const rows = readRows(ndjsonPath);
const runStartRows = rows.filter((r) => r.kind === "run-start");
const fileRows = rows.filter((r) => r.kind === "file");
const runSummaryRows = rows.filter((r) => r.kind === "run-summary");

check("[positive control] the killed run left exactly one write-ahead run-start row", runStartRows.length === 1);
check("the run-start row names both selected files, in the given order", runStartRows[0]?.selected?.join(",") === `${FAST},${SLOW}`);
check("[positive control] the FAST file's completion row survived the kill", fileRows.some((r) => r.name === FAST));
check(
  "the surviving file row shares the SAME runUid as the run-start row (same run, not stale data from elsewhere)",
  fileRows.find((r) => r.name === FAST)?.runUid === runStartRows[0]?.runUid,
);
check(
  "[positive control — the actual defect this card fixes] the SLOW file, killed mid-flight, has NO completion row",
  !fileRows.some((r) => r.name === SLOW),
);
check(
  "[positive control] a SIGKILLed run writes NO run-summary row at all — before this card, the ENTIRE artifact (this row plus every file row) was silently absent; now only this closing row is",
  runSummaryRows.length === 0,
);

const neverCompleted = neverCompletedFiles(runStartRows[0]?.selected ?? [], fileRows.map((r) => r.name));
check(
  "[positive control — the whole point of the card] the never-completed file is nameable by subtraction, and it's the one actually killed mid-flight",
  neverCompleted.join(",") === SLOW,
);

const { ndjsonPath: cleanNdjsonPath } = await runCleanScenario();
const cleanRows = readRows(cleanNdjsonPath);
const cleanRunStart = cleanRows.filter((r) => r.kind === "run-start");
const cleanRunSummary = cleanRows.filter((r) => r.kind === "run-summary");
const cleanFileRows = cleanRows.filter((r) => r.kind === "file");
check(
  "[contrast case] a run that terminates normally DOES leave a run-summary row — proves the killed run's absence above is a real signal of non-termination, not a broken reader that always reports zero",
  cleanRunSummary.length === 1,
);
check("[contrast case] the clean run's run-summary shares its run-start row's runUid", cleanRunSummary[0]?.runUid === cleanRunStart[0]?.runUid);
check(
  "[contrast case] neverCompletedFiles reports zero for a run that actually finished",
  neverCompletedFiles(cleanRunStart[0]?.selected ?? [], cleanFileRows.map((r) => r.name)).length === 0,
);

console.log(`\n${failures === 0 ? "✅" : "❌"} test-daemon-gate-timing-sigkill: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
