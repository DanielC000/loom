import "./_guard.mjs";
// Card 4cbbc343 — SOURCE-TEXT guard (no daemon, no build): no trust decision may read a peer address or compare
// against a loopback literal anywhere in `packages/daemon/src` except through the single predicate
// (`requestClass` in gateway/trust-tier.ts). It exists because the class must follow the LISTENER, and every raw
// `LOOPBACK.has(req.socket.remoteAddress)` / `LOOPBACK.has(req.ip)` is a place a proxied request (peer 127.0.0.1)
// would be trusted as loopback — the whole defect this card fixes (10 such reads, all in gateway/server.ts).
//
// WHAT IT COVERS: comment-stripped `src/**/*.ts` text, four shapes — (a) the bare `remoteAddress` identifier,
// (b) `.ip` read off a request-like object (`req.ip`, `request.ip`, `raw.ip`), (c) an equality/`Set` membership
// test against a loopback literal ("127.0.0.1" / "::1" / "::ffff:127.0.0.1"), (d) a `/^127\./`-style regex.
// WHAT IT DOES NOT COVER (stated, not implied): a peer address reached through an ALIAS variable or a helper that
// hides the property name; the non-daemon packages (bin/loom.mjs, web); a loopback test written with a shape not
// listed above (e.g. a switch/case on the literal) — extend PATTERNS when a new shape appears. It scans TEXT, not
// behaviour: remote-trusted-proxy*.mjs are the behavioural proofs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const LOOP = String.raw`(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)`;
export const PATTERNS = [
  { name: "bare `remoteAddress` identifier", re: /\bremoteAddress\b/ },
  { name: "`.ip` read on a request-like object", re: /\b(?:req|request|raw)\.ip\b/ },
  { name: "equality test against a loopback literal", re: new RegExp(String.raw`(?:===|!==|==|!=)\s*["']${LOOP}["']|["']${LOOP}["']\s*(?:===|!==|==|!=)`) },
  { name: "Set/array membership built from a loopback literal", re: new RegExp(String.raw`new Set\(\s*\[[^\]]*["']${LOOP}["']`) },
  { name: "`/^127\\./`-style loopback regex", re: /\/\^127\\\./ },
];

/** Files that ARE the predicate (or its host-shape validators): allowed to name peers and loopback literals. */
const ALLOWED_FILES = new Set(["gateway/trust-tier.ts"]);
/** Individually justified exceptions elsewhere: [file, pattern name, exact count, why it is NOT a peer-trust decision]. */
const EXCEPTIONS = [
  ["gateway/server.ts", "equality test against a loopback literal", 1, "isLoopbackHostname — the CSRF hook's Host/Origin HOSTNAME allowlist for the loopback class (a header check, not a peer-address trust decision; the class it applies to is decided by requestClass)"],
  ["codescape/supervisor.ts", "equality test against a loopback literal", 1, "validates the hostname of the codescape serve URL Loom itself constructed — no request peer involved"],
];

/** Scan one file's text; returns [{name, line}] for every pattern hit on comment-stripped text. */
export function scanText(text) {
  const hits = [];
  const lines = stripComments(text).split(/\r?\n/);
  lines.forEach((ln, i) => { for (const p of PATTERNS) if (p.re.test(ln)) hits.push({ name: p.name, line: i + 1, text: ln.trim() }); });
  return hits;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// ===================== (C) positive controls — the scanner CAN fire =======================================
{
  // The REAL shapes this card removed (verbatim from gateway/server.ts before the change) — the corpus that produced the defect.
  const realOld = [
    `const peerIsLoopback = LOOPBACK.has(req.socket?.remoteAddress ?? "");`,
    `      const ip = req.socket?.remoteAddress ?? "";`,
    `    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");`,
    `const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);`,
  ];
  for (const ln of realOld) check(`(C) the scanner FIRES on the pre-change shape: ${ln.trim().slice(0, 70)}`, scanText(ln).length >= 1);
  const synthetic = [
    [`if (req.ip === "127.0.0.1") ok();`, "`.ip` read on a request-like object"],
    [`if (addr === "::1") trust();`, "equality test against a loopback literal"],
    [`if ("127.0.0.1" == addr) trust();`, "equality test against a loopback literal"],
    [`if (/^127\\./.test(a)) trust();`, "`/^127\\./`-style loopback regex"],
    [`const s = new Set(["x", "::ffff:127.0.0.1"]);`, "Set/array membership built from a loopback literal"],
    [`const a = socket.remoteAddress;`, "bare `remoteAddress` identifier"],
  ];
  for (const [ln, name] of synthetic) check(`(C) fires on ${name}: ${ln}`, scanText(ln).some((h) => h.name === name));
  check("(C) NEGATIVE control: a bogus/innocuous line returns 0 hits", scanText(`const x = compute(req.method, "GET");`).length === 0);
  check("(C) NEGATIVE control: a loopback literal mentioned only in a COMMENT returns 0 hits (comment-stripped)", scanText(`// LOOPBACK.has(req.ip) and req.socket.remoteAddress were the old way\nconst y = 1;`).length === 0);
  check("(C) a listen-host literal that is not a comparison is NOT flagged (\"127.0.0.1\" as a bind address)", scanText(`await app.listen({ port, host: "127.0.0.1" });`).length === 0);
}

// ===================== (S) the real corpus ================================================================
{
  const files = walk(SRC);
  check(`(S) corpus sanity: scanned a real tree (${files.length} src/**/*.ts files, expect > 100)`, files.length > 100);
  let total = 0;
  const offenders = [];
  const exceptionSeen = new Map();
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join("/");
    const hits = scanText(fs.readFileSync(f, "utf8"));
    total += hits.length;
    if (ALLOWED_FILES.has(rel)) continue;
    for (const h of hits) {
      const ex = EXCEPTIONS.find(([file, name]) => file === rel && name === h.name);
      if (ex) { exceptionSeen.set(ex, (exceptionSeen.get(ex) ?? 0) + 1); continue; }
      offenders.push(`${rel}:${h.line} [${h.name}] ${h.text.slice(0, 100)}`);
    }
  }
  check(`(S) the predicate module itself DOES hit the patterns (the scan is live on this corpus; ${total} raw hits in total, all in the allowed file or a justified exception)`, total > 0);
  check(`(S) NO trust decision outside gateway/trust-tier.ts reads a peer address or a loopback literal${offenders.length ? `\n      ${offenders.join("\n      ")}` : ""}`, offenders.length === 0);
  for (const ex of EXCEPTIONS) check(`(S) the justified exception ${ex[0]} [${ex[1]}] matches EXACTLY ${ex[2]} site(s) (stale exceptions fail): ${ex[3].slice(0, 60)}…`, (exceptionSeen.get(ex) ?? 0) === ex[2]);
}

console.log(failures === 0 ? "\n✅ ALL PASS — the trust class is decided only by requestClass" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
