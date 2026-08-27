// ARGUMENT-ORDER forwarding test for `claudeAdapter`'s delegates (card 2b099e48, Code Review B1a — second
// independent pass). `harness-adapter-conformance.mjs` covers capability<->method-presence pairing and
// general equivalence; THIS file exists for one narrower, sharper reason the reviewer named directly:
// `snapshotTranscript(cwd, conversationId, projectId, sessionId)` is FOUR same-typed `string` params, so a
// swapped `projectId`/`sessionId` (or any other pair) is NOT a type error — nothing but a real test with
// DISTINGUISHABLE arguments and an OBSERVABLE swap-sensitive result can catch it, and until this file no
// test constructed `claudeAdapter` at all.
//
// ⚠️ NOT spy/mock-based, and that's a deliberate choice, stated rather than silently substituted: this
// 800+-file suite has no established module-mocking pattern (no `node:test` `mock.module` usage anywhere
// in it), and claude-adapter.ts's delegates close over their real imports at ESM load time, so intercepting
// the call would mean introducing new, unprecedented test infrastructure for one file. Instead, every check
// below uses REAL, DISTINGUISHABLE inputs (a cwd that is provably not a conversationId, a projectId that is
// provably not a sessionId) and asserts against the REAL, OBSERVABLE effect (a resolved path, an archived
// file's actual location) — which is at least as strong evidence of correct forwarding as a spy would be,
// since it also proves the underlying plumbing genuinely works end to end, not merely that a call happened.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

// snapshotTranscript writes under LOOM_HOME/archives — sandbox it BEFORE importing anything that reads
// LOOM_HOME at module-load time (paths.ts), same convention session-archive.mjs uses: set the env var
// first, then reach every LOOM_HOME-sensitive module via a DEFERRED `await import`, never a static one.
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-adapter-delegates-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { claudeAdapter } = await import("../dist/pty/claude-adapter.js");
const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const { readTranscript, resolveTranscriptFile, engineTranscriptExists } = await import("../dist/pty/claude-transcript.js");
const { readContextStats, readRunUsage } = await import("../dist/sessions/context.js");
const { archivedTranscriptPath, deleteArchivedTranscript } = await import("../dist/sessions/transcript.js");
const { withEngineTranscriptFixture } = await import("./_transcript-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// resolveBinary(name) — a single arg, but still worth proving it's genuinely FORWARDED (not hardcoded to
// "claude"): "node" is guaranteed present on PATH in any environment this test runs in, and must resolve
// to a DIFFERENT absolute path than "claude" does.
{
  const nodeResolved = claudeAdapter.resolveBinary("node");
  const claudeResolved = claudeAdapter.resolveBinary("claude");
  check("resolveBinary('node') === resolveExecutable('node')", nodeResolved === resolveExecutable("node"));
  check("resolveBinary('node') !== resolveBinary('claude') — proves the name argument is genuinely used, not hardcoded",
    nodeResolved !== claudeResolved);
  const absolute = path.join(os.tmpdir(), "not-a-real-binary-xyz");
  check("resolveBinary(<absolute path>) passes it through unchanged (resolveExecutable's own documented contract)",
    claudeAdapter.resolveBinary(absolute) === absolute);
}

withEngineTranscriptFixture(
  {
    prefix: "loom-adapter-delegates-",
    engineSessionId: "adapter-delegates-conversation-id",
    fileContent: JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: "text", text: "ok" }] },
    }) + "\n",
  },
  (cwd) => {
    const conversationId = "adapter-delegates-conversation-id";
    // cwd (a real tmp directory path) and conversationId (a bare id string) are structurally
    // distinguishable — a swap inside the delegate produces a DIFFERENT resolved path, not the same one,
    // so comparing against the DIRECTLY-called function (correct order) genuinely discriminates a swap.
    check("locateTranscript(cwd, id) === resolveTranscriptFile(cwd, id) [order-sensitive: cwd is a dir path, id is not]",
      claudeAdapter.locateTranscript(cwd, conversationId) === resolveTranscriptFile(cwd, conversationId));
    check("locateTranscript(cwd, id) !== resolveTranscriptFile(id, cwd) [explicit swapped-order comparison — must differ]",
      claudeAdapter.locateTranscript(cwd, conversationId) !== resolveTranscriptFile(conversationId, cwd));

    check("transcriptExists(cwd, id) === engineTranscriptExists(cwd, id) === true",
      claudeAdapter.transcriptExists(cwd, conversationId) === true && engineTranscriptExists(cwd, conversationId) === true);
    check("transcriptExists(id, cwd) [swapped order] === false — id is not a real directory, so a swap is observably wrong",
      engineTranscriptExists(conversationId, cwd) === false);

    check("readTranscript(cwd, id) deep-equals the direct call, same order",
      JSON.stringify(claudeAdapter.readTranscript(cwd, conversationId)) === JSON.stringify(readTranscript(cwd, conversationId)));
    check("readTranscript(id, cwd) [swapped order] returns [] — proves the comparison above is order-sensitive, not vacuous",
      JSON.stringify(readTranscript(conversationId, cwd)) === "[]");

    check("readContextStats(cwd, id) deep-equals the direct call, same order",
      JSON.stringify(claudeAdapter.readContextStats(cwd, conversationId)) === JSON.stringify(readContextStats(cwd, conversationId)));
    check("readContextStats(id, cwd) [swapped order] === null — proves the comparison above is order-sensitive",
      readContextStats(conversationId, cwd) === null);

    // readCumulativeUsage — CURRENTLY UNTESTED ANYWHERE ELSE (neither the original suite nor
    // harness-adapter-conformance.mjs covers it). Same order-sensitivity shape as readContextStats.
    check("readCumulativeUsage(cwd, id) deep-equals the direct readRunUsage(cwd, id) call, same order",
      JSON.stringify(claudeAdapter.readCumulativeUsage(cwd, conversationId)) === JSON.stringify(readRunUsage(cwd, conversationId)));
    check("readRunUsage(id, cwd) [swapped order] === null — proves the comparison above is order-sensitive",
      readRunUsage(conversationId, cwd) === null);

    // THE hazard the reviewer named directly: snapshotTranscript(cwd, conversationId, projectId, sessionId)
    // is FOUR string params. projectId/sessionId are the pair with NO type-level protection (unlike
    // cwd/conversationId above, which at least differ structurally in shape). Real positive-path write +
    // check the archive landed at the CORRECT (projectId, sessionId) location, not the swapped one.
    const projectId = "adapter-delegates-project";
    const sessionId = "adapter-delegates-session";
    try {
      const wrote = claudeAdapter.snapshotTranscript(cwd, conversationId, projectId, sessionId);
      check("snapshotTranscript(cwd, id, projectId, sessionId) returns true (real write)", wrote === true);
      check("the snapshot landed at archivedTranscriptPath(projectId, sessionId) — the CORRECT order",
        fs.existsSync(archivedTranscriptPath(projectId, sessionId)));
      check("the snapshot did NOT land at archivedTranscriptPath(sessionId, projectId) — the SWAPPED order — proves projectId/sessionId weren't transposed",
        !fs.existsSync(archivedTranscriptPath(sessionId, projectId)));
    } finally {
      deleteArchivedTranscript(projectId, sessionId);
      deleteArchivedTranscript(sessionId, projectId); // defensive: clean up either location, in case a swap bug did land here
    }
  },
);

try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — every claudeAdapter delegate forwards its arguments in the declared order, checked against DISTINGUISHABLE real inputs (including an explicit swapped-order comparison for the ones with no type-level protection) rather than assumed from reading the source."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
