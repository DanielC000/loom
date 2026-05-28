import { CronExpressionParser } from "cron-parser";

/**
 * The next fire STRICTLY AFTER `from`, as an ISO string (phase-2 Pillar B). `cron` is a standard
 * 5-field expression. Throws on an invalid expression (callers surface this as a 400 / log + skip).
 * Strictly-after semantics matter: computing from a fire's own boundary yields the NEXT slot, so a
 * fired schedule's next_fire_at is always in the future (no double-fire on a back-to-back tick).
 */
export function nextFireAt(cron: string, from: Date): string {
  return CronExpressionParser.parse(cron, { currentDate: from }).next().toDate().toISOString();
}
