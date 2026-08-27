import type { HarnessAdapter, HarnessCapabilities } from "./adapter.js";
import { resolveExecutable } from "./resolve-bin.js";
import {
  readTranscript as claudeReadTranscript,
  resolveTranscriptFile,
  engineTranscriptExists,
} from "./claude-transcript.js";
import { snapshotTranscript as claudeSnapshotTranscript } from "../sessions/transcript.js";
import { readContextStats as claudeReadContextStats, readRunUsage } from "../sessions/context.js";
import { watchClaudeLiveness, vendorProcessSlashCommand as claudeSlashCommand } from "./claude-doctrine.js";
import { getCachedClaudeVersion } from "../orchestration/usage-status.js";

/**
 * The concrete claude implementation of {@link HarnessAdapter} — card 2b099e48, Phase 0. Every method
 * here is a thin, zero-logic-duplication delegate to a function that already existed before this card
 * (now relocated per `pty/adapter.ts`'s own coupling-audit table); nothing in this file re-implements
 * behavior. See `pty/adapter.ts`'s top-level doc for what's DELIBERATELY absent (the stateful
 * submit/busy/hook-dispatch subset, which stays `pty/host.ts`-internal) and why.
 */
const capabilities: HarnessCapabilities = {
  contextTelemetry: true,
  usageTelemetry: true,
  // The rate-limit poll (orchestration/usage-status.ts#UsageStatusPoller) is a stateful, cached,
  // instance-owned poller — not a free function — so THIS static singleton has no live instance to read
  // from and leaves readRateLimitStatus unimplemented. The capability exists in substance (Claude does
  // expose account-wide usage/rate-limit status); false here describes only this object, not the harness.
  rateLimitStatus: false,
  livenessWatch: true,
  doctrineInjection: "directory",
  builtinReset: true,
  versionGating: true,
};

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  capabilities,

  resolveBinary: (name) => resolveExecutable(name),

  locateTranscript: (cwd, conversationId) => resolveTranscriptFile(cwd, conversationId),
  transcriptExists: (cwd, conversationId) => engineTranscriptExists(cwd, conversationId),
  readTranscript: (cwd, conversationId) => claudeReadTranscript(cwd, conversationId),
  snapshotTranscript: (cwd, conversationId, projectId, sessionId) =>
    claudeSnapshotTranscript(cwd, conversationId, projectId, sessionId),

  readContextStats: (cwd, conversationId) => claudeReadContextStats(cwd, conversationId),
  readCumulativeUsage: (cwd, conversationId) => readRunUsage(cwd, conversationId),

  watchLiveness: (onRemoved) => watchClaudeLiveness(onRemoved),

  vendorProcessSlashCommand: (kind) => claudeSlashCommand(kind),

  readCachedVersion: () => getCachedClaudeVersion(),
};
