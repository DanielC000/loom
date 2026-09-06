import type { WebhookSourceType } from "@loom/shared";
import { wrapUntrustedDataBlock, truncateForKickoff, kickoffTruncationNote } from "../untrusted-data.js";

/**
 * Format a VERIFIED inbound webhook's payload as an explicitly-untrusted DATA block — reuses the SAME
 * envelope as `orchestration/poll-format.ts`'s `formatPollItemsBlock` via the shared
 * `wrapUntrustedDataBlock` helper (deliberately NOT `event-trigger-format.ts`'s plain framing, which is
 * reserved for Loom-INTERNAL-only telemetry): a webhook payload is third-party content just like a poll
 * fetch, and a cryptographically-verified sender is a claim about WHO sent it, never a claim about what
 * the bytes are safe to do — the recipient session must still treat it as data, never as instructions to
 * obey. Delimited by a collision-proof random marker rather than a fixed markdown code fence, since this
 * is a PUBLIC ingress: an attacker fully controls the payload and could otherwise craft a fence-breakout
 * string.
 */
export function formatWebhookEventBlock(sourceType: WebhookSourceType, endpointName: string, payload: unknown): string {
  const { body, truncated } = truncateForKickoff(JSON.stringify(payload, null, 2));
  return wrapUntrustedDataBlock(
    `[loom:webhook] A signature-verified inbound webhook was received on endpoint "${endpointName}" (source: ${sourceType})`,
    body,
  ) + kickoffTruncationNote(truncated);
}
