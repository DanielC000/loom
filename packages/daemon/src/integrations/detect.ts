import type { PlatformConfigOverride } from "@loom/shared";
import { codescapeBinCandidate, hostToolBinExists } from "../paths.js";

/**
 * Card 8dc5ebb9: the live "is this configured host tool actually there" read the human-only
 * `/api/integrations` endpoint (gateway/server.ts) serves to the Settings › Integrations UI. `state` is
 * derived by calling the same bin-resolution precedence a spawn would use
 * (codescapeBinCandidate/hostToolBinExists) — never a re-derived fs check that could drift from actual
 * spawn behavior.
 */
export type IntegrationSlug = "codescape";
export type IntegrationSource = "db" | "env" | "none";
export type IntegrationState = "detected" | "not-found";
export interface IntegrationStatus {
  slug: IntegrationSlug;
  label: string;
  /** The path currently effective (DB override, else env fallback, else null when neither is set — for
   *  codescape this can still resolve via a bare PATH-resolvable default even when `path` is null). */
  path: string | null;
  source: IntegrationSource;
  state: IntegrationState;
  /** A one-line human hint, present only when `state !== "detected"`. */
  detail?: string;
}

function detectCodescape(override: PlatformConfigOverride): IntegrationStatus {
  const dbPath = override.integrations?.codescape?.path;
  const envPath = process.env.LOOM_CODESCAPE_BIN;
  const path = dbPath?.trim() || envPath || null;
  const source: IntegrationSource = dbPath?.trim() ? "db" : envPath ? "env" : "none";
  const bin = codescapeBinCandidate(dbPath);
  const detected = hostToolBinExists(bin);
  return {
    slug: "codescape", label: "Codescape", path, source,
    state: detected ? "detected" : "not-found",
    ...(detected ? {} : { detail: "binary not found on PATH or at the configured path" }),
  };
}

/** Detect known host-tool integrations against the daemon's current platform config override. */
export async function detectIntegrations(override: PlatformConfigOverride): Promise<IntegrationStatus[]> {
  return [detectCodescape(override)];
}
