/**
 * Shared ESC/C0/C1 control-byte classification — the SAME byte classes `pty/host.ts`'s
 * `stripEscapeAndControlChars` strips at the `submit()`/`submitCodex()` chokepoint. See that fix's own
 * record, docs/decisions/49b382d9-strip-esc-c0-c1-at-submit-chokepoint.md, for why. That fix closes the
 * real-time terminal-write breakout; this module is the shared primitive so a write-time API boundary
 * (e.g. project memory) can classify/reject the SAME byte classes instead of keeping a second,
 * independently-drifting copy of the regex.
 *
 * `\t \n \r` are ordinary multi-line text and are NEVER classified as violations here, matching
 * `stripEscapeAndControlChars`'s own carve-out.
 *
 * Pure + db/fs-free, mirroring `security/lockout.ts`'s own posture.
 */

export type ControlByteClass = "ESC" | "C0" | "C1";

/** C0 (excl. \t \n \r) + ESC + C1 — identical byte range to `pty/host.ts`'s prior private `ESC_C0_C1_RE`
 *  (now re-exported from here — host.ts imports it rather than keeping its own copy). Do not widen to
 *  also cover 0x7F (DEL) or reuse a `\t`/`\n`/`\r`-stripping regex here — see 49b382d9's record. */
export const ESC_C0_C1_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\x9F]/g;

function classify(codePoint: number): ControlByteClass {
  if (codePoint === 0x1b) return "ESC";
  if (codePoint <= 0x1f) return "C0";
  return "C1";
}

export interface StripEscapeAndControlCharsResult {
  text: string;
  stripped: boolean;
  escCount: number;
  c0Count: number;
  c1Count: number;
}

/** Strip every ESC/C0(excl. \t\n\r)/C1 byte from `text`, returning the cleaned text plus per-class byte
 *  counts. A caller with nothing to strip gets an identical string back (`stripped: false`). */
export function stripEscapeAndControlChars(text: string): StripEscapeAndControlCharsResult {
  let escCount = 0;
  let c0Count = 0;
  let c1Count = 0;
  const cleaned = text.replace(ESC_C0_C1_RE, (ch) => {
    const cls = classify(ch.charCodeAt(0));
    if (cls === "ESC") escCount++;
    else if (cls === "C0") c0Count++;
    else c1Count++;
    return "";
  });
  return { text: cleaned, stripped: cleaned !== text, escCount, c0Count, c1Count };
}

export interface ControlCharViolation {
  byteClass: ControlByteClass;
  /** 0-based character index into `text` — never the byte content itself. */
  index: number;
  /** The raw code point, for diagnostics only — never rendered back as a character or excerpt. */
  codePoint: number;
}

/** Find the FIRST ESC/C0/C1 violation in `text`, or `null` if clean. Reports only the byte class + a
 *  position — deliberately never echoes the surrounding content, so a caller can build a loud,
 *  position-specific rejection message without re-displaying (or logging) the offending bytes. */
export function findControlCharViolation(text: string): ControlCharViolation | null {
  // Global regexes are stateful (`lastIndex`); never trust a prior call's leftover position.
  ESC_C0_C1_RE.lastIndex = 0;
  const match = ESC_C0_C1_RE.exec(text);
  ESC_C0_C1_RE.lastIndex = 0;
  if (!match) return null;
  const codePoint = match[0].charCodeAt(0);
  return { byteClass: classify(codePoint), index: match.index, codePoint };
}
