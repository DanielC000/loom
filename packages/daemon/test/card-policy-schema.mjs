import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 78a9ae1c — card-policy schema + selector + human-only trust boundary (shared/daemon half only; no
// enforcement exists yet). Deterministic: real Db + SessionService over a stub pty, the real Platform router.
//
//   (1) selector: type only, scope only, type+scope, cardIds opt-in (full id / 8-char prefix), bare prose
//       matches ONLY via cardIds, `!` breaking marker, parseConventionalTitle shape.
//   (2) resolveConfig: empty default, byte-identical other keys, corrupt stored JSON degrades to [],
//       parseCardPolicies reports the corruption (what an enforcement caller reads).
//   (3) write-time validation on the human validator (unknown kind/type, duplicate ids, caps, strict keys).
//   (4) human-only: the AGENT validator rejects it; the elevated Lead project_configure rejects set AND
//       unset/prefix-unset/replace-drop; setup router rejects; a sibling key is still accepted (control).
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("cpol-sch-");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveConfig, PLATFORM_DEFAULTS, parseCardPolicies, CARD_POLICY_LIMITS } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { parseConventionalTitle, cardPolicyMatches } = await import("../dist/tasks/title-guard.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) selector ============
const ID = "78a9ae1c-acff-4178-a0ea-7c8957abc71f";
const task = (title, id = ID) => ({ id, title });
const pol = (match) => ({ id: "p", match, require: [{ kind: "code-review-report" }] });
check("(1) parse: type+scope", JSON.stringify(parseConventionalTitle("feat(shared): add x")) === JSON.stringify({ type: "feat", scope: "shared" }));
check("(1) parse: no scope -> scope null", JSON.stringify(parseConventionalTitle("fix: add x")) === JSON.stringify({ type: "fix", scope: null }));
check("(1) parse: bare prose -> null", parseConventionalTitle("Note: this is prose") === null && parseConventionalTitle("just words") === null);
check("(1) parse: ! marker keeps type+scope", JSON.stringify(parseConventionalTitle("feat(daemon)!: break it")) === JSON.stringify({ type: "feat", scope: "daemon" }));
check("(1) type-only match", cardPolicyMatches(pol({ types: ["feat"] }), task("feat(web): a")) && !cardPolicyMatches(pol({ types: ["feat"] }), task("fix(web): a")));
check("(1) scope-only match", cardPolicyMatches(pol({ scopes: ["web"] }), task("fix(web): a")) && !cardPolicyMatches(pol({ scopes: ["web"] }), task("fix(daemon): a")));
check("(1) scope-only does not match a scopeless title", !cardPolicyMatches(pol({ scopes: ["web"] }), task("fix: a")));
check("(1) type AND scope must both match", cardPolicyMatches(pol({ types: ["feat"], scopes: ["web"] }), task("feat(web): a")) && !cardPolicyMatches(pol({ types: ["feat"], scopes: ["web"] }), task("fix(web): a")) && !cardPolicyMatches(pol({ types: ["feat"], scopes: ["web"] }), task("feat(daemon): a")));
check("(1) cardIds opt-in matches regardless of title", cardPolicyMatches(pol({ cardIds: [ID] }), task("bare prose title")));
check("(1) cardIds opt-in matches an 8-char prefix", cardPolicyMatches(pol({ cardIds: ["78a9ae1c"] }), task("bare prose title")));
check("(1) cardIds opt-in is independent of types/scopes", cardPolicyMatches(pol({ types: ["docs"], cardIds: [ID] }), task("feat(web): a")));
check("(1) a short (<8) cardIds prefix does not match", !cardPolicyMatches(pol({ cardIds: ["78a9"] }), task("bare prose title")));
check("(1) another card's id does not match", !cardPolicyMatches(pol({ cardIds: ["deadbeef"] }), task("bare prose title")));
check("(1) bare prose does NOT match types/scopes", !cardPolicyMatches(pol({ types: ["feat"] }), task("Note: feat(web): hidden")) && !cardPolicyMatches(pol({ scopes: ["web"] }), task("add the web thing")));
check("(1) `!` breaking marker still matches type/scope", cardPolicyMatches(pol({ types: ["feat"], scopes: ["daemon"] }), task("feat(daemon)!: break")));

// ============ (2) resolveConfig ============
check("(2) PLATFORM_DEFAULTS.orchestration.cardPolicies is an empty array", Array.isArray(PLATFORM_DEFAULTS.orchestration.cardPolicies) && PLATFORM_DEFAULTS.orchestration.cardPolicies.length === 0);
const r0 = resolveConfig({}).orchestration;
check("(2) resolveConfig({}) yields cardPolicies []", Array.isArray(r0.cardPolicies) && r0.cardPolicies.length === 0);
const { cardPolicies: _cp, ...restResolved } = r0;
const { cardPolicies: _dp, ...restDefaults } = PLATFORM_DEFAULTS.orchestration;
check("(2) every pre-existing orchestration key resolves exactly as its platform default (per key, order-independent)",
  Object.keys(restDefaults).length > 30 &&
  [...new Set([...Object.keys(restResolved), ...Object.keys(restDefaults)])].every((k) => JSON.stringify(restResolved[k]) === JSON.stringify(restDefaults[k])));
const good = [{ id: "review-feat", name: "Review features", match: { types: ["feat"], scopes: ["daemon"] }, require: [{ kind: "code-review-report" }, { kind: "approved-request", requestKind: "mockup" }] }];
check("(2) an override survives resolve verbatim", JSON.stringify(resolveConfig({ orchestration: { cardPolicies: good } }).orchestration.cardPolicies) === JSON.stringify(good));
check("(2) a JSON-valid but wrong-typed stored value (a string, not an array) resolves to [] without throwing", (() => { try { return resolveConfig({ orchestration: { cardPolicies: "{not json" } }).orchestration.cardPolicies.length === 0; } catch { return false; } })());
check("(2) corrupt stored entry (unknown kind) resolves to [] without throwing", (() => { try { return resolveConfig({ orchestration: { cardPolicies: [{ id: "x", match: { types: ["feat"] }, require: [{ kind: "nope" }] }] } }).orchestration.cardPolicies.length === 0; } catch { return false; } })());
check("(2) parseCardPolicies surfaces the wrong-typed/invalid value (ok:false) for enforcement callers", parseCardPolicies("{not json").ok === false && parseCardPolicies([{ id: "x", match: { types: ["feat"] }, require: [{ kind: "nope" }] }]).ok === false);
check("(2) parseCardPolicies(undefined) is ok + empty (absent is not corrupt)", (() => { const r = parseCardPolicies(undefined); return r.ok && r.policies.length === 0; })());
check("(2) the resolved default list is not shared by reference with PLATFORM_DEFAULTS", resolveConfig({}).orchestration.cardPolicies !== PLATFORM_DEFAULTS.orchestration.cardPolicies);

// ============ (3) write-time validation (human validator) ============
const hv = (cp) => validateProjectConfigOverride({ orchestration: { cardPolicies: cp } });
const okv = (r) => r.ok === true;
const mk = (over = {}) => ({ id: "a", match: { types: ["feat"] }, require: [{ kind: "code-review-report" }], ...over });
check("(3) human validator ACCEPTS a well-formed list", okv(hv(good)));
check("(3) human validator ACCEPTS the empty list", okv(hv([])));
check("(3) REJECTS an unknown requirement kind", !okv(hv([mk({ require: [{ kind: "nope" }] })])));
check("(3) REJECTS an unknown Conventional type", !okv(hv([mk({ match: { types: ["feature"] } })])));
check("(3) REJECTS duplicate policy ids", !okv(hv([mk(), mk()])));
check("(3) REJECTS an empty match (matches nothing / ambiguous)", !okv(hv([mk({ match: {} })])));
check("(3) REJECTS an empty require list", !okv(hv([mk({ require: [] })])));
check("(3) REJECTS unknown keys on a policy / match / requirement", !okv(hv([mk({ extra: 1 })])) && !okv(hv([mk({ match: { types: ["feat"], parentId: "x" } })])) && !okv(hv([mk({ require: [{ kind: "code-review-report", x: 1 }] })])));
check("(3) REJECTS a bad requestKind", !okv(hv([mk({ require: [{ kind: "approved-request", requestKind: "weird" }] })])));
check("(3) REJECTS a non-array value", !okv(hv({})) && !okv(hv("x")));
check("(3) REJECTS more than the policy-count cap", !okv(hv(Array.from({ length: CARD_POLICY_LIMITS.maxPolicies + 1 }, (_, i) => mk({ id: `p${i}` })))) && okv(hv(Array.from({ length: CARD_POLICY_LIMITS.maxPolicies }, (_, i) => mk({ id: `p${i}` })))));
check("(3) REJECTS more than the requirement-count cap", !okv(hv([mk({ require: Array.from({ length: CARD_POLICY_LIMITS.maxRequirements + 1 }, () => ({ kind: "code-review-report" })) })])));
check("(3) REJECTS an over-long match list", !okv(hv([mk({ match: { cardIds: Array.from({ length: CARD_POLICY_LIMITS.maxMatchEntries + 1 }, (_, i) => `id${i}xxxxx`) } })])));
check("(3) REJECTS an unsafe policy id", !okv(hv([mk({ id: "has space" })])));

// ---- (3b) selectors that can never match are rejected (card d2bc231e); each has an accept-at-boundary control ----
const errOf = (match) => { const r = parseCardPolicies([mk({ match })]); return r.ok ? null : r.error; };
const rejectsNaming = (match, re) => { const e = errOf(match); return e !== null && re.test(e) && !okv(hv([mk({ match })])); };
check("(3b) REJECTS types:[] naming the field", rejectsNaming({ types: [] }, /match\.types.*empty/));
check("(3b) REJECTS scopes:[] naming the field", rejectsNaming({ scopes: [] }, /match\.scopes.*empty/));
check("(3b) REJECTS cardIds:[] naming the field", rejectsNaming({ cardIds: [] }, /match\.cardIds.*empty/));
check("(3b) REJECTS an empty list even beside a valid one", rejectsNaming({ types: ["feat"], scopes: [] }, /match\.scopes.*empty/));
check("(3b) REJECTS a cardIds entry under 8 chars (the owner's \"78a9\" specimen)", rejectsNaming({ cardIds: ["78a9"] }, /match\.cardIds.*78a9.*8/) && rejectsNaming({ cardIds: ["78a9ae1"] }, /match\.cardIds/));
check("(3b) ACCEPTS an 8-char cardId and a full id (boundary controls)", errOf({ cardIds: ["78a9ae1c"] }) === null && errOf({ cardIds: [ID] }) === null && okv(hv([mk({ match: { cardIds: ["78a9ae1c"] } })])));
check("(3b) REJECTS a scope with surrounding whitespace", rejectsNaming({ scopes: [" web"] }, /match\.scopes/) && rejectsNaming({ scopes: ["web "] }, /match\.scopes/) && rejectsNaming({ scopes: ["a b"] }, /match\.scopes/));
check("(3b) REJECTS an uppercase scope", rejectsNaming({ scopes: ["Web"] }, /match\.scopes/));
check("(3b) REJECTS a scope containing )", rejectsNaming({ scopes: ["web)"] }, /match\.scopes/));
check("(3b) ACCEPTS valid scopes incl. hyphen/dot/slash (boundary controls)", ["web", "mcp", "a-b", "a.b", "a/b", "x1"].every((s) => errOf({ scopes: [s] }) === null));
// Drift guard: whatever the parser accepts as a scope must be exactly what parseConventionalTitle extracts from a title carrying it.
check("(3b) every accepted scope round-trips through the title parser (parser and matcher share one scope grammar)",
  ["web", "mcp", "a-b", "a.b", "a/b", "x1"].every((s) => parseConventionalTitle(`feat(${s}): x`)?.scope === s && cardPolicyMatches(pol({ scopes: [s] }), task(`feat(${s}): x`))));
check("(3b) at-cap ACCEPT: maxRequirements requirements", okv(hv([mk({ require: Array.from({ length: CARD_POLICY_LIMITS.maxRequirements }, () => ({ kind: "code-review-report" })) })])));
check("(3b) at-cap ACCEPT: maxMatchEntries cardIds", okv(hv([mk({ match: { cardIds: Array.from({ length: CARD_POLICY_LIMITS.maxMatchEntries }, (_, i) => `id${i}xxxxx`) } })])));

// ============ (4) human-only trust boundary ============
const agentSet = validateAgentProjectConfigOverride({ orchestration: { cardPolicies: good } });
check("(4) AGENT validator REJECTS orchestration.cardPolicies (non-empty)", !okv(agentSet) && /cardPolicies/.test(agentSet.error ?? ""));
check("(4) AGENT validator REJECTS orchestration.cardPolicies even when empty", !okv(validateAgentProjectConfigOverride({ orchestration: { cardPolicies: [] } })));
check("(4) CONTROL: AGENT validator still accepts a sibling orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
check("(4) nested human-only list names orchestration.cardPolicies", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.cardPolicies"));

const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pI", name: "I", repoPath: process.env.LOOM_HOME, vaultPath: process.env.LOOM_HOME, config: {}, createdAt: now, archivedAt: null });
async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "card-policy-schema-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const lead = () => new PlatformMcpRouter(db, svc).buildServer();
const before = JSON.stringify(db.getProject("pI").config);
const s1 = await callTool(lead(), "project_configure", { projectId: "pI", config: { orchestration: { cardPolicies: good } } });
check("(4) elevated Lead project_configure REJECTS setting orchestration.cardPolicies", typeof s1.error === "string" && /cardPolicies/.test(s1.error));
const s2 = await callTool(lead(), "project_configure", { projectId: "pI", config: { orchestration: { cardPolicies: [] } } });
check("(4) elevated Lead project_configure REJECTS setting it to an empty list too", typeof s2.error === "string" && /cardPolicies/.test(s2.error));
const s3 = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pI", config: { orchestration: { cardPolicies: good } } });
check("(4) setup router project_configure REJECTS orchestration.cardPolicies", typeof s3.error === "string" && /cardPolicies/.test(s3.error));
check("(4) none of the rejected writes changed the stored config", JSON.stringify(db.getProject("pI").config) === before);

db.setProjectConfig("pI", { orchestration: { cardPolicies: good, maxConcurrentWorkers: 2 } });
const stored = JSON.stringify(db.getProject("pI").config);
const u1 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.cardPolicies"] });
check("(4) Lead unset of orchestration.cardPolicies is REFUSED", typeof u1.error === "string" && /cardPolicies/.test(u1.error));
const u2 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration"] });
check("(4) Lead unset of the PREFIX \"orchestration\" is REFUSED", typeof u2.error === "string");
const u3 = await callTool(lead(), "project_configure", { projectId: "pI", config: { docLint: false }, replace: true });
check("(4) Lead replace:true that would drop stored cardPolicies is REFUSED", typeof u3.error === "string");
check("(4) none of the refused writes changed the stored config", JSON.stringify(db.getProject("pI").config) === stored);
const u4 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.maxConcurrentWorkers"] });
check("(4) CONTROL: unsetting a SIBLING nested key works and cardPolicies survives",
  !u4.error && JSON.stringify(db.getProject("pI").config?.orchestration?.cardPolicies) === JSON.stringify(good));
db.setProjectConfig("pI", {});
db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — card-policy selector, resolveConfig default/corrupt handling, write-time validation, and the human-only boundary (agent validator, setup router, elevated Lead set + unset/replace)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
