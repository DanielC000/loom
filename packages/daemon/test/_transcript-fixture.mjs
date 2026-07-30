// SHARED test fixture for readTranscript-based tests.
//
// readTranscript resolves the engine transcript under the user's REAL ~/.claude/projects (Claude's
// on-disk dir-encoding — see encodeProjectDir), NOT under a test tmpdir. A test that fabricates a
// fixture for it therefore creates a mangled dir under the user's ACTUAL Claude home, and must clean
// it up explicitly — a teardown that only rm's its own tmpRoot leaks that dir on every run (board card
// 99aedfa0: ~250 leaked dirs accumulated in ~/.claude/projects before this fix).
//
// withEngineTranscriptFixture guarantees teardown via try/finally (a mid-fixture throw still cleans
// up) and asserts its own engineDir is actually gone afterward, so a future readTranscript test can't
// reintroduce the leak just by forgetting to await/rm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeProjectDir } from "../dist/sessions/transcript.js";
import { mkdtempManaged, registerForCleanup, unregister } from "./_tmp-fixture.mjs";

/**
 * @param {{ prefix: string, engineSessionId: string, fileContent: string }} opts
 *   prefix: os.tmpdir() prefix for this fixture's tmpRoot (e.g. "loom-transcript-repair-").
 *   engineSessionId: the fake engine session id the fixture's .jsonl is named after.
 *   fileContent: the raw file content to write as the engine transcript .jsonl.
 * @param {(cwd: string) => any} fn  run against the fabricated fixture; receives the fixture's cwd.
 */
export function withEngineTranscriptFixture({ prefix, engineSessionId, fileContent }, fn) {
  const tmpRoot = mkdtempManaged(prefix);
  const cwd = path.join(tmpRoot, "repo");
  fs.mkdirSync(cwd, { recursive: true });

  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  // engineDir lives under the REAL ~/.claude, not under tmpRoot — fold it into the SAME guaranteed-
  // cleanup registry as a defense-in-depth backstop, on top of (never instead of) the explicit
  // survival-check finally below (card 995be21f).
  registerForCleanup(engineDir);
  const file = path.join(engineDir, `${engineSessionId}.jsonl`);
  fs.writeFileSync(file, fileContent);

  try {
    return fn(cwd);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${tmpRoot} — ${err}`); }
    if (!fs.existsSync(tmpRoot)) unregister(tmpRoot);

    try { fs.rmSync(engineDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (err) { console.error(`[tmp] retained for backstop: ${engineDir} — ${err}`); }
    if (fs.existsSync(engineDir)) {
      throw new Error(`withEngineTranscriptFixture: engineDir survived teardown: ${engineDir}`);
    }
    unregister(engineDir);
  }
}
