/**
 * Secret redaction for `authenticated_request` responses. A target that echoes the injected credential
 * back TRANSFORMED (a 4xx page, a debug reflection) must not hand it to the calling agent. Three searches,
 * every one a linear literal search (KMP), so cost never depends on the secret's content:
 *
 *  1. DECODE-THEN-MATCH. The body is tokenized ONCE, left to right, into a stream of decoded characters, each
 *     remembering its source span: `%hh` (UTF-8, either hex case), `+` as a space, HTML named / decimal / hex
 *     entities, JSON `\uXXXX` (surrogate pairs join), `\/`, `\"`, `\\`. The secret is searched for in that
 *     stream, so ANY mix of styles inside one echo matches. A hit is mapped back to its source span.
 *  2. The exact secret, searched in the RAW body. A secret that itself contains `%41` or `\\` and is echoed
 *     verbatim is found here even though the decoder reads the same text as other characters.
 *  3. Base64 forms in the raw body: the whole secret (padded/unpadded, std/url alphabet) plus, for an embedded
 *     secret, the three alignment "cores" (see `base64Cores`).
 *
 *     The decoded search also runs over each SINGLE-scheme decode (%/+ only, HTML only, JSON only): the greedy
 *     mixed decoder can remove a match (a stray escape lead eats the secret's first chars; a secret holding an
 *     encoded-looking sequence echoed under a different transform), which a single-scheme view recovers.
 *
 * Spans from all searches are merged (overlapping AND adjacent spans become one marker) and replaced in one pass.
 *
 * @decision 742e8b02 — never weaken exact redaction. Double encoding, partial/truncated echoes and other
 * transforms are out of scope; do not extend this ad hoc. Do not re-introduce a length floor on the decoded
 * match or the whole-secret base64 forms (derived forms are never shorter than the exact secret). */

export const REDACTED = "[REDACTED]";

/**
 * Floor for the base64 alignment CORES only. A core is a fragment of the secret's base64 (the 1-2 boundary
 * chars that depend on neighbouring bytes are trimmed), so for a short secret it can be a few characters that
 * occur by chance in any unrelated base64 payload and would shred it. 8 chars = 48 bits: not found by chance
 * in a body. A secret whose core is shorter simply has no core needle (its whole-secret base64 forms still
 * apply, and those are as long as the exact secret, so they carry no floor).
 */
export const MIN_CORE_LEN = 8;

/** Wall-clock budget for ONE redact call (defence in depth: the search is linear, so this should never trip). */
export const REDACT_BUDGET_MS = 3000;

/** Thrown when a redact call exceeds its budget. The caller MUST withhold the unredacted text. */
export class RedactionBudgetExceeded extends Error {
  constructor() {
    super("redaction exceeded its time budget");
    this.name = "RedactionBudgetExceeded";
  }
}

/** Cap on zero padding accepted inside a numeric entity. */
const MAX_ENTITY_ZEROS = 16;
/** Significant digits accepted after the padding (0x10FFFF is 6 hex / 7 decimal digits). */
const MAX_ENTITY_DEC_DIGITS = 7;
const MAX_ENTITY_HEX_DIGITS = 6;

const HTML_NAMED: ReadonlyArray<readonly [string, number]> = [
  ["&amp;", 0x26], ["&lt;", 0x3c], ["&gt;", 0x3e], ["&quot;", 0x22], ["&apos;", 0x27],
];

const hexVal = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;

/** Every iteration-heavy loop calls this; it throws once the wall-clock budget is spent. */
type Tick = () => void;

interface Decoded {
  /** Decoded code points (a percent-encoded or invalid sequence that is not a character is -1: never matches). */
  cps: Int32Array;
  /** 1 where the decoded char came from a raw `+` (ambiguous: a plus or a form-encoded space). */
  rawPlus: Uint8Array;
  /** Source span [start, end) of each decoded char. */
  start: Int32Array;
  end: Int32Array;
  len: number;
  hasPlus: boolean;
}

const SCHEME_PCT = 1;
const SCHEME_HTML = 2;
const SCHEME_JSON = 4;
const SCHEME_ALL = SCHEME_PCT | SCHEME_HTML | SCHEME_JSON;

/**
 * Tokenize `text` ONCE into decoded chars plus an offset map back to the source. Each position does O(1) work
 * (entity zero padding and digits are bounded), so the whole pass is linear in the text.
 */
function decodeBody(text: string, tick: Tick, schemes: number): Decoded {
  const doPct = (schemes & SCHEME_PCT) !== 0;
  const doHtml = (schemes & SCHEME_HTML) !== 0;
  const doJson = (schemes & SCHEME_JSON) !== 0;
  const n = text.length;
  const cps = new Int32Array(n);
  const rawPlus = new Uint8Array(n);
  const start = new Int32Array(n);
  const end = new Int32Array(n);
  let len = 0;
  let hasPlus = false;
  const emit = (cp: number, s: number, e: number, plus = false): void => {
    // A low surrogate directly after a high one (literal or \u-escaped) is one astral character.
    if (len > 0 && cp >= 0xdc00 && cp <= 0xdfff && end[len - 1] === s) {
      const hi = cps[len - 1]!;
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cps[len - 1] = 0x10000 + ((hi - 0xd800) << 10) + (cp - 0xdc00);
        end[len - 1] = e;
        return;
      }
    }
    cps[len] = cp;
    start[len] = s;
    end[len] = e;
    if (plus) {
      rawPlus[len] = 1;
      hasPlus = true;
    }
    len++;
  };
  const pctByte = (i: number): number => {
    if (text.charCodeAt(i) !== 37) return -1;
    const h = hexVal(text.charCodeAt(i + 1));
    const l = hexVal(text.charCodeAt(i + 2));
    return h < 0 || l < 0 ? -1 : h * 16 + l;
  };

  let i = 0;
  while (i < n) {
    if ((i & 0x3fff) === 0) tick();
    const c = text.charCodeAt(i);
    if (c === 37 && doPct) { // %hh, possibly a multi-byte UTF-8 character
      const b0 = pctByte(i);
      if (b0 < 0) { emit(c, i, i + 1); i++; continue; }
      if (b0 < 0x80) { emit(b0, i, i + 3); i += 3; continue; }
      const need = b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 && b0 < 0xe0 ? 2 : 0;
      let cp = need === 4 ? b0 & 0x07 : need === 3 ? b0 & 0x0f : b0 & 0x1f;
      let ok = need > 0 && b0 < 0xf5;
      for (let k = 1; ok && k < need; k++) {
        const b = pctByte(i + 3 * k);
        if (b < 0 || (b & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (b & 0x3f);
      }
      if (ok) { emit(cp, i, i + 3 * need); i += 3 * need; } else { emit(-1, i, i + 3); i += 3; }
      continue;
    }
    if (c === 43 && doPct) { emit(43, i, i + 1, true); i++; continue; }
    if (c === 38 && doHtml) { // & entity
      let matched = false;
      if (text.charCodeAt(i + 1) === 35) {
        let j = i + 2;
        const hex = text.charCodeAt(j) === 120 || text.charCodeAt(j) === 88;
        if (hex) j++;
        let zeros = 0;
        while (zeros < MAX_ENTITY_ZEROS && text.charCodeAt(j) === 48) { j++; zeros++; }
        const maxDigits = hex ? MAX_ENTITY_HEX_DIGITS : MAX_ENTITY_DEC_DIGITS;
        let value = 0;
        let digits = 0;
        for (; digits < maxDigits; digits++) {
          const d = hexVal(text.charCodeAt(j + digits));
          if (d < 0 || (!hex && d > 9)) break;
          value = value * (hex ? 16 : 10) + d;
        }
        j += digits;
        if (text.charCodeAt(j) === 59 && (digits > 0 || zeros > 0) && value <= 0x10ffff) {
          emit(value, i, j + 1);
          i = j + 1;
          matched = true;
        }
      } else {
        for (const [name, cp] of HTML_NAMED) {
          if (text.startsWith(name, i)) { emit(cp, i, i + name.length); i += name.length; matched = true; break; }
        }
      }
      if (matched) continue;
    } else if (c === 92 && doJson) { // JSON escapes
      const nx = text.charCodeAt(i + 1);
      if (nx === 117) {
        const a = hexVal(text.charCodeAt(i + 2)), b = hexVal(text.charCodeAt(i + 3));
        const cc = hexVal(text.charCodeAt(i + 4)), d = hexVal(text.charCodeAt(i + 5));
        if (a >= 0 && b >= 0 && cc >= 0 && d >= 0) {
          emit((a << 12) | (b << 8) | (cc << 4) | d, i, i + 6);
          i += 6;
          continue;
        }
      } else if (nx === 47 || nx === 34 || nx === 92) {
        emit(nx, i, i + 2);
        i += 2;
        continue;
      }
    }
    emit(c, i, i + 1);
    i++;
  }
  return { cps, rawPlus, start, end, len, hasPlus };
}

/** KMP failure table. */
function failureTable(pat: Int32Array): Int32Array {
  const fail = new Int32Array(pat.length);
  for (let i = 1, k = 0; i < pat.length; i++) {
    while (k > 0 && pat[i] !== pat[k]) k = fail[k - 1]!;
    if (pat[i] === pat[k]) k++;
    fail[i] = k;
  }
  return fail;
}

/** Linear KMP: calls `hit(endExclusive)` for every occurrence of `pat` (overlaps included) in text[0, len). */
function kmpAll(text: Int32Array, len: number, pat: Int32Array, fail: Int32Array, tick: Tick, hit: (endExclusive: number) => void): void {
  const m = pat.length;
  if (m === 0) return;
  for (let i = 0, k = 0; i < len; i++) {
    if ((i & 0x3fff) === 0) tick();
    const c = text[i]!;
    while (k > 0 && c !== pat[k]) k = fail[k - 1]!;
    if (c === pat[k]) k++;
    if (k === m) {
      hit(i + 1);
      k = fail[k - 1]!;
    }
  }
}

const unitsOf = (s: string): Int32Array => {
  const out = new Int32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * Base64 "cores" of `secret` for an EMBEDDED secret: base64 of the bytes at stream offset 0, 1 and 2 (mod 3),
 * keeping only the characters whose six bits all come from secret bytes (the first and last 1-2 characters
 * mix in neighbouring bytes, so they are trimmed). Both alphabets. Cores shorter than `MIN_CORE_LEN` dropped.
 */
export function base64Cores(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const out = new Set<string>();
  for (let offset = 0; offset < 3; offset++) {
    const s = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    const core = s.slice(start, end);
    if (core.length < MIN_CORE_LEN) continue;
    out.add(core);
    out.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...out];
}

/** The whole-secret base64 forms (padded and unpadded, standard and url alphabet), longest first. */
function base64Whole(secret: string): string[] {
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const url = b64.replace(/\+/g, "-").replace(/\//g, "_");
  return [...new Set([b64, url, b64.replace(/=+$/, ""), url.replace(/=+$/, "")])].sort((a, b) => b.length - a.length);
}

interface Needle { pat: Int32Array; fail: Int32Array }
const needleOf = (pat: Int32Array): Needle => ({ pat, fail: failureTable(pat) });

/**
 * Build a redactor for `secret`. Needles and failure tables are built ONCE; each call is: one decode pass, then
 * one KMP pass per needle (decoded stream: the secret; raw text: the exact secret and the base64 forms). Cost is
 * O(text x needles) whatever the secret's content. Throws `RedactionBudgetExceeded` past `budgetMs`: the caller
 * must then withhold the text, never return it unredacted.
 */
export function buildSecretRedactor(secret: string | undefined, budgetMs: number = REDACT_BUDGET_MS): (text: string) => string {
  if (!secret) return (text) => text;
  const secretCps = needleOf(Int32Array.from([...secret].map((ch) => ch.codePointAt(0)!)));
  const rawNeedles: Needle[] = [
    ...new Set([secret, ...base64Whole(secret), ...base64Cores(secret)]),
  ].map((s) => needleOf(unitsOf(s)));
  const hasSpace = secret.includes(" ");
  const hasPlus = secret.includes("+");

  return (text: string): string => {
    if (!text) return text;
    const deadline = performance.now() + budgetMs;
    const tick: Tick = () => { if (performance.now() > deadline) throw new RedactionBudgetExceeded(); };
    // Coverage of SOURCE offsets as a difference array: overlapping spans merge for free, no sort.
    const diff = new Int32Array(text.length + 1);
    let marked = false;
    const mark = (s: number, e: number): void => { diff[s] = diff[s]! + 1; diff[e] = diff[e]! - 1; marked = true; };

    // 2+3. Raw text: the exact secret and the base64 forms are plain literals.
    const units = unitsOf(text);
    for (const nd of rawNeedles) {
      kmpAll(units, units.length, nd.pat, nd.fail, tick, (e) => mark(e - nd.pat.length, e));
    }

    // 1. Decoded stream: the secret through %hh / entity / JSON decoding, mapped back to source spans.
    const searchDecoded = (dec: Decoded): void => {
      const search = (view: Int32Array): void => {
        kmpAll(view, dec.len, secretCps.pat, secretCps.fail, tick, (e) => mark(dec.start[e - secretCps.pat.length]!, dec.end[e - 1]!));
      };
      // A raw `+` is a literal plus or a form-encoded space. Search it as a plus; if the secret has a space, also
      // as a space (two views are needed only when the secret holds BOTH, otherwise one view is exact).
      if (!dec.hasPlus || !hasSpace) {
        search(dec.cps);
      } else {
        if (hasPlus) search(dec.cps);
        const view = dec.cps.slice(0, dec.len);
        for (let i = 0; i < dec.len; i++) if (dec.rawPlus[i]) view[i] = 32;
        search(view);
      }
    };
    // The mixed decode (every scheme at once), then each scheme ALONE. The greedy mixed decoder can REMOVE a
    // match: a stray lead (`%4A` before `b\/`) eats the secret's first chars, and a secret that itself holds an
    // encoded-looking sequence is mangled by a scheme the echo did not use. A single-scheme decode leaves the
    // other schemes' sequences literal, so those shapes still match. A scheme whose lead character is absent
    // decodes identically to the raw pass, so it is skipped.
    searchDecoded(decodeBody(text, tick, SCHEME_ALL));
    const single: Array<readonly [number, boolean]> = [
      [SCHEME_PCT, text.includes("%") || text.includes("+")],
      [SCHEME_HTML, text.includes("&")],
      [SCHEME_JSON, text.includes("\\")],
    ];
    for (const [scheme, present] of single) {
      if (present) searchDecoded(decodeBody(text, tick, scheme));
    }

    if (!marked) return text;
    // One pass over the coverage; every maximal covered run becomes one marker.
    let out = "";
    let pos = 0;
    let depth = 0;
    let runStart = -1;
    for (let i = 0; i <= text.length; i++) {
      if ((i & 0x3fff) === 0) tick();
      const before = depth;
      depth += diff[i]!;
      if (before === 0 && depth > 0) runStart = i;
      else if (before > 0 && depth === 0) { out += text.slice(pos, runStart) + REDACTED; pos = i; }
    }
    return out + text.slice(pos);
  };
}
