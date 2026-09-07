import type { HarnessAdapter, HarnessCapabilities } from "./adapter.js";
import { resolveExecutable } from "./resolve-bin.js";
import {
  readTranscript as codexReadTranscript,
  resolveTranscriptFile,
  transcriptExists as codexTranscriptExists,
  snapshotTranscript as codexSnapshotTranscript,
} from "./codex-transcript.js";
import { watchCodexLiveness, getCachedCodexVersion } from "./codex-doctrine.js";

/**
 * The concrete codex implementation of {@link HarnessAdapter} — multi-harness epic df1f94b0, Phase 1,
 * card 353f6dc4. Mirrors `pty/claude-adapter.ts`'s shape exactly: every method is a thin delegate to a
 * function owned by `codex-transcript.ts`/`codex-doctrine.ts`.
 *
 * ## Capabilities deliberately left OFF, and why (honest degradation, not an oversight)
 * `contextTelemetry`/`usageTelemetry` are `false` — NOT because Codex lacks this data (the probe
 * confirmed a live "N% context left" footer and a `token_count` rollout-record TYPE exists), but because
 * every real sample available on this host had an EMPTY `token_count.info` payload (see
 * `codex-transcript.ts`'s own header gap note) — the field NAMES for a populated usage record are
 * UNCONFIRMED. Implementing these against guessed field names would silently misreport on every real
 * session rather than degrading honestly; the card's own scope explicitly sanctions this ("declare
 * unsupported capabilities honestly ... turn-count recycle fallback from Phase 0's capability flags").
 * `rateLimitStatus` is `false` for the same reason `claudeAdapter` leaves it false: no live poller
 * instance exists yet for either harness's account-wide usage endpoint.
 */
const capabilities: HarnessCapabilities = {
  contextTelemetry: false, // see header note — unconfirmed token_count field shape, not a real absence
  usageTelemetry: false, // ditto
  rateLimitStatus: false, // no poller instance wired (mirrors claudeAdapter's own reasoning)
  livenessWatch: true,
  doctrineInjection: "file", // card 887e10b8 Item 1 — AGENTS.md injection, wired in spawnCodexProcess (host.ts)
  builtinReset: false, // no documented in-band reset command found for Codex (probe + --help sweep)
  versionGating: true,
};

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  capabilities,

  resolveBinary: (name) => resolveExecutable(name),

  locateTranscript: (cwd, conversationId) => resolveTranscriptFile(cwd, conversationId),
  transcriptExists: (cwd, conversationId) => codexTranscriptExists(cwd, conversationId),
  readTranscript: (cwd, conversationId) => codexReadTranscript(cwd, conversationId),
  snapshotTranscript: (cwd, conversationId, projectId, sessionId) =>
    codexSnapshotTranscript(cwd, conversationId, projectId, sessionId),

  watchLiveness: (onRemoved) => watchCodexLiveness(onRemoved),

  vendorProcessSlashCommand: () => null,

  readCachedVersion: () => getCachedCodexVersion(),
};
