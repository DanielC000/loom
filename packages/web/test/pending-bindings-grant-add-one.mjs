// Hermetic SOURCE-TEXT check (card 3c18328b item 2) for the web half of b1df40f2: the Settings "Pending
// bindings" grant mutation must go through the atomic add-one REST (api.addAgentConnection), never the
// whole-list api.updateAgent — the real race was the web client's GET-then-POST of the whole `connections`
// list, which silently revoked a grant landed in between. Source-text check (not a rendered-behaviour test):
// it cannot see a runtime path that builds the call dynamically. Run standalone:
//   node --experimental-strip-types packages/web/test/pending-bindings-grant-add-one.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
const apiSrc = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");

// The panel body: from its declaration to the next top-level `function` declaration.
function panelBody(src) {
  const start = src.indexOf("function PendingBindingsPanel(");
  assert.ok(start >= 0, "PendingBindingsPanel must exist in Settings.tsx");
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(?:export )?function [A-Z]/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 10 + next);
}
// Strip comments so prose mentioning updateAgent can neither satisfy nor trip the check.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const body = stripComments(panelBody(settings));
const mutation = (() => {
  const i = body.indexOf("useMutation(");
  assert.ok(i >= 0, "the panel must declare its grant useMutation");
  return body.slice(i, body.indexOf("onSuccess", i));
})();

ok("CONTROL: the extractor finds a non-trivial panel body and a mutationFn", () => {
  assert.ok(body.length > 500, "panel body suspiciously short");
  assert.match(mutation, /mutationFn/);
});
ok("the grant mutationFn calls api.addAgentConnection", () => {
  assert.match(mutation, /api\.addAgentConnection\(/);
});
ok("the PendingBindingsPanel never calls api.updateAgent (no whole-list read-then-write)", () => {
  assert.doesNotMatch(body, /api\.updateAgent\(/);
});
ok("CONTROL: the updateAgent detector fires on a mutant mutationFn", () => {
  const mutant = mutation.replace("api.addAgentConnection(agentId, connectionId)", "api.updateAgent(agentId, { connections: [connectionId] })");
  assert.notEqual(mutant, mutation, "mutant substitution must change the text");
  assert.match(mutant, /api\.updateAgent\(/);
  assert.doesNotMatch(mutant, /api\.addAgentConnection\(/);
});
ok("api.addAgentConnection posts ONLY the one connectionId to /api/agents/:id/connections", () => {
  const m = apiSrc.match(/addAgentConnection:\s*\(id: string, connectionId: string\)\s*=>\s*\n?\s*post<[^>]*(?:>[^>]*)?>\(`([^`]+)`,\s*([^)]*)\)/);
  assert.ok(m, "api.addAgentConnection declaration not found");
  assert.equal(m[1], "/api/agents/${id}/connections");
  assert.match(m[2], /^\{\s*connectionId\s*\}$/);
});

console.log(`\n${pass} checks passed`);
