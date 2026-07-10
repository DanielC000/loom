// Friendly cron authoring model (Schedules UI redesign — card 1410f4fe, Direction B). A 5-field cron
// STAYS the storage contract (Schedule.cron); this is the layer that composes a cron FROM friendly
// controls and reads one BACK into a human summary. PURE + deterministic + never-throws, so both the
// web builder and the daemon (for a derived default schedule name) share ONE source of truth and can
// never disagree. The REAL next-fire computation is NOT here — it stays server-side (orchestration/
// cron.ts › nextFireAt) so the preview and the actual Scheduler use the identical matcher.

/** The friendly frequency a builder cron was composed from. "custom" == a hand-written raw cron. */
export type CronFrequency =
  | "hourly"
  | "everyNHours"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

/**
 * The builder's control state. `cronFromBuilder` projects this to a 5-field cron; `parseCronToBuilder`
 * is the (best-effort) inverse used to seed the builder when editing an existing schedule. Only the
 * fields relevant to the active `frequency` are read — the rest carry sensible defaults so switching
 * frequency never lands on an empty control.
 */
export interface CronBuilderState {
  frequency: CronFrequency;
  minute: number;       // 0–59 — "at minute" (hourly / every-N) and the minute of the time-of-day
  hour: number;         // 0–23 — time-of-day hour (daily / weekdays / weekly / monthly)
  interval: number;     // 2–23 — the N in "every N hours"
  daysOfWeek: number[]; // 0–6 (Sun–Sat) — selected days for "weekly"
  dayOfMonth: number;   // 1–31 — day-of-month for "monthly"
  raw: string;          // the verbatim expression for "custom"
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const DEFAULT_CRON = "0 9 * * *"; // every day at 9:00 AM — the friendly starting point

/** A fresh builder state (every-day-at-9 by default), used to seed a new schedule's builder. */
export function defaultBuilderState(): CronBuilderState {
  return { frequency: "daily", minute: 0, hour: 9, interval: 2, daysOfWeek: [1], dayOfMonth: 1, raw: DEFAULT_CRON };
}

const clampInt = (n: number, lo: number, hi: number, fallback: number): number => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
};

/** Compose a 5-field cron string from the builder state for the active frequency. Always returns a
 *  syntactically well-formed 5-field expression (except "custom", which passes the raw text through). */
export function cronFromBuilder(s: CronBuilderState): string {
  const m = clampInt(s.minute, 0, 59, 0);
  const h = clampInt(s.hour, 0, 23, 9);
  switch (s.frequency) {
    case "hourly":
      return `${m} * * * *`;
    case "everyNHours":
      return `${m} */${clampInt(s.interval, 2, 23, 2)} * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      // Sort + dedupe the selected days; fall back to Monday so an empty selection never emits "* * * *  ".
      const days = Array.from(new Set(s.daysOfWeek.map((d) => clampInt(d, 0, 6, 1)))).sort((a, b) => a - b);
      return `${m} ${h} * * ${(days.length ? days : [1]).join(",")}`;
    }
    case "monthly":
      return `${m} ${h} ${clampInt(s.dayOfMonth, 1, 31, 1)} * *`;
    case "custom":
      return s.raw.trim();
  }
}

const two = (n: number): string => String(n).padStart(2, "0");

/** "9:00 AM" for a 24h hour + minute. */
function timeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${two(minute)} ${period}`;
}

/** "1st" / "2nd" / "3rd" / "21st" … for a day-of-month. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const isNum = (f: string): boolean => /^\d+$/.test(f);

/**
 * Read a 5-field cron BACK into a human summary ("Every weekday at 9:00 AM"). Best-effort: recognizes
 * exactly the shapes `cronFromBuilder` emits; anything it doesn't recognize returns the raw expression
 * VERBATIM (so a hand-written custom cron reads as itself, never a wrong guess). Never throws.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron.trim();
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];

  // Hourly / every-N-hours: a fixed minute, wild-card day/month/dow.
  if (isNum(min) && dom === "*" && mon === "*" && dow === "*") {
    const m = Number(min);
    if (hour === "*") return `Every hour at :${two(m)}`;
    const everyN = /^\*\/(\d+)$/.exec(hour);
    if (everyN) return `Every ${everyN[1]} hours at :${two(m)}`;
    if (isNum(hour)) return `Every day at ${timeOfDay(Number(hour), m)}`;
  }

  // Time-of-day on specific weekdays.
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*") {
    const at = timeOfDay(Number(hour), Number(min));
    if (dow === "1-5") return `Every weekday at ${at}`;
    if (/^[0-6](,[0-6])*$/.test(dow)) {
      const days = Array.from(new Set(dow.split(",").map(Number))).sort((a, b) => a - b);
      if (days.length === 7) return `Every day at ${at}`;
      return `Every ${days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
    }
  }

  // Monthly on a day-of-month.
  if (isNum(min) && isNum(hour) && isNum(dom) && mon === "*" && dow === "*") {
    return `Monthly on the ${ordinal(Number(dom))} at ${timeOfDay(Number(hour), Number(min))}`;
  }

  return cron.trim();
}

/**
 * Best-effort inverse of `cronFromBuilder`: detect which friendly frequency a stored cron was authored
 * as and seed the builder's controls from it. An expression that matches no known shape falls to
 * frequency:"custom" with `raw` set (so the raw-cron escape hatch owns it). Never throws.
 */
export function parseCronToBuilder(cron: string): CronBuilderState {
  const base = defaultBuilderState();
  const state: CronBuilderState = { ...base, frequency: "custom", raw: cron.trim() };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return state;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];

  if (isNum(min) && dom === "*" && mon === "*" && dow === "*") {
    const m = Number(min);
    if (hour === "*") return { ...base, frequency: "hourly", minute: m, raw: cron.trim() };
    const everyN = /^\*\/(\d+)$/.exec(hour);
    if (everyN) return { ...base, frequency: "everyNHours", minute: m, interval: clampInt(Number(everyN[1]), 2, 23, 2), raw: cron.trim() };
    if (isNum(hour)) return { ...base, frequency: "daily", minute: m, hour: Number(hour), raw: cron.trim() };
  }

  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*") {
    if (dow === "1-5") return { ...base, frequency: "weekdays", minute: Number(min), hour: Number(hour), raw: cron.trim() };
    if (/^[0-6](,[0-6])*$/.test(dow)) {
      const days = Array.from(new Set(dow.split(",").map(Number))).sort((a, b) => a - b);
      return { ...base, frequency: "weekly", minute: Number(min), hour: Number(hour), daysOfWeek: days, raw: cron.trim() };
    }
  }

  if (isNum(min) && isNum(hour) && isNum(dom) && mon === "*" && dow === "*") {
    return { ...base, frequency: "monthly", minute: Number(min), hour: Number(hour), dayOfMonth: Number(dom), raw: cron.trim() };
  }

  return state;
}
