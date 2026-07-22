import type { PlatformConfigOverride } from "@loom/shared";
import { codescapeBinCandidate, hostToolBinExists, isLoomDev } from "../paths.js";

/**
 * Card 8dc5ebb9: the live "is this configured host tool actually there" read the human-only
 * `/api/integrations` endpoint (gateway/server.ts) serves to the Settings › Integrations UI. `state` is
 * derived by calling the same bin-resolution precedence a spawn would use
 * (codescapeBinCandidate/hostToolBinExists) — never a re-derived fs check that could drift from actual
 * spawn behavior.
 *
 * Adding a PUBLIC integration (not codescape)? Push its detector unconditionally in
 * `detectIntegrations()` below, NOT inside the `isLoomDev()` branch — that branch is codescape-specific
 * (a private product, see its own comment there), not a blanket "non-dev daemons get no integrations"
 * gate. A new slug added here and detected inside the dev branch by mistake would silently vanish on
 * every regular `loomctl` install with nothing erroring.
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

/**
 * Detect known host-tool integrations against the daemon's current platform config override.
 *
 * The `isLoomDev()` gate below is CODESCAPE-SPECIFIC, not a blanket "non-dev daemons get no
 * integrations" rule. Codescape is a PRIVATE product (project memory
 * `codescape-is-private-no-user-visible-surface`, owner directive): end users of `loomctl` cannot
 * obtain it, so they and their agents must not be able to learn it exists. Gated at THIS layer —
 * `detectCodescape()` is never even called for a non-dev daemon — rather than filtered out of the
 * result later, so the "codescape"/"Codescape" strings are never constructed in a non-dev process at
 * all (card f3ce53f1). The owner's own `LOOM_DEV=1` dev path is unaffected (see `isLoomDev()`,
 * `paths.ts`). A future PUBLIC integration is pushed unconditionally, above the `if` — see the doc
 * comment on `IntegrationSlug`.
 */
export async function detectIntegrations(override: PlatformConfigOverride): Promise<IntegrationStatus[]> {
  const out: IntegrationStatus[] = [];
  // Public integrations go here, unconditionally.
  if (isLoomDev()) out.push(detectCodescape(override)); // private product — see codescape-privacy-guard.mjs
  return out;
}
