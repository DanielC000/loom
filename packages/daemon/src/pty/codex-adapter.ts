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
 *
 * ## Addendum, card a1916267: a SECOND, independent reason `ctxInputTokens`/`ctxTurns`/`model` read null
 * on every codex worker row, beyond the field-shape uncertainty above. `pty/host.ts`'s ONLY capture
 * chokepoint for these (the Stop-hook handler that calls `readContextStats` + `db.setContextCounters`,
 * and `sessions/service.ts#autoRetireStopWhenIdle`'s belt-and-suspenders re-capture) is reached ONLY via a
 * confirming hook event. Codex has NO hook relay at all (`CodexLive.hookToken` is permanently empty and
 * never checked — see that field's own doc, `pty/host.ts`) — so even a hypothetical field-shape-correct
 * `readContextStats` implementation on this adapter would still never be INVOKED for a codex session; the
 * capture is hook-triggered, and codex never fires one. MEASURED: grepped `codex-host.ts` for
 * `setContextCounters`/`ctxInputTokens`/`ctxTurns` — zero hits. A real Phase-2 fix for codex context
 * telemetry needs BOTH pieces: a confirmed `token_count`/footer-percentage field shape (this file's
 * existing note) AND a non-hook capture chokepoint for this harness (e.g. keyed off the same screen-scan
 * markers `armCodexBusyStaleTimer` already polls, or a periodic read) — neither exists today, and this is
 * the explicit ruling that gap is DEFERRED, not silently unhandled: card a1916267 found the symptom
 * (null DB columns on a live codex worker row) but did not resolve either piece, both being real,
 * separately-scoped engineering work beyond a diagnostics bugfix.
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
