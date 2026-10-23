// Hermetic source-scan guard: every `useQuery(...)` bound inside `useAttention` (lib/attention.ts) must
// appear in BOTH the dismiss-prune `loaded` gate and the seen-set `resolved` gate (@decision 611e76ba /
// 3157a563 — the two gates deliberately stay separate expressions with different predicates, but must
// still name the SAME set of sources between them).
//
// The defect this guards against (Code Review ba4d1e14, card 5c2f8108 round 2): `kickoffDroppedEventsQuery`
// was added to useAttention but never wired into `loaded` or `resolved`. Missing from `loaded` lets
// pruneDismissed wipe a user's `mkd:` dismiss on reload (loaded fails open on an incomplete query set,
// wiping dismisses it should not have judged yet); missing from `resolved` lets a still-active alert
// re-fire its browser notification/toast on every page load, because `useNewAttention` seeds its
// seen-set the instant `resolved` reads true, even while this one query is still pending.
//
// `eventQueries` is a `useQueries(...)` array (not a bound `useQuery` name) and is deliberately handled as
// `eventQueries.every(...)` in both gates — excluded from the per-name scan below, not missed by it.
//
// Like attention-dismiss.mjs, this is a plain node script (no React/react-query), auto-discovered by
// test/run-all.mjs. Run standalone with:
//   node --experimental-strip-types packages/web/test/attention-query-gates.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const attentionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "attention.ts");
const src = readFileSync(attentionPath, "utf8");

function useAttentionBody(source) {
  const startMarker = "export function useAttention(";
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, "useAttention not found — update this guard's marker");
  // The signature is `useAttention(): { items: ...; resolved: boolean } {` — a balanced return-type
  // object sits BETWEEN the params and the real body brace, so the first `{` after `)` is the return
  // type's open brace, not the body's. Walk that one to its matching close first, then take the NEXT `{`
  // as the body's actual opening brace.
  const returnTypeOpen = source.indexOf("{", source.indexOf(")", start));
  assert.ok(returnTypeOpen >= 0, "could not locate useAttention's return-type brace");
  let rtDepth = 0;
  let returnTypeClose = -1;
  for (let i = returnTypeOpen; i < source.length; i++) {
    if (source[i] === "{") rtDepth++;
    else if (source[i] === "}") {
      rtDepth--;
      if (rtDepth === 0) { returnTypeClose = i; break; }
    }
  }
  assert.ok(returnTypeClose >= 0, "could not find the end of useAttention's return-type annotation");
  const braceOpen = source.indexOf("{", returnTypeClose + 1);
  assert.ok(braceOpen >= 0, "could not locate useAttention's opening brace");
  let depth = 0;
  for (let i = braceOpen; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceOpen, i + 1);
    }
  }
  throw new Error("useAttention's closing brace was never found");
}

const body = useAttentionBody(src);

// Every useQuery(...) binding inside useAttention, excluding the `useQueries(` array (`eventQueries`),
// which both gates fold with `.every(...)` instead of naming directly. Three shapes a real query can
// legitimately take, all of which must be found or a future query can slip past both gates unnoticed:
//   SIMPLE/GENERIC/LINE-WRAPPED:  const x = useQuery(  /  const x = useQuery<T>(  /  const x =\n
//     useQuery(  — one regex covers all three (`\s+` already matches a line wrap; the optional `<...>`
//     covers a generic type argument).
//   DESTRUCTURED:  const { data: xData, isPending: xPending } = useQuery(  — there is no single
//     query-object binding at all; whichever LOCAL alias the destructuring gave `data`/`isPending` is
//     itself the token each gate must name directly (no `.data`/`.isPending` suffix — there is no query
//     object left to suffix).
const SIMPLE_QUERY_RE = /const\s+(\w+)\s*=\s*useQuery(?:<[^()]*>)?\s*\(/g;
const DESTRUCTURED_QUERY_RE = /const\s*\{([^}]*)\}\s*=\s*useQuery(?:<[^()]*>)?\s*\(/g;

function destructuredAlias(fields, key) {
  const m = fields.match(new RegExp(`\\b${key}\\b\\s*(?::\\s*(\\w+))?`));
  if (!m) return null;
  return m[1] ?? key; // `{ data }` with no rename binds the local name `data` itself
}

// Every binding, normalized to { label, loadedToken, resolvedToken } — the token(s) each gate must
// contain for this query to be correctly wired. A SIMPLE binding's tokens are `<name>.data !== undefined`
// / `<name>.isPending`; a DESTRUCTURED one's are its own data/isPending alias, bare (no suffix).
const queryBindings = [];
for (const m of body.matchAll(SIMPLE_QUERY_RE)) {
  const name = m[1];
  queryBindings.push({ label: name, loadedToken: `${name}.data !== undefined`, resolvedToken: `${name}.isPending` });
}
for (const m of body.matchAll(DESTRUCTURED_QUERY_RE)) {
  const fields = m[1];
  const dataAlias = destructuredAlias(fields, "data");
  const pendingAlias = destructuredAlias(fields, "isPending");
  if (dataAlias) queryBindings.push({ label: `{data: ${dataAlias}}`, loadedToken: dataAlias, resolvedToken: null });
  if (pendingAlias) queryBindings.push({ label: `{isPending: ${pendingAlias}}`, loadedToken: null, resolvedToken: pendingAlias });
}
const queryNames = [...new Set(queryBindings.map((b) => b.label))];

// Word-boundary presence check (never a bare `.includes()`) — a plain substring test can false-positive
// on a token that is itself a substring of an unrelated, longer identifier.
function hasToken(expr, token) {
  const escaped = token.replace(/[.[\]()]/g, (c) => `\\${c}`);
  return new RegExp(`\\b${escaped}\\b`).test(expr);
}

check("the scan actually finds useAttention's useQuery bindings (positive control)", () => {
  assert.ok(queryNames.length >= 8, `expected >=8 useQuery bindings, found ${queryNames.length}: ${queryNames.join(", ")}`);
  assert.ok(queryNames.includes("sessions"));
  assert.ok(queryNames.includes("kickoffDroppedEventsQuery"), "kickoffDroppedEventsQuery must be a useQuery binding — update this guard if it was renamed");
});

function gateBlock(name) {
  // Both gates are plain boolean expressions with no nested statements, so the first `;` after the
  // `const <name> = ` marker is the end of the declaration — no need to track blank-line spacing, which
  // has already drifted once between `loaded` and `resolved` in this same file.
  const m = body.match(new RegExp(`const ${name} = ([\\s\\S]*?);`));
  assert.ok(m, `could not locate the \`${name}\` gate expression in useAttention`);
  return m[1];
}

const loadedExpr = gateBlock("loaded");
const resolvedExpr = gateBlock("resolved");

check("every useQuery in useAttention is named in the `loaded` dismiss-prune gate", () => {
  const missing = queryBindings.filter((b) => b.loadedToken && !hasToken(loadedExpr, b.loadedToken)).map((b) => b.label);
  assert.deepEqual(missing, [],
    `these useAttention queries are missing from \`loaded\` — a dismiss can be wiped before they resolve: ${missing.join(", ")}`);
});

check("every useQuery in useAttention is named in the `resolved` seen-set gate", () => {
  const missing = queryBindings.filter((b) => b.resolvedToken && !hasToken(resolvedExpr, b.resolvedToken)).map((b) => b.label);
  assert.deepEqual(missing, [],
    `these useAttention queries are missing from \`resolved\` — their alert can re-fire a notification on every load: ${missing.join(", ")}`);
});

check("the per-gate scan is falsifiable (negative control): dropping a real entry is caught", () => {
  const brokenLoaded = loadedExpr.replace(" && kickoffDroppedEventsQuery.data !== undefined", "");
  assert.notEqual(brokenLoaded, loadedExpr, "the kickoffDroppedEventsQuery clause moved — update this control");
  const missing = queryBindings.filter((b) => b.loadedToken && !hasToken(brokenLoaded, b.loadedToken)).map((b) => b.label);
  assert.deepEqual(missing, ["kickoffDroppedEventsQuery"]);

  const brokenResolved = resolvedExpr.replace(" && !kickoffDroppedEventsQuery.isPending", "");
  assert.notEqual(brokenResolved, resolvedExpr, "the kickoffDroppedEventsQuery clause moved — update this control");
  const missingR = queryBindings.filter((b) => b.resolvedToken && !hasToken(brokenResolved, b.resolvedToken)).map((b) => b.label);
  assert.deepEqual(missingR, ["kickoffDroppedEventsQuery"]);
});

// --- widened-scan coverage: generic type args, line-wrapped declarations, destructured bindings ---
check("the scan catches a generic-typed useQuery<T>( binding", () => {
  const names = [...`const genericQ = useQuery<{ x: number }>({ queryKey: ["g"] });`.matchAll(SIMPLE_QUERY_RE)].map((m) => m[1]);
  assert.deepEqual(names, ["genericQ"]);
});

check("the scan catches a line-wrapped `const x =\\n  useQuery(` declaration", () => {
  const names = [...`const wrappedQ =\n    useQuery({ queryKey: ["w"] });`.matchAll(SIMPLE_QUERY_RE)].map((m) => m[1]);
  assert.deepEqual(names, ["wrappedQ"]);
});

check("the scan catches a destructured const { data, isPending } = useQuery( binding", () => {
  const src = `const { data: dqData, isPending: dqPending } = useQuery({ queryKey: ["d"] });`;
  const matches = [...src.matchAll(DESTRUCTURED_QUERY_RE)];
  assert.equal(matches.length, 1);
  assert.equal(destructuredAlias(matches[0][1], "data"), "dqData");
  assert.equal(destructuredAlias(matches[0][1], "isPending"), "dqPending");
});

check("hasToken uses word boundaries — a token is not matched as a substring of a longer identifier", () => {
  assert.equal(hasToken("fooBar.data !== undefined", "foo.data !== undefined"), false,
    "'foo.data !== undefined' must not match inside 'fooBar.data !== undefined'");
  assert.equal(hasToken("foo.data !== undefined", "foo.data !== undefined"), true);
});

console.log(`\n${pass} checks passed`);
