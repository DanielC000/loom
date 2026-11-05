import type { CapabilityProvisionKind, CapabilitySummary } from "@loom/shared";
import type { Tone } from "../theme";

// Slug-keyed capability provisioning status + the two kind-derived picker facts behind it (card cd9a78bc).
//
// Generalises what used to be one hardcoded markitdown widget in pages/Profiles.tsx. The daemon already
// exposes the status generically — `GET/POST /api/capabilities/:slug/provisioning[/retry]` (card e7d6e43b,
// gateway/server.ts) over ONE per-slug tracker (`getCapabilityProvisionStatus`, capabilities/registry.ts) —
// so the only thing missing web-side was deciding WHICH granted capability has a status worth rendering,
// and WHERE to read it from.
//
// ⚠️ EVERYTHING KEYED ON `kind` BELOW IS A UI MIRROR OF DAEMON BEHAVIOUR, NOT ITS SOURCE OF TRUTH — the
// same posture (and the same staleness risk) as lib/harnessFields.ts's codex drop map. A capability's
// provisioning RECIPE is deliberately daemon-internal and never reaches `CapabilitySummary`, so `kind` is
// the only signal the REST summary carries. Re-verify at source before editing either map, and
// positive-control any grep (a pattern that finds nothing in one kind's branch must be shown to find the
// same thing in another's).

/** The one status shape every provisioning route returns — `CapabilityProvisionStatus` in the daemon's
 *  capabilities/registry.ts, and the same shape the older `/api/python/provisioning` pair already served. */
export interface CapabilityProvisioning {
  state: "idle" | "installing" | "ready" | "failed";
  reason?: CapabilityProvisionReason;
  /** The captured ~4KB stdout+stderr tail of the failed install/download — the real proxy/SSL/resolver cause. */
  errorTail?: string;
  /** The resolved absolute binary path, on `ready` only. */
  binary?: string;
  lastAttemptAt?: number;
}

/**
 * Every classified failure cause, unioned across the three provisioning kinds — `ProvisionOutcome`
 * (python/venv.ts), `GithubBinaryProvisionOutcome` (capabilities/github-binary.ts) and
 * `NpmPinnedProvisionOutcome` (capabilities/npm-pinned.ts). `ready` is in the daemon unions but never
 * reaches a `failed` status, so it is absent here.
 */
export type CapabilityProvisionReason =
  // python-venv
  | "no-base-python" | "venv-create-failed" | "pip-failed"
  // github-binary
  | "unsupported-platform" | "download-failed" | "checksum-mismatch" | "extract-failed"
  // npm-pinned
  | "invalid-spec" | "lock-missing" | "install-failed"
  // shared by all three
  | "timeout" | "disabled";

/** One-line human summary per provisioning state — its signal tone + label. */
export const PROVISION_STATE_META: Record<CapabilityProvisioning["state"], { tone: Tone; label: string }> = {
  idle: { tone: "muted", label: "not provisioned yet" },
  installing: { tone: "busy", label: "installing…" },
  ready: { tone: "live", label: "ready" },
  failed: { tone: "danger", label: "install failed" },
};

/** The env var that turns provisioning off per kind — the three are NOT one flag, so a `disabled` status
 *  has to name the right one or the reader goes looking for a var that was never read. */
const NO_PROVISION_ENV: Partial<Record<CapabilityProvisionKind, string>> = {
  "python-venv": "LOOM_PYTHON_NO_PROVISION",
  "github-binary": "LOOM_GITHUB_MCP_NO_PROVISION",
  "npm-pinned": "LOOM_NPM_PINNED_NO_PROVISION",
};

/** Kind-independent phrasings. `disabled` is deliberately absent — it needs the kind (see above). */
const REASON_TEXT: Record<Exclude<CapabilityProvisionReason, "disabled">, string> = {
  "no-base-python": "no base Python ≥3.10 found — set its path in Settings → Python interpreter",
  "venv-create-failed": "couldn't create the shared venv",
  "pip-failed": "pip install failed",
  "unsupported-platform": "no published build for this OS/architecture",
  "download-failed": "the download failed",
  "checksum-mismatch": "the download's checksum didn't match the pinned one — refused, not installed",
  "extract-failed": "the download couldn't be unpacked",
  "invalid-spec": "the pinned package/version is malformed — nothing was installed",
  "lock-missing": "no committed lockfile for this pinned version — nothing was installed",
  "install-failed": "npm ci failed",
  timeout: "install timed out",
};

/**
 * Reason → human one-liner for a FAILED attempt. The daemon classifies the cause; we phrase it for a
 * human, and for the one self-service case (no base Python) point at the Settings field that fixes it.
 * `null` for an unrecognised code so a daemon-side addition degrades to the bare "install failed" label
 * rather than rendering a raw enum at the user.
 */
export function provisionReasonText(reason: CapabilityProvisionReason | undefined, kind: CapabilityProvisionKind): string | null {
  if (!reason) return null;
  if (reason === "disabled") {
    const env = NO_PROVISION_ENV[kind];
    return env ? `provisioning disabled on this daemon (${env})` : "provisioning disabled on this daemon";
  }
  return REASON_TEXT[reason] ?? null;
}

/**
 * Per-kind facts the REST summary can't carry: `provisioned` (does the daemon's per-slug tracker populate
 * a status for this kind — verified at source 2026-11-03 against `resolveCapabilityServer`) and `network`
 * (does provisioning fetch from a remote host).
 *
 * @decision cd9a78bc — never collapse the two flags into one boolean, and never demote this `Record` to a
 * membership array (only the `Record` makes a new daemon kind a BUILD FAILURE, not a silent default).
 * `network:false` is an absence of claim — never badge its negation as "local".
 */
const KIND_FACTS: Record<CapabilityProvisionKind, { provisioned: boolean; network: boolean }> = {
  "python-venv": { provisioned: true, network: true },
  "github-binary": { provisioned: true, network: true },
  "npm-pinned": { provisioned: true, network: true },
  "node-package": { provisioned: false, network: false },
  bundled: { provisioned: false, network: false },
  command: { provisioned: false, network: false },
};

/** The kinds whose status the daemon's per-slug tracker populates — see {@link KIND_FACTS}. */
export const PROVISIONED_KINDS: readonly CapabilityProvisionKind[] =
  (Object.keys(KIND_FACTS) as CapabilityProvisionKind[]).filter((k) => KIND_FACTS[k].provisioned);

/** The kinds whose provisioning fetches over the network — see {@link KIND_FACTS}. */
export const NETWORK_KINDS: readonly CapabilityProvisionKind[] =
  (Object.keys(KIND_FACTS) as CapabilityProvisionKind[]).filter((k) => KIND_FACTS[k].network);

/** Whether this capability's provisioning fetches over the network — drives the picker's `network` badge. */
export const capabilityNeedsNetwork = (c: Pick<CapabilitySummary, "kind">): boolean => !!KIND_FACTS[c.kind]?.network;

/**
 * WHICH endpoint backs a given capability's provisioning row, or `"none"` when it has no status to show.
 *
 * `"global-python"` is the one legacy carve-out, and it is not cosmetic: the `document-conversion`
 * BUILTIN is not a catalog row at all. `buildMcpServers` (pty/host.ts) special-cases the two builtins
 * ahead of the registry loop, so markitdown provisions through host.ts's OWN module-scope globals and
 * reports at `/api/python/provisioning` — the per-slug tracker never sees that slug, and
 * `/api/capabilities/document-conversion/provisioning` would answer `idle` forever.
 *
 * `browser-testing` (the other builtin, `node-package`) genuinely has no status anywhere: Playwright is a
 * daemon dependency resolved synchronously at spawn.
 */
export type ProvisioningSource = "none" | "global-python" | "per-slug";

export function provisioningSourceOf(c: Pick<CapabilitySummary, "slug" | "kind" | "builtin">): ProvisioningSource {
  if (c.builtin) return c.slug === "document-conversion" ? "global-python" : "none";
  return PROVISIONED_KINDS.includes(c.kind) ? "per-slug" : "none";
}

/** Whether a provisioning row should be rendered for this capability at all. */
export const capabilityReportsProvisioning = (c: Pick<CapabilitySummary, "slug" | "kind" | "builtin">): boolean =>
  provisioningSourceOf(c) !== "none";
