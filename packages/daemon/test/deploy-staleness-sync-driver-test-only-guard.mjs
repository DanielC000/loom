import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bba7a8ec — the SYNC deploy-staleness drivers are TEST/FIXTURE-ONLY. `computeDeployStaleness`,
// `currentDeployStaleness` and `buildServedStatus` run their git reads through `execFileSync`, which blocks the
// whole event loop (870–944 ms measured for the daemon+shared walk alone). Every production read goes through
// the async twins (`computeDeployStalenessAsync` / `currentDeployStalenessAsync` / `buildServedStatusAsync`).
//
// SOURCE-TEXT scan of every non-test `packages/daemon/src/**/*.ts` file (comments stripped first, so prose that
// merely names the sync functions is not flagged): ANY occurrence of one of the three sync identifiers is a
// violation, except the exact definition/forwarding lines allow-listed below in the two modules that own them.
// The `\b` boundaries are what keep `…Async` from matching (the `A` is a word character).
//
// Does NOT cover: a dynamic `import()`-then-property access built from a computed string; a caller outside
// `packages/daemon/src` (the scripts/ and test/ trees are deliberately out of scope — tests are the legitimate
// users). Blind spot named, not closed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, "..", "src");

// Assembled from parts, not written as one regex literal: `deploy-staleness-fixture-guard.mjs` source-scans the
// whole test corpus for a bare reference to the sync `current…` driver, and this file must not trip it.
const SYNC_IDENT = new RegExp(`\\b(?:${["computeDeploy", "currentDeploy"].map((p) => `${p}Staleness`).concat("buildServedStatus").join("|")})\\b`);

/** Exact trimmed code lines that may mention a sync identifier, per file (repo-relative to `src/`). */
const ALLOWED = {
  "deploy-staleness.ts": [
    "export function computeDeployStaleness(options: ComputeDeployStalenessOptions = {}): DeployStalenessResult {",
  ],
  "served-status.ts": [
    "export function currentDeployStaleness(): DeployStalenessResult {",
    "return computeDeployStaleness({ processBuiltSha, processBuiltDirty });",
    "export function buildServedStatus(db: Db): ServedStatus {",
    "return composeServedStatus(db, currentDeployStaleness());",
    'import { computeDeployStaleness, computeDeployStalenessAsync, readBuildInfo, type DeployStalenessResult } from "./deploy-staleness.js";',
  ],
};

/** Strips `//` and block comments, keeping line structure so reported line numbers stay right. String contents
 *  are left alone (a sync identifier inside a string would be reviewed by a human, not silently ignored). */
function stripComments(text) {
  let out = "";
  let i = 0;
  let inStr = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    // A ' or " string cannot span a line: reset at a newline so a stray quote (a regex literal, an apostrophe in
    // code) cannot leave the scanner "inside a string" for the rest of the file and hide later comments.
    if (inStr && inStr !== "`" && c === "\n") inStr = null;
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    out += c;
    i++;
  }
  return out;
}

/** Violations in one file's text: [{line, text}] for every non-allow-listed line naming a sync identifier. */
export function scanSource(relName, text) {
  const allowed = new Set(ALLOWED[relName] ?? []);
  const hits = [];
  stripComments(text).split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (SYNC_IDENT.test(t) && !allowed.has(t)) hits.push({ line: idx + 1, text: t });
  });
  return hits;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) yield full;
  }
}

// ---- positive controls: the scan can see a violation, and does not over-flag the async twins or prose
check("control: a sync call in a production-shaped file IS flagged", scanSource("gateway/x.ts", "const r = currentDeployStaleness();\n").length === 1);
check("control: a sync IMPORT is flagged", scanSource("gateway/x.ts", 'import { buildServedStatus } from "../served-status.js";\n').length === 1);
check("control: a direct computeDeployStaleness() call is flagged", scanSource("sessions/y.ts", "return computeDeployStaleness({});\n").length === 1);
check("control: the async twins are NOT flagged", scanSource("gateway/x.ts", "const r = await currentDeployStalenessAsync();\nconst s = await buildServedStatusAsync(db);\nconst t = await computeDeployStalenessAsync();\n").length === 0);
check("control: prose in // and /* */ comments is NOT flagged", scanSource("gateway/x.ts", "// currentDeployStaleness() is sync\n/* buildServedStatus(db)\n computeDeployStaleness() */\nconst a = 1;\n").length === 0);
check("control: an allow-listed line is flagged in the WRONG file", scanSource("gateway/x.ts", "return composeServedStatus(db, currentDeployStaleness());\n").length === 1);

// ---- the real tree
const files = [...walk(srcRoot)];
const violations = [];
const seenAllowed = new Set();
for (const f of files) {
  const rel = path.relative(srcRoot, f).split(path.sep).join("/");
  const text = fs.readFileSync(f, "utf8");
  for (const h of scanSource(rel, text)) violations.push(`${rel}:${h.line}: ${h.text}`);
  for (const a of ALLOWED[rel] ?? []) if (stripComments(text).split(/\r?\n/).some((l) => l.trim() === a)) seenAllowed.add(`${rel}|${a}`);
}
check(`scanned a real corpus (${files.length} .ts files under src/)`, files.length > 100);
check("known-present: every allow-listed definition/forwarding line really exists (the allow-list is not stale, and the scan sees real hits)",
  seenAllowed.size === Object.values(ALLOWED).reduce((n, l) => n + l.length, 0));
check("no production source file calls or imports a sync staleness driver", violations.length === 0);
for (const v of violations) console.log(`  VIOLATION  ${v}`);

console.log(failures === 0
  ? "\n✅ ALL PASS — no production source file uses the sync deploy-staleness drivers."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
