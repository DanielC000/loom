import type { OrchestrationEvent } from "@loom/shared";

/**
 * Format an event trigger's matched orchestration event(s) as a `[loom:trigger]` kickoff block.
 *
 * DELIBERATE DIVERGENCE from `poll-format.ts`'s `formatPollItemsBlock`: a poll job's payload is fetched
 * from an EXTERNAL endpoint (untrusted third-party content — a prompt-injection surface), so it is framed
 * as explicit DATA the recipient must not obey. An event trigger's payload is a Loom-INTERNAL
 * `orchestration_events` row — already-trusted daemon-authored telemetry, never third-party content — so
 * it is framed plainly, with no "treat as data, not instructions" caveat. Reviewer: this is the one place
 * this subsystem intentionally does NOT reuse the poll untrusted-DATA wrapper.
 */
export function formatEventTriggerBlock(
  events: (OrchestrationEvent & { seq: number })[],
  eventKind: string,
  overflowCount: number,
): string {
  const body = JSON.stringify(
    events.map((e) => ({
      kind: e.kind, ts: e.ts, managerSessionId: e.managerSessionId,
      workerSessionId: e.workerSessionId ?? null, taskId: e.taskId ?? null, detail: e.detail ?? {},
    })),
    null, 2,
  );
  const overflow = overflowCount > 0
    ? `\n\n(+${overflowCount} more matching event(s) not shown — capped at ${events.length}.)`
    : "";
  return (
    `[loom:trigger] ${events.length + overflowCount} orchestration event(s) of kind '${eventKind}' matched ` +
    `this trigger.\n\n\`\`\`json\n${body}\n\`\`\`${overflow}`
  );
}
