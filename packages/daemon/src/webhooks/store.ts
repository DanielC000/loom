/**
 * Inbound webhook receiver — endpoint management (agent-tooling epic P5b, card 8fbedcac). A
 * WebhookEndpoint (opaque path + per-source signing secret + wake/spawn target) is written only through
 * the HUMAN-only loopback REST surface (`gateway/server.ts`) — there is intentionally NO MCP path (same
 * trust posture as the connections/poll_jobs/event_triggers writers): an agent in an ordinary project
 * session must never create, list, or read a webhook endpoint or its secret.
 *
 * SECURITY (load-bearing): the signing secret is ENCRYPTED AT REST via the SAME envelope helper already
 * used for connections/Companion bot tokens (`keys/envelope.ts` — AES-256-GCM, a local LOOM_HOME key
 * file, never DB-backed-up). `listWebhookEndpoints`/`getWebhookEndpointMetadata` NEVER decrypt and NEVER
 * return the blob — they return `WebhookEndpointMetadata` only. `getSecretForVerify` is the ONLY function
 * that returns the plaintext secret; called only from the ingress route (`webhooks/ingress.ts`),
 * server-side, never reachable over REST or from an agent.
 */
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import type { WebhookEndpointRow } from "../db.js";
import type { WebhookEndpointMetadata, WebhookSourceType } from "@loom/shared";
import { WEBHOOK_SOURCE_TYPES } from "@loom/shared";

/** The narrow db surface this module needs (mirrors ConnectionsDbStore's shape in connections/store.ts). */
export interface WebhookEndpointsDbStore {
  listWebhookEndpoints(): WebhookEndpointRow[];
  getWebhookEndpoint(id: string): WebhookEndpointRow | undefined;
  getWebhookEndpointByPath(path: string): WebhookEndpointRow | undefined;
  createWebhookEndpoint(input: {
    path: string; name: string; sourceType: WebhookSourceType; secretBlob: string;
    mode: "wake" | "spawn"; targetSessionId: string | null; agentId: string | null;
  }): WebhookEndpointRow;
  deleteWebhookEndpoint(id: string): void;
  setWebhookEndpointEnabled(id: string, enabled: boolean): void;
}

export const WEBHOOK_ENDPOINT_NAME_MAX = 200;
export const WEBHOOK_ENDPOINT_SECRET_MAX = 8192;
/** 16 random bytes, base64url-encoded (22 chars, URL-safe, no padding) — the opaque path segment an
 *  endpoint is mounted at (`POST /hooks/:path`). Non-guessable: this slug is itself bearer-adjacent (an
 *  attacker who doesn't know it can't even reach the HMAC-verify step), so it is ALWAYS generated here,
 *  never human-chosen. */
function generateEndpointPath(): string {
  return randomBytes(16).toString("base64url");
}

function isNonBlankStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function toMetadata(row: WebhookEndpointRow): WebhookEndpointMetadata {
  return {
    id: row.id, path: row.path, name: row.name, sourceType: row.sourceType, mode: row.mode,
    targetSessionId: row.targetSessionId, agentId: row.agentId, enabled: row.enabled,
    createdAt: row.createdAt, lastFiredAt: row.lastFiredAt,
  };
}

/** Validate endpoint-creation input (name/sourceType/secret bounds + shape). Non-throwing — used by
 *  `createWebhookEndpoint` to decide whether to throw, and reusable by a caller that wants to pre-check.
 *  Does NOT validate mode/targetSessionId/agentId coherence — that needs DB existence checks, done at the
 *  REST layer (mirrors `validateEventTriggerTarget` in gateway/server.ts) since this module has no DB
 *  session/agent lookup surface of its own. */
export function validateWebhookEndpointInput(input: {
  name?: unknown; sourceType?: unknown; secret?: unknown;
}): { ok: true } | { ok: false; error: string } {
  if (!isNonBlankStr(input.name, WEBHOOK_ENDPOINT_NAME_MAX)) {
    return { ok: false, error: `name must be a non-empty string of at most ${WEBHOOK_ENDPOINT_NAME_MAX} characters` };
  }
  if (typeof input.sourceType !== "string" || !(WEBHOOK_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
    return { ok: false, error: `sourceType must be one of: ${WEBHOOK_SOURCE_TYPES.join(", ")}` };
  }
  if (!isNonBlankStr(input.secret, WEBHOOK_ENDPOINT_SECRET_MAX)) {
    return { ok: false, error: `secret must be a non-empty string of at most ${WEBHOOK_ENDPOINT_SECRET_MAX} characters` };
  }
  return { ok: true };
}

/** List every stored endpoint as metadata only — never the secret. */
export function listWebhookEndpoints(db: WebhookEndpointsDbStore): WebhookEndpointMetadata[] {
  return db.listWebhookEndpoints().map(toMetadata);
}

/** Read one endpoint's metadata by id, or undefined when absent — never the secret. */
export function getWebhookEndpointMetadata(db: WebhookEndpointsDbStore, id: string): WebhookEndpointMetadata | undefined {
  const row = db.getWebhookEndpoint(id);
  return row ? toMetadata(row) : undefined;
}

/**
 * Create a new webhook endpoint. VALIDATES (name/sourceType/secret bounds) and THROWS a descriptive Error
 * on invalid input — the structural backstop, mirroring `createConnection`. The path is ALWAYS
 * server-generated (never caller-supplied — see `generateEndpointPath`'s doc). The plaintext `secret` is
 * encrypted here (via the envelope helper) before it ever reaches the db layer —
 * `WebhookEndpointsDbStore.createWebhookEndpoint` only ever sees ciphertext. `keyPath` overrides the
 * envelope key file (test seam only — never touch the real ~/.loom in tests).
 */
export function createWebhookEndpoint(
  db: WebhookEndpointsDbStore,
  input: {
    name: string; sourceType: WebhookSourceType; secret: string;
    mode: "wake" | "spawn"; targetSessionId: string | null; agentId: string | null;
  },
  keyPath?: string,
): WebhookEndpointMetadata {
  const v = validateWebhookEndpointInput(input);
  if (!v.ok) throw new Error(v.error);
  // Path collisions are astronomically unlikely (16 random bytes) but retry-on-collision costs nothing —
  // never persist a colliding path silently overwriting/erroring an unrelated endpoint.
  let path = generateEndpointPath();
  for (let attempt = 0; attempt < 5 && db.getWebhookEndpointByPath(path); attempt++) path = generateEndpointPath();
  const row = db.createWebhookEndpoint({
    path, name: input.name.trim(), sourceType: input.sourceType,
    secretBlob: encryptSecret(input.secret.trim(), keyPath),
    mode: input.mode, targetSessionId: input.targetSessionId, agentId: input.agentId,
  });
  return toMetadata(row);
}

/** Delete a webhook endpoint by id — idempotent, mirrors the db layer. */
export function deleteWebhookEndpoint(db: WebhookEndpointsDbStore, id: string): void {
  db.deleteWebhookEndpoint(id);
}

/** Enable/disable a webhook endpoint without deleting it (a disabled endpoint's path 404s at ingress —
 *  see webhooks/ingress.ts — same "don't leak existence/status" posture as an unknown path). */
export function setWebhookEndpointEnabled(db: WebhookEndpointsDbStore, id: string, enabled: boolean): void {
  db.setWebhookEndpointEnabled(id, enabled);
}

/**
 * Decrypt a webhook endpoint's signing secret for HMAC verification, given the already-loaded row (the
 * ingress route already has it from `getWebhookEndpointByPath` — no redundant lookup here). The seam the
 * ingress route calls, server-side only, to recompute the expected signature. Never expose this
 * function's return value over REST or to an agent. Throws if the stored blob fails to decrypt (corrupt /
 * wrong key), mirroring `getSecretForUse`.
 */
export function decryptWebhookSecret(row: WebhookEndpointRow, keyPath?: string): string {
  return decryptSecret(row.secretBlob, keyPath);
}
