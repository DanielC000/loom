import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 836c40b7 — regression test for the race that crashed `mcp-config-secret-lifecycle.mjs` inside
// TWO real full merge gates (never reproduced standalone, at low host contention): a reader polling
// `fs.existsSync(dumpPath)` can observe the file the instant a writer's open() syscall lands, before the
// write()/close() syscalls complete — so `JSON.parse(fs.readFileSync(dumpPath))` can crash with
// "Unexpected end of JSON input" against a momentarily-empty or truncated file. A race that only shows
// up under heavy host contention can't be relied on to fail "on demand", so this forces the window
// deterministically via `fixtures/fake-claude-cli.mjs`'s test-only `FIXTURE_ENV_DUMP_SLOW_WRITE_MS` hook
// (writes the file EMPTY, holds it that way for N ms, then writes the real content — never atomically,
// unlike the fixture's normal path) rather than racing real timing.
//
// Proves BOTH directions, against the SAME forced window:
//   (A) the OLD `waitUntil(() => existsSync) -> JSON.parse(readFileSync)` pattern this file replaces at
//       every call site DOES crash against it (the negative control — the instrument can fail).
//   (B) the NEW shared `waitForJsonFile` helper (`_wait.mjs`) polls past the window and returns the
//       real, correctly-parsed content.
// Then proves the PRODUCTION (non-forced) path is actually fixed: the fixture's real write is atomic
// (temp path + rename), so `waitForJsonFile` reads it promptly and the temp path never survives.
//
// Run: 1) build daemon (pnpm build), 2) node test/wait-json-file.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil, waitForJsonFile } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");
const tmpDir = mkdtempManaged("loom-wjf-");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killAndConfirmGone(child, label) {
  const pid = child.pid;
  if (child.exitCode !== null || child.signalCode !== null) return; // already exited
  try { child.kill(); } catch { /* already gone */ }
  await waitUntil(() => !isAlive(pid), { label: `${label} pid=${pid} exit`, timeoutMs: 10000 });
}

// --- (A)/(B) the forced race window ---
{
  const dumpPath = path.join(tmpDir, "slow-dump.json");
  const outputFile = path.join(tmpDir, "slow-output");
  const testToken = "test-token-slow-write-836c40b7";
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...process.env,
      FIXTURE_OUTPUT_FILE: outputFile,
      FIXTURE_ENV_DUMP_FILE: dumpPath,
      FIXTURE_ENV_DUMP_SLOW_WRITE_MS: "2000",
      FIXTURE_HEARTBEAT_MS: "60000",
      LOOM_MCP_TOKEN: testToken,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    // A genuine observable precondition, not a guess about timing: the fixture GUARANTEES it will hold
    // the file at exactly 0 bytes for the full slow-write window, so "exists AND size===0" is ground
    // truth for "we are inside the window" — it can never flicker back to 0 after the real write lands.
    await waitUntil(() => fs.existsSync(dumpPath) && fs.statSync(dumpPath).size === 0,
      { label: "slow-write dump file created empty (inside the forced race window)", timeoutMs: 5000 });

    let oldPatternThrew = false;
    try {
      JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    } catch (err) {
      oldPatternThrew = err instanceof SyntaxError;
    }
    check("(negative control) the OLD existsSync-then-JSON.parse pattern DOES crash against a file caught mid-write",
      oldPatternThrew);

    const dump = await waitForJsonFile(dumpPath, { label: "slow-write dump file (new helper)", timeoutMs: 10000 });
    check("(fix) waitForJsonFile polls past the forced window and returns the real, fully-written content",
      dump.LOOM_MCP_TOKEN === testToken);
  } finally {
    await killAndConfirmGone(child, "slow-write fixture");
  }
}

// --- the PRODUCTION (non-forced) path: the fixture's real write is atomic ---
{
  const dumpPath = path.join(tmpDir, "fast-dump.json");
  const outputFile = path.join(tmpDir, "fast-output");
  const testToken = "test-token-fast-write-836c40b7";
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...process.env,
      FIXTURE_OUTPUT_FILE: outputFile,
      FIXTURE_ENV_DUMP_FILE: dumpPath,
      FIXTURE_HEARTBEAT_MS: "60000",
      LOOM_MCP_TOKEN: testToken,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const dump = await waitForJsonFile(dumpPath, { label: "fast-write dump file", timeoutMs: 10000 });
    check("(production path) waitForJsonFile reads the atomically-written dump file promptly",
      dump.LOOM_MCP_TOKEN === testToken);
    check("(production path) the sibling temp file never survives the rename",
      !fs.existsSync(`${dumpPath}.tmp-${child.pid}`));
  } finally {
    await killAndConfirmGone(child, "fast-write fixture");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the old existsSync-then-parse pattern crashes against a forced empty-file window, the new waitForJsonFile helper polls past it, and the fixture's real (non-forced) write is atomic."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
