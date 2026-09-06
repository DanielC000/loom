import { wrapUntrustedDataBlock, truncateForKickoff, kickoffTruncationNote } from "../untrusted-data.js";

/**
 * Format a poll job's newly-detected item(s) as an explicitly-untrusted DATA block — shared by BOTH
 * trigger paths (wake's enqueued nudge and spawn's kickoff prompt) so an externally-fetched item (a
 * GitHub notification, an RSS entry, an inbox message) is framed IDENTICALLY regardless of which path
 * delivers it: content fetched from a third party is a prompt-injection surface, and the recipient
 * session must be told to treat it as data, never as instructions to obey (mirrors runs/prompt.ts's
 * injection-hygiene framing for an Agent Run's input). Envelope construction (the collision-proof
 * delimiter) is shared with `webhooks/format.ts`'s `formatWebhookEventBlock` via `wrapUntrustedDataBlock`.
 *
 * `overflowCount` bounds the ITEM COUNT (how many of the fetched items are included at all) —
 * orthogonal to `truncateForKickoff`'s bound on the serialized PAYLOAD SIZE of the items that ARE
 * included. A single pathologically large item passes the item-count cap untouched, so the size bound
 * is what catches it; both caps apply independently and either may fire without the other.
 */
export function formatPollItemsBlock(items: unknown[], host: string, overflowCount: number): string {
  const { body, truncated } = truncateForKickoff(JSON.stringify(items, null, 2));
  const overflow = overflowCount > 0
    ? `\n\n(+${overflowCount} more item(s) not shown — capped at ${items.length}.)`
    : "";
  return wrapUntrustedDataBlock(`Fetched from \`${host}\``, body) + kickoffTruncationNote(truncated) + overflow;
}
