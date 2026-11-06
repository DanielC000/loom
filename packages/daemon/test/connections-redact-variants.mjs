import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 742e8b02 — `authenticated_request` must redact TRANSFORMED echoes of the injected credential, not only the
// exact string. Hermetic: temp LOOM_HOME, real Db + envelope key, the only sockets are loopback servers this file
// opens. A REAL http server reads the credential Loom actually injected and echoes it back in each encoding (body,
// a header, and `location` on a 302); the test's own encoders below are written independently of redact.ts.
//   A. unit: the variant set (distinctness, min length, longest first, bounded count, cost).
//   B. request, https path (injected fetch that really talks to the loopback server): X-API-Key, a custom header,
//      bearer, oauth2 x every encoding x body/header/location. Positive control: the raw echo DOES contain it.
//   C. request, pinned plain-http path (lanHttp.ts, real node:http adapter): api-key, custom header, bearer.
//   D. short-secret over-redaction: exact still redacted, short derived forms are not.
// Run: 1) build (turbo builds shared first), 2) node test/connections-redact-variants.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-redact-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "47391"; // the daemon's "own" port, never the loopback test server's

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createConnection, createOAuthConnection, saveOAuthTokens } = await import("../dist/connections/store.js");
const { performAuthenticatedRequest, __resetConnectionsRateLimitState } = await import("../dist/connections/request.js");
const redactMod = await import("../dist/connections/redact.js");
const { buildSecretRedactor, REDACTED } = redactMod;
// Needle-shape probes are skipped (not failed) if the module has no such export, so this file can run RED against
// an older redact.ts for the behavioural cases.
const base64Cores = redactMod.base64Cores ?? (() => []);

// 31 bytes (=> '==' of base64 padding), every char class the encoders treat specially, and a base64 form that
// contains '+' and '/' (so base64url differs from base64).
const SECRET = `Ab3/x+y z&q<r>?>"s'=Zk9~!*(t)7Q`;
const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 100_000, rateLimitMax: 100_000, rateLimitWindowMs: 60_000 };

// --- independent encoders (deliberately NOT sharing code with redact.ts) ---
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => b64(s).replace(/\+/g, "-").replace(/\//g, "_");
const FORMS = {
  exact: (s) => s,
  pct_upper: (s) => encodeURIComponent(s),
  pct_lower: (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  pct_strict: (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()),
  form_plus: (s) => new URLSearchParams({ k: s }).toString().slice(2),
  html_named: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  html_apos: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
  html_dec: (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  html_hex: (s) => s.replace(/[&<>"']/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`),
  html_hex_upper: (s) => s.replace(/[&<>"']/g, (c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`),
  json: (s) => JSON.stringify(s).slice(1, -1),
  json_slash: (s) => JSON.stringify(s).slice(1, -1).replace(/\//g, "\\/"),
  json_htmlsafe: (s) => JSON.stringify(s).slice(1, -1).replace(/[<>&]/g, (c) => "\\u00" + c.charCodeAt(0).toString(16)),
  b64: (s) => b64(s),
  b64_unpadded: (s) => b64(s).replace(/=+$/, ""),
  b64url: (s) => b64url(s),
  b64url_unpadded: (s) => b64url(s).replace(/=+$/, ""),
};

// Test sanity (a check that could fail): every non-exact form must really differ from the exact secret, and the
// base64 forms must exercise padding and the url-safe alphabet; otherwise a "never leaks" result proves nothing.
{
  const exactForms = Object.entries(FORMS).filter(([n, f]) => n !== "exact" && f(SECRET) === SECRET).map(([n]) => n);
  check(`sanity: no encoding collapses to the exact secret (collapsed: ${exactForms.join(",") || "none"})`, exactForms.length === 0);
  check("sanity: padded base64 ends in '=' and differs from unpadded", FORMS.b64(SECRET).endsWith("=") && FORMS.b64(SECRET) !== FORMS.b64_unpadded(SECRET));
  check("sanity: base64url differs from base64 (secret exercises + or /)", FORMS.b64(SECRET) !== FORMS.b64url(SECRET));
  check("sanity: the secret contains a space (form_plus differs from pct_upper)", FORMS.form_plus(SECRET) !== FORMS.pct_upper(SECRET));
}

// ============ A. variants ============
{
  const red = buildSecretRedactor(SECRET);
  const unredacted = Object.keys(FORMS).filter((n) => red(`pre ${FORMS[n](SECRET)} post`) !== `pre ${REDACTED} post`);
  check(`A: every independently-encoded form is removed whole (not removed: ${unredacted.join(",") || "none"})`, unredacted.length === 0);

  // --- percent / HTML / JSON styles the five fixed conventions missed (each probe: independent encoder, in-test) ---
  const PS = "sk_live/Ab+Cd=Ef/9xQ2";
  const pyQuote = (s) => encodeURIComponent(s).replace(/%2F/g, "/"); // Python urllib.parse.quote(safe='/')
  const mixedHex = (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m, i) => (i % 2 ? m.toLowerCase() : m));
  const partialPct = (s) => s.replace(/[+=]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const probes = {
    "python quote(safe='/'): sk_live/Ab%2BCd%3DEf/9xQ2": [PS, pyQuote(PS)],
    "mixed-case percent hex": [PS, mixedHex(PS)],
    "partial percent-encoding (only + and =)": [PS, partialPct(PS)],
    "space as %20 / + / literal inside one echo": ["a b c d", "a%20b+c d"],
    "PHP &#039;": [`it's "ok" <b>&</b>Zq8`, `it&#039;s &quot;ok&quot; &lt;b&gt;&amp;&lt;/b&gt;Zq8`],
    "Python html.escape &quot; + &#x27;": [`it's "ok" <b>&</b>Zq8`, `it&#x27;s &quot;ok&quot; &lt;b&gt;&amp;&lt;/b&gt;Zq8`],
    "Go/markupsafe &#34; &#39; beside &amp;": [`it's "ok" <b>&</b>Zq8`, `it&#39;s &#34;ok&#34; &lt;b&gt;&amp;&lt;/b&gt;Zq8`],
    "text-only escaper (& < > only)": [`it's "ok" <b>&</b>Zq8`, `it's "ok" &lt;b&gt;&amp;&lt;/b&gt;Zq8`],
    "zero-padded numeric entity + uppercase hex entity": [`it's "ok"Zq8`, `it&#00039;s &#X22;ok&#x22;Zq8`],
    "JSON \\/ and \\uXXXX mixed case beside plain": ["a/b<c'dZq8", "a\\/b\\u003Cc\\u0027dZq8"],
    "JSON \\u003c lowercase": ["a<b>Zq8x", "a\\u003cb\\u003eZq8x"],
  };
  for (const [name, [secret, echo]] of Object.entries(probes)) {
    check(`A: probe — ${name}: positive control (echo differs from secret) and the echo is redacted whole`,
      echo !== secret && buildSecretRedactor(secret)(`x ${echo} y`) === `x ${REDACTED} y`);
  }
  // Over-redaction: the needle is case-EXACT for literal chars (hex case-insensitivity applies only to escapes).
  check("A: a secret matches only its own letter case (no 'i' flag leak)", buildSecretRedactor("Qx7Lm2")("qx7lm2 QX7LM2 Qx7Lm2") === `qx7lm2 QX7LM2 ${REDACTED}`);
  check("A: a 1-char-per-escape look-alike that is not the secret survives", buildSecretRedactor("a'b")("a&#38;b a%27c") === "a&#38;b a%27c");

  // --- base64: the secret embedded at any alignment, plus Basic ---
  const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  const rnd = lcg(7);
  const bytesOf = (n) => Buffer.from(Array.from({ length: n }, rnd));
  const embedFails = [];
  for (const len of [24, 25, 26, 31, 32, 33]) { // each residue mod 3 twice
    const secret = Array.from({ length: len }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[(i * 7 + len) % 62]).join("");
    const r = buildSecretRedactor(secret);
    for (const off of [0, 1, 2]) {
      for (const [alpha, enc] of [["std", (b) => b.toString("base64")], ["url", (b) => b.toString("base64url")]]) {
        const blob = enc(Buffer.concat([bytesOf(30 + off), Buffer.from(secret), bytesOf(29 + off)]));
        const out = r(blob);
        if (!out.includes(REDACTED)) embedFails.push(`len${len}%3=${len % 3}/off${off}/${alpha}`);
        // independent leak check: any 12-char window of the secret's own base64 at this alignment must not survive.
        const aligned = enc(Buffer.concat([Buffer.alloc(off), Buffer.from(secret)]));
        const win = aligned.slice(Math.ceil((off * 8) / 6) + 1, Math.ceil((off * 8) / 6) + 13);
        if (out.includes(win)) embedFails.push(`len${len}/off${off}/${alpha}:window-leak`);
      }
    }
  }
  check(`A: a len%3=0/1/2 secret embedded at byte offsets 0/1/2 of a larger payload (std+url) is redacted (failures: ${embedFails.join(",") || "none"})`, embedFails.length === 0);
  {
    const secret = "Zk9-Pq2_Lm4xTr7vWn3";
    const r = buildSecretRedactor(secret);
    const basic = Buffer.from("user:" + secret).toString("base64");
    const out = r(`Authorization: Basic ${basic}`);
    check("A: Basic base64(user:secret) is redacted (the secret's own base64 core no longer appears)", out.includes(REDACTED) && !out.includes(Buffer.from("user:" + secret).toString("base64").slice(4, -4)));
    const bearer = Buffer.from("Bearer " + secret).toString("base64");
    check("A: base64('Bearer <secret>') is redacted", r(`t=${bearer}`).includes(REDACTED) && !r(`t=${bearer}`).includes(bearer.slice(6, -4)));
    check("A: core needles are real (>= 8 chars) for this secret", base64Cores(secret).length >= 3 &&base64Cores(secret).every((c) => c.length >= 8));
  }
  {
    // Floor: a short secret's trimmed cores would be < 8 chars — those cores are dropped so ordinary base64 text survives.
    const short = "Zx9Kq2";
    const cores = base64Cores(short);
    check("A: cores shorter than 8 chars are dropped for a short secret; every kept core is >= 8", cores.every((c) => c.length >= 8) && cores.length < 6);
    const r = buildSecretRedactor("ab");
    check("A: a 2-byte secret has no core needle, so base64 text unrelated to the exact secret is untouched", base64Cores("ab").length === 0 && r("QUJDREVGR0g= cafe") === "QUJDREVGR0g= cafe");
  }

  // --- adversarial bodies: linear, no catastrophic backtracking ---
  {
    const adv = buildSecretRedactor("'''''''''''''''''''''''''''&&&&&&&&&&&&&&&&&&&&&&&&&&&   %%%%%%%%%%%%%%%%%%%%'");
    const bodies = {
      "&#0 x 1M": "&#" + "0".repeat(1_000_000),
      "&amp; x 200k": "&amp;".repeat(200_000),
      "% x 1M": "%".repeat(1_000_000),
      "&#39;&#39;... x 100k then a break": "&#39;".repeat(100_000) + "x",
      "quote ladder": "'&#x27;%27&apos;".repeat(60_000),
      "spaces/plus/%20 mix": " +%20".repeat(200_000),
    };
    for (const [name, body] of Object.entries(bodies)) {
      const t = performance.now();
      adv(body);
      const ms = performance.now() - t;
      check(`A: adversarial body (${name}, ${(body.length / 1e6).toFixed(1)} MB) redacts in < 3s (${ms.toFixed(0)}ms)`, ms < 3000);
    }
  }
  // --- adversarial SECRET/body pairs: cost must not depend on the secret's content (card 742e8b02 round 3) ---
  // Negative control (measured on the pre-fix per-char regex, same shapes): hostile backslash run n=20 took 1.9 s
  // (exponential, 34 s at n=24); truncated JSON echo n=20 139 ms; periodic "a"x1023+"b" vs 200 KB of "a" took 14 s.
  // New design, solo: every case below 160 ms per MB. Bound = ~5x the slowest solo run, for a loaded host.
  {
    const BOUND_MS = 750;
    const bs = (n) => "\\".repeat(n);
    const timed = (secret, body) => {
      const r = buildSecretRedactor(secret);
      const t = performance.now();
      const out = r(body);
      return { ms: performance.now() - t, out };
    };
    const cases = {
      "hostile: 24 backslashes + Q vs 48 backslashes": [bs(24) + "Q", bs(48)],
      "hostile: 4096 backslashes + Q vs 1 MB of backslashes": [bs(4096) + "Q", bs(1_000_000)],
      "truncated JSON echo: 22 backslashes + Q vs its escaped form minus Q": [bs(22) + "Q", bs(44)],
      "periodic: 'a'x4095 + 'b' vs 1 MB of 'a'": ["a".repeat(4095) + "b", "a".repeat(1_000_000)],
      "mixed %25/&amp;/&#38; periodic secret vs 1 MB": ["%&".repeat(2048) + "x", "%25&amp;%25&#38;".repeat(62_500)],
      "all-match: 'a' vs 1 MB of 'a'": ["a", "a".repeat(1_000_000)],
    };
    for (const [name, [secret, body]] of Object.entries(cases)) {
      const { ms, out } = timed(secret, body);
      check(`A: adversarial secret — ${name}: ${(body.length / 1e6).toFixed(2)} MB in < ${BOUND_MS}ms (${ms.toFixed(0)}ms)`, ms < BOUND_MS);
      if (!name.startsWith("all-match")) check(`A: adversarial secret — ${name}: near-miss body (no real secret) is returned unchanged`, out === body);
    }
    // The real hits still land on these shapes (a bound alone would pass a redactor that does nothing).
    check("A: hostile shape, real hit: the JSON-escaped (doubled) backslash run + Q is redacted whole", buildSecretRedactor(bs(24) + "Q")(`x${bs(48)}Qy`) === `x${REDACTED}y`);
    check("A: periodic shape, real hit is redacted", buildSecretRedactor("a".repeat(40) + "b")("a".repeat(100) + "b!") === "a".repeat(60) + REDACTED + "!");
    check("A: mixed-encoding periodic secret, real hit is redacted", buildSecretRedactor("%&".repeat(20) + "x")(`<${"%25&amp;%25&#38;".repeat(10)}x>`) === `<${REDACTED}>`);
    // Self-overlapping secret: every overlapping hit is covered, none left over.
    check("A: overlapping hits of a self-overlapping secret merge into one marker", buildSecretRedactor("aba")("xababay") === `x${REDACTED}y`);
    // Ambiguity: a literal secret that itself looks encoded, echoed verbatim, is still found (raw exact pass).
    check("A: a secret containing '%41' echoed verbatim is redacted", buildSecretRedactor("k%41z9")("t=k%41z9;") === `t=${REDACTED};`);
    check("A: a secret containing '\\\\' echoed verbatim is redacted", buildSecretRedactor("k\\\\z9")("t=k\\\\z9;") === `t=${REDACTED};`);
    check("A: a secret containing '&amp;' echoed verbatim is redacted", buildSecretRedactor("k&amp;z9")("t=k&amp;z9;") === `t=${REDACTED};`);
    // The decoder reads a literal '%41' as 'A': that only ADDS redaction around a real hit.
    check("A: a body holding '%41' decodes to 'A' for the secret 'A9q' (extra redaction, never less)", buildSecretRedactor("A9q")("%419q") === REDACTED);
    // '+' is ambiguous (plus or form-encoded space): both readings work, one consistent reading per echo.
    check("A: secret 'a b+c': '+' as space with %2B plus, and %20 space with literal '+'", buildSecretRedactor("a b+c")("[a+b%2Bc][a%20b+c]") === `[${REDACTED}][${REDACTED}]`);
    // Astral characters: \u surrogate pair, UTF-8 percent bytes, literal, and a mix.
    {
      const r = buildSecretRedactor("k\u{1F600}z9");
      check("A: astral secret char: \\u pair, %F0%9F%98%80, literal and mixed forms are all redacted",
        ["k\\ud83d\\ude00z9", "k%F0%9F%98%80z9", "k\u{1F600}z9", "k\ud83d\\ude00z9", "k%f0%9f%98%80z9"].every((f) => r(`<${f}>`) === `<${REDACTED}>`));
    }
    // Single-scheme views (card 742e8b02 round 4): the greedy MIXED decoder can remove a match. (a) a stray escape
    // lead right before a transformed echo eats the secret's first chars; (b) a secret holding an encoded-looking
    // sequence, echoed under a DIFFERENT transform that leaves that sequence alone. Each is redacted via the
    // JSON-only (or HTML-only / %-only) decode; each near-miss (one char off) must come back unchanged.
    {
      const bodyOnly = (secret, body) => buildSecretRedactor(secret)(body);
      check("A: stray '%4A' lead before a JSON-slash echo: secret '4Ab/cd9' in 'x%4Ab\\/cd9y'", bodyOnly("4Ab/cd9", "x%4Ab\\/cd9y") === `x%${REDACTED}y`);
      check("A: stray '&#65;' lead before a JSON-slash echo: secret '65;q/z' in '&#65;q\\/z'", bodyOnly("65;q/z", "&#65;q\\/z") === `&#${REDACTED}`);
      check("A: secret 'ab%41/cd' echoed with a JSON slash: 'ab%41\\/cd'", bodyOnly("ab%41/cd", "ab%41\\/cd") === REDACTED);
      check("A: secret 'k&amp;/z' echoed with a JSON slash: 'k&amp;\\/z'", bodyOnly("k&amp;/z", "k&amp;\\/z") === REDACTED);
      check("A: control (also green on the mixed decode alone): secret 'A/z' echoed with a JSON slash 'A\\/z'",bodyOnly("A/z", "A\\/z") === REDACTED);
      check("A: secret 'ab\\/cd' (literal backslash-slash) echoed %-encoded: 'ab%5C%2Fcd' (control: a pct echo still works)", bodyOnly("ab\\/cd", "ab%5C%2Fcd") === REDACTED);
      check("A: secret 'a&amp;b/c' echoed %-only around a literal '&amp;': 'a&amp;b%2Fc' is redacted via the %-only view", bodyOnly("a&amp;b/c", "a&amp;b%2Fc") === REDACTED);
      check("A: near-miss (last char off) for 4Ab/cd9 is unchanged", bodyOnly("4Ab/cd9", "x%4Ab\\/cd8y") === "x%4Ab\\/cd8y");
      check("A: near-miss for 65;q/z is unchanged", bodyOnly("65;q/z", "&#65;q\\/y") === "&#65;q\\/y");
      check("A: near-miss for ab%41/cd is unchanged", bodyOnly("ab%41/cd", "ab%41\\/cx") === "ab%41\\/cx");
      check("A: near-miss for k&amp;/z is unchanged", bodyOnly("k&amp;/z", "k&amp;\\/y") === "k&amp;\\/y");
      check("A: near-miss for A/z is unchanged", bodyOnly("A/z", "A\\/y") === "A\\/y");
      // Adjacent hits from different views merge into ONE marker.
      check("A: two adjacent hits merge into one marker", bodyOnly("ab", "abab") === REDACTED);
    }
    // Fail closed: past its budget the redactor throws; it never hands back the text.
    {
      let threw = false, returned;
      try { returned = buildSecretRedactor("a", -1)("a".repeat(100_000)); } catch (e) { threw = e instanceof redactMod.RedactionBudgetExceeded; }
      check("A: an exhausted budget throws RedactionBudgetExceeded and returns nothing", threw && returned === undefined);
    }
  }
  check("A: padded base64 is removed whole (no '=' fragment left behind)", red(`t:${FORMS.b64(SECRET)};`) === `t:${REDACTED};`);
  check("A: unpadded base64url is removed", red(`t:${FORMS.b64url_unpadded(SECRET)};`) === `t:${REDACTED};`);
  check("A: unrelated text is untouched", red("hello world, nothing to see") === "hello world, nothing to see");
  check("A: an empty/undefined secret is a no-op", buildSecretRedactor("")("abc") === "abc" && buildSecretRedactor(undefined)("abc") === "abc");
  const uni = "pä-ß€-secret-9";
  const ured = buildSecretRedactor(uni);
  check("A: a non-ASCII secret: exact, percent, base64 and JSON \\u forms are all removed",
    [uni, encodeURIComponent(uni), b64(uni), JSON.stringify(uni).slice(1, -1), uni.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))]
      .every((f) => ured(`x${f}y`) === `x${REDACTED}y`));
  // Cost: variants are built once; a 2 MB body is a bounded number of linear passes.
  const big = "lorem ipsum dolor sit amet ".repeat(80_000) + FORMS.b64(SECRET);
  const t0 = performance.now();
  const out = red(big);
  const dt = performance.now() - t0;
  check(`A: a ${(big.length / 1e6).toFixed(1)} MB body redacts in well under 3s (${dt.toFixed(0)}ms) and the echo is gone`, dt < 3000 && !out.includes(FORMS.b64(SECRET)) && out.endsWith(REDACTED));
}

// ============ the real loopback echo server ============
// Reads the credential Loom ACTUALLY injected (so the test also proves it arrived) and reflects it re-encoded.
const credOf = (req) => {
  const bearer = /^Bearer (.*)$/.exec(String(req.headers["authorization"] ?? ""));
  return bearer ? bearer[1] : (req.headers["x-api-key"] ?? req.headers["x-custom-token"]);
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const form = u.searchParams.get("form");
  const cred = credOf(req);
  if (!FORMS[form] || cred === undefined) { res.writeHead(400); res.end("bad"); return; }
  const echoed = FORMS[form](String(cred));
  if (u.pathname === "/redir") { res.writeHead(302, { location: `/cb?token=${echoed}`, "x-debug": echoed }); res.end(`moved ${echoed}`); return; }
  res.writeHead(200, { "x-debug": echoed, "content-type": "text/plain" });
  res.end(`<html><pre>debug: ${echoed}</pre></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const db = new Db(path.join(tmpHome, "rv.db"));
let n = 0;
const nm = () => `c${++n}-${Math.random().toString(36).slice(2, 6)}`;
const placements = [
  { label: "X-API-Key", plain: true, make: (host, extra) => createConnection(db, { name: nm(), host, authScheme: "api-key", secret: SECRET, ...extra }) },
  { label: "custom header", plain: true, make: (host, extra) => createConnection(db, { name: nm(), host, authScheme: "api-key", secret: SECRET, apiKeyHeader: "X-Custom-Token", ...extra }) },
  { label: "bearer", plain: true, make: (host, extra) => createConnection(db, { name: nm(), host, authScheme: "bearer", secret: SECRET, ...extra }) },
  { label: "oauth2", plain: false, make: (host) => {
    const c = createOAuthConnection(db, { name: nm(), host, provider: "custom", clientId: "cid", clientSecret: "client-secret-not-sent", authUrl: "https://a.example.com/a", tokenUrl: "https://a.example.com/t", scopes: ["r"] });
    saveOAuthTokens(db, c.id, { clientSecret: "client-secret-not-sent", accessToken: SECRET, refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, undefined);
    return c;
  } },
];
// The https path: the connection's host is a public-looking name, and the injected fetch redirects the dial to the loopback server.
const toLoopback = async (url, init) => { const u = new URL(String(url)); return fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, init); };

const leaked = (r, form) => JSON.stringify(r).includes(FORMS[form](SECRET));

async function matrix(pathLabel, mkDeps, hostFor, placementList) {
  for (const p of placementList) {
    const conn = p.make(hostFor, pathLabel === "plain-http" ? { allowPlainHttp: true } : {});
    const bad = [];
    const notRedacted = [];
    for (const form of Object.keys(FORMS)) {
      __resetConnectionsRateLimitState();
      // Positive control: with no redaction in the way, the server really does emit this encoding.
      const raw = await fetch(`http://127.0.0.1:${PORT}/echo?form=${form}`, { headers: { "x-api-key": SECRET } });
      const rawBody = await raw.text();
      if (!rawBody.includes(FORMS[form](SECRET)) || !(raw.headers.get("x-debug") ?? "").includes(FORMS[form](SECRET))) bad.push(`${form}:control`);
      const echo = await performAuthenticatedRequest(mkDeps(), [conn.id], GUARD, { connection: conn.id, path: `/echo?form=${form}` });
      const redir = await performAuthenticatedRequest(mkDeps(), [conn.id], GUARD, { connection: conn.id, path: `/redir?form=${form}` });
      if (!echo.ok || !redir.ok || echo.status !== 200 || redir.status !== 302) { bad.push(`${form}:request(${echo.error ?? echo.status}/${redir.error ?? redir.status})`); continue; }
      if (leaked(echo, form) || leaked(redir, form) || JSON.stringify([echo, redir]).includes(SECRET)) bad.push(`${form}:LEAK`);
      if (!echo.body.includes(REDACTED) || !echo.headers["x-debug"]?.includes(REDACTED) || !redir.location?.includes(REDACTED)) notRedacted.push(form);
    }
    check(`${pathLabel} / ${p.label}: no encoding leaks in body, header or location (problems: ${bad.join(",") || "none"})`, bad.length === 0);
    check(`${pathLabel} / ${p.label}: body, x-debug header and location each carry the redaction marker for every encoding (missing: ${notRedacted.join(",") || "none"})`, notRedacted.length === 0);
  }
}

// ============ B. https path ============
await matrix("https", () => ({ db, fetchImpl: toLoopback }), "api.example.com", placements);

// ============ C. pinned plain-http path ============
// The real createPinnedHttpFetch adapter dials the checked loopback address; no fetchImpl/pinnedFetchFactory override.
await matrix("plain-http", () => ({ db }), `127.0.0.1:${PORT}`, placements.filter((p) => p.plain));

// ============ D. short-secret over-redaction ============
{
  const short = "ab";
  // No floor on the per-char needle or the whole-secret base64: a derived form is never shorter than the exact
  // secret, so redacting it costs no more over-redaction than the exact secret already does.
  const red = buildSecretRedactor(short);
  check("D: a 2-char secret: exact, its whole base64 ('YWI=') and its percent form are all redacted", red("YWI= and ab and %61b") === `${REDACTED} and ${REDACTED} and ${REDACTED}`);
  // End to end: a short api key, a response full of ordinary text.
  __resetConnectionsRateLimitState();
  const sc = createConnection(db, { name: nm(), host: "api.example.com", authScheme: "api-key", secret: short });
  const r = await performAuthenticatedRequest({ db, fetchImpl: async () => new Response(`key=${short} b64=YWI= pct=ab words: table cabin`, { status: 200, headers: { "x-k": short } }) }, [sc.id], GUARD, { connection: sc.id, path: "/x" });
  check("D: end to end, exact redacted (even inside words, as before) and its base64 form too", r.ok && r.body === `key=${REDACTED} b64=${REDACTED} pct=${REDACTED} words: t${REDACTED}le c${REDACTED}in` && r.headers["x-k"] === REDACTED);
}

server.close();
db.close();
await finishAndExit(failures);
