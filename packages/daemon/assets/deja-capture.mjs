#!/usr/bin/env node
// Loom opt-in Deja capture PostToolUse hook (card b3bd4841). Invoked by Claude Code as:
//   node deja-capture.mjs <sessionId> <port>
// Reads the PostToolUse payload on stdin. When a Write/Edit/MultiEdit touched an .html file, it
// resolves this session's origin_prompt + project DAEMON-SIDE (sessionId -> the worker session's
// taskId -> the persisted task's title+body, the durable default) via the daemon on 127.0.0.1:<port>,
// then shells out to `deja capture` so the mockup is auto-ingested with that origin_prompt.
//
// CONTRACT (load-bearing, mirrors vault-lint.mjs exactly): opt-in, best-effort, advisory-only.
// ALWAYS exits 0 — never blocks the write, regardless of daemon-resolution or Deja-CLI failure.
// `deja capture` is ALWAYS called even when origin_prompt/project resolution failed (empty strings)
// — capturing the mockup SOURCE is make-or-break; the prompt/project are a bonus key, never a gate.
//
// CONFIRMED (Deja mgr via the Lead, card b3bd4841 — no longer a proposal):
//   - invocation: `deja capture <file> --prompt <origin_prompt> --project <project>` (file positional,
//     then flag pairs), 15s timeout. Deja's own `capture` no-ops on non-.html, handles empty
//     --prompt/--project itself (empty prompt -> origin_prompt=null, empty project -> "default"),
//     and always exits 0.
//   - `/internal/deja-context/:sessionId` origin_prompt content is task title+body for v1 — the
//     Deja-confirmed ENRICHMENT (append the triggering UserPromptSubmit turn, to differentiate
//     sibling A/B/C variants generated from one task) needs the daemon to PERSIST that turn per
//     session first, which it does NOT today (hook-relay.mjs relays UserPromptSubmit, but
//     PtyHost.deliverHook's UserPromptSubmit case only flips firstTurnStarted/busy — it never
//     stores the prompt text). Flagged up for Lead scoping; the route's response shape already
//     carries a single `originPrompt` string, so enrichment is a DAEMON-side-only change (this
//     relay needs no update) once that persistence lands.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTML_RE = /\.html?$/i;

/** True when this PostToolUse payload is a Write/Edit/MultiEdit that touched an .html(.htm) file. */
export function isCaptureCandidate(payload) {
  const tool = payload?.tool_name;
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return false;
  const filePath = payload?.tool_input?.file_path;
  return typeof filePath === "string" && HTML_RE.test(filePath);
}

/**
 * Daemon-side resolution: sessionId -> the worker session's taskId -> the persisted task's
 * title+body (the origin_prompt default, v1 — see header for the pending enrichment) + the
 * project name. Never throws — a daemon-side miss (no such session, no daemon listening, a network
 * hiccup) resolves to null so the caller degrades gracefully. `fetchImpl` is injected so this is
 * testable against a session->task fixture, or against a real live route, with no daemon required.
 */
export async function resolveOriginContext(sessionId, port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/internal/deja-context/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.originPrompt !== "string" || typeof data.project !== "string") return null;
    return { originPrompt: data.originPrompt, project: data.project };
  } catch {
    return null;
  }
}

/**
 * Resolve the `deja` binary to exec. A bare `"deja"` relies on the PATH this hook subprocess
 * inherits (daemon env -> pty-spawned `claude` -> Claude's hook exec) — unlike `claude`/Playwright/
 * markitdown, Loom does NOT own or provision this external binary, so there's no absolute path to
 * fall back to on our own. `LOOM_DEJA_BIN` is a HUMAN-only override (host-set, an ordinary env var —
 * NEVER an agent MCP parameter) mirroring `LOOM_MARKITDOWN_BIN`'s exact mechanism + trust posture:
 * when set, it's used AS GIVEN (typically an absolute path), bypassing PATH search entirely — the
 * fix for a daemon whose launch env's PATH doesn't include wherever the human installed `deja`
 * (e.g. a service-managed daemon with a minimal PATH). Also the test seam.
 */
export function resolveDejaBin() {
  return process.env.LOOM_DEJA_BIN || "deja";
}

/**
 * Shells out to the Deja capture endpoint: `deja capture <file> --prompt <origin_prompt> --project
 * <project>` (file positional, then flag pairs) — CONFIRMED (see header), a purpose-built thin
 * endpoint, NOT raw `deja ingest`. ALWAYS called, even with empty prompt/project (Deja handles that
 * itself: empty prompt -> origin_prompt=null, empty project -> "default") — capturing the mockup
 * SOURCE is make-or-break, the prompt/project are a bonus key. Deja's own `capture` already no-ops
 * on non-.html and always exits 0; this wrapper NEVER throws either way (missing binary, non-zero
 * exit, timeout all resolve silently) so a Deja-CLI failure can never block the write.
 */
export function runDejaCapture(filePath, originPrompt, project, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const args = ["capture", filePath, "--prompt", originPrompt ?? "", "--project", project ?? ""];
    try {
      execFileImpl(resolveDejaBin(), args, { timeout: 15000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main() {
  const [sessionId, port] = process.argv.slice(2);
  if (!sessionId || !port) return;

  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  if (!isCaptureCandidate(payload)) return;

  let filePath = payload.tool_input.file_path;
  if (!path.isAbsolute(filePath)) filePath = path.resolve(payload.cwd || process.cwd(), filePath);

  const ctx = await resolveOriginContext(sessionId, port);
  await runDejaCapture(filePath, ctx?.originPrompt, ctx?.project);
}

// Only run as the CLI entrypoint (Claude Code's `node deja-capture.mjs <sessionId> <port>`) — a
// test importing the pure functions above must NOT trigger a stdin read / network call as a
// side effect of import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
