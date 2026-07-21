/**
 * Local + server-now anchoring for schedule/wake tool results (card 6cef30d5). A schedule/wake tool
 * result has always spoken pure UTC ISO against local-time cron/wake semantics, and none of them said
 * what time the SERVER itself thinks "now" is. That's the confirmed root of two independent Platform
 * Lead time-confusions: a retracted "cron ratchet" bug filed off assumed wall-clock times (all recompute
 * sites were provably correct — the human misread the UTC timestamp against local intuition), and a
 * wake_me rejection mislabeled "ISO-Z parsed as local" when the wakeAt was genuinely ~1h in the past at
 * call time (the error carried no server-now to check it against). These helpers ADD a local rendering
 * alongside each existing UTC field, plus a server-now stamp (both forms) — additive only, on both the
 * success AND error shapes, so a repro built from any result is self-timestamped. Never rename or
 * remove an existing field.
 */

/** Render an ISO instant in the SERVER's own local timezone, human-readable. */
export function localTimeString(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { timeZoneName: "short" });
}

/** The server-now stamp, both UTC and local — echoed onto every schedule/wake tool result. */
export function nowEcho(now: Date = new Date()): { now: string; nowLocal: string } {
  const iso = now.toISOString();
  return { now: iso, nowLocal: localTimeString(iso) };
}

/**
 * Decorate a schedule-shaped result with `nextFireAtLocal` (+ `lastFiredAtLocal` when set) alongside
 * the existing UTC fields, plus the server-now stamp. Additive: every input field survives untouched.
 */
export function withScheduleTimeEcho<T extends { nextFireAt: string; lastFiredAt?: string | null }>(
  schedule: T,
  now: Date = new Date(),
): T & { nextFireAtLocal: string; lastFiredAtLocal?: string; now: string; nowLocal: string } {
  return {
    ...schedule,
    nextFireAtLocal: localTimeString(schedule.nextFireAt),
    ...(schedule.lastFiredAt ? { lastFiredAtLocal: localTimeString(schedule.lastFiredAt) } : {}),
    ...nowEcho(now),
  };
}

/**
 * Decorate a wake-shaped result (`{ wakeAt }` or a full `Wake` row) with `wakeAtLocal` alongside the
 * existing UTC field, plus the server-now stamp. Additive.
 */
export function withWakeTimeEcho<T extends { wakeAt: string }>(
  wake: T,
  now: Date = new Date(),
): T & { wakeAtLocal: string; now: string; nowLocal: string } {
  return { ...wake, wakeAtLocal: localTimeString(wake.wakeAt), ...nowEcho(now) };
}
