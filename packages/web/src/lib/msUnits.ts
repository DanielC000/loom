// The pure, JSX-free ms ⇄ human-unit helpers behind every timing field in the Settings page (card
// 0a5d61c9 extracted them from Settings.tsx so they can be unit-tested; see test/ms-units.mjs). A Loom
// timing config value is ALWAYS canonical milliseconds on the wire and in the DB; a form shows it in a
// human unit (s/m/h). These are the only two directions that conversion is allowed to happen in.
import type { MsBounds } from "@loom/shared";

export type Unit = "s" | "m" | "h";
export const UNIT_MS: Record<Unit, number> = { s: 1000, m: 60000, h: 3600000 };

/** Canonical ms → display string in `unit` (÷). undefined → "" (inherit/blank). */
export function msStr(v: number | undefined, unit: Unit): string {
  return v === undefined ? "" : String(v / UNIT_MS[unit]);
}

// The ONE user-string to canonical-ms conversion in the web package. EVERY timing field routes through
// it: Settings' applyMs, the Global/Daemon grid, the connections + telemetry/update cadences, the
// poll-job interval, and msRangeError below.
//
// @decision 0a5d61c9 — never convert a user-entered value with a bare `Number(s) * UNIT_MS[unit]`: the
// unrounded product is a float, and every server-side ms validator is `.int()`.
//
// `16.1 * 1000` is 16100.000000000002 in IEEE-754, so a perfectly reasonable "16.1" in a seconds field
// came back as a 400 "Expected integer". Math.round leaves NaN/±Infinity untouched, so every call site's
// `Number.isFinite(n) ? n : s` non-finite guard still routes a junk entry through as the original string.
// A blank string is NOT handled here (`Number("")` is 0) — every caller trim-checks blank first, because
// blank means "inherit the default", which is a clear, not a zero.
export function msFromUnit(s: string, unit: Unit): number {
  return Math.round(Number(s) * UNIT_MS[unit]);
}

// --- ms-bound translation (state the schema's limit in the FIELD'S OWN unit) ---------------------
//
// Card 48365fda. An MsField is labelled and entered in a human unit (s/m/h) but stores canonical ms, so
// the server's own rejection quoted the raw MILLISECOND bound into a field measured in seconds: typing
// `2000` into "Gate command timeout (s)" sent 2_000_000 and came back "expected number to be <=1800000"
// (the gate ceiling AT THE TIME — since raised to 3_600_000 by card fc8aa167; this incident's own numbers
// are historical and no longer track the live bound, read live from ORCHESTRATION_TIMEOUT_MS_BOUNDS).
// The rejection was CORRECT — the true ceiling was 1800s at the time — but there was no way to derive that
// from the message. Two different project owners read it as a broken validator on the same night.
//
// Fix: divide the shared bound by the field's own unit and both (a) show the range up front and (b) catch
// an out-of-range entry client-side, so the raw-ms server error is never the thing the user reads.

/** A canonical-ms bound rendered in `unit` — e.g. 1_800_000 in "s" → "1800s", 500 in "s" → "0.5s". */
export function msInUnit(ms: number, unit: Unit): string {
  return `${ms / UNIT_MS[unit]}${unit}`;
}

/** The always-on range hint shown under a bounded MsField, in the field's own unit. */
export function msRangeHint(b: MsBounds, unit: Unit): string {
  return `min ${msInUnit(b.min, unit)} · max ${msInUnit(b.max, unit)}`;
}

// Validate an MsField entry (a string in `unit`) against its canonical-ms bounds, returning the error
// STATED IN `unit` — or null when there is nothing to report. Blank is always fine (blank = inherit the
// default). A non-numeric entry is deliberately NOT claimed here: the existing NaN→null→strict-zod path
// already 400s it readably, and inventing a range message for "abc" would be the wrong complaint.
export function msRangeError(value: string, unit: Unit, b: MsBounds | undefined): string | null {
  if (!b || value.trim() === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  // Rounded through the SAME helper every submit path uses, so this check and the server can never
  // disagree about a value sitting exactly on a bound (card 0a5d61c9).
  const ms = msFromUnit(value, unit);
  if (ms < b.min || ms > b.max) return `must be between ${msInUnit(b.min, unit)} and ${msInUnit(b.max, unit)}`;
  return null;
}

/** Every bounded MsField on one form, reduced to the messages that must BLOCK its Save. Each entry is
 *  [field label, current form value, the field's display unit, its shared canonical-ms bounds]. */
export function msRangeErrors(fields: readonly (readonly [string, string, Unit, MsBounds])[]): string[] {
  return fields
    .map(([label, value, unit, b]) => { const e = msRangeError(value, unit, b); return e ? `${label} ${e}` : null; })
    .filter((e): e is string => e !== null);
}
