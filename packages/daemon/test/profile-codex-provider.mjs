import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ef54430 — a Profile's human-only codex model-provider endpoint. HERMETIC: temp LOOM_HOME, a REAL Db,
// no daemon, no real claude/codex, no network. Covers:
//   (1) the pure shape/URL/host-binding rules (codex-provider.ts),
//   (2) validateProfile + the human-only trust boundary (agentProfileKeyError, grant reach),
//   (3) the Db round-trip (insert/update/clear) and the session-row pin chokepoint,
//   (4) buildCodexProviderArgs' exact argv (and that a secret/URL-injection can never reach it),
//   (5) the spawn-time env/argv contract (applyCodexProvider): secret in env only, fail-closed.
// Run: 1) build (turbo builds shared first), 2) node test/profile-codex-provider.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = mkdtempManaged("loom-cprov-");

const { codexProviderShapeError, codexProviderUrlError, codexProviderBindingError, endpointHostname, CODEX_PROVIDER_KEY_ENV_VAR } = await import("../dist/profiles/codex-provider.js");
const { validateProfile, agentProfileKeyError } = await import("../dist/profiles/validate.js");
const { buildCodexProviderArgs } = await import("../dist/pty/codex-host.js");
const { addedProfileGrants } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");

// ===================== (1) pure rules =====================
const custom = { id: "myhost", baseUrl: "https://api.example.com/v1", connectionId: "c1" };
check("(1) positive control: a well-formed custom provider has no shape error", codexProviderShapeError(custom) === null);
check("(1) built-in ollama (no url/key) is valid", codexProviderShapeError({ id: "ollama" }) === null);
check("(1) built-in lmstudio (no url/key) is valid", codexProviderShapeError({ id: "lmstudio" }) === null);
check("(1) built-in id with a baseUrl is refused", codexProviderShapeError({ id: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }) !== null);
check("(1) reserved 'openai' id is refused", codexProviderShapeError({ id: "openai", baseUrl: "https://x.example/v1", connectionId: "c" }) !== null);
check("(1) a custom provider missing connectionId is refused", codexProviderShapeError({ id: "myhost", baseUrl: "https://x.example/v1" }) !== null);
check("(1) uppercase / injection-shaped id is refused", codexProviderShapeError({ ...custom, id: 'a"b' }) !== null && codexProviderShapeError({ ...custom, id: "Bad" }) !== null);
check("(1) https URL ok", codexProviderUrlError("https://api.example.com/v1") === null);
check("(1) http to loopback ok (127.0.0.1, localhost, [::1])",
  codexProviderUrlError("http://127.0.0.1:8080/v1") === null && codexProviderUrlError("http://localhost:8080") === null && codexProviderUrlError("http://[::1]:8080/v1") === null);
check("(1) http to a NON-loopback host is refused", codexProviderUrlError("http://api.example.com/v1") !== null);
check("(1) '%' anywhere in the URL is refused (cmd.exe %VAR% expansion via the .cmd shim), with a clear reason",
  ["https://api.example.com/v1/%USERNAME%", "https://api.example.com/v1/%LOOM_CODEX_PROVIDER_KEY%", "https://api.example.com/a%20b"].every((u) => /'%' or '\^'/.test(codexProviderUrlError(u) ?? "")));
check("(1) '^' anywhere in the URL is refused", /'%' or '\^'/.test(codexProviderUrlError("https://api.example.com/v1/a^b") ?? ""));
check("(1) CONTROL: a plain path with no % or ^ still passes", codexProviderUrlError("https://api.example.com/v1/plain-path") === null);
check("(1) embedded credentials refused", codexProviderUrlError("https://user:pw@api.example.com/v1") !== null);
check("(1) query / fragment refused", codexProviderUrlError("https://api.example.com/v1?x=1") !== null && codexProviderUrlError("https://api.example.com/v1#f") !== null);
check("(1) quote / backslash / whitespace / control chars refused (TOML + argv injection)",
  ['https://a.example/v1"', "https://a.example/v1\\x", "https://a.example/ v1", "https://a.example/v1\n"].every((u) => codexProviderUrlError(u) !== null));
check("(1) non-http scheme refused", codexProviderUrlError("ftp://a.example/v1") !== null && codexProviderUrlError("file:///etc/passwd") !== null);
check("(1) over-long URL refused", codexProviderUrlError("https://a.example/" + "x".repeat(600)) !== null);
check("(1) endpointHostname normalises URL, host:port and bare host to the same hostname",
  endpointHostname("https://API.Example.com:8443/v1") === "api.example.com" && endpointHostname("api.example.com:8443") === "api.example.com" && endpointHostname("api.example.com") === "api.example.com");

const fakeDb = (rows) => ({ getConnection: (id) => rows[id] });
check("(1) binding: matching host passes", codexProviderBindingError(custom, fakeDb({ c1: { host: "api.example.com", authScheme: "api-key" } })) === null);
check("(1) binding: a Connection stored as a URL with a port still matches by hostname",
  codexProviderBindingError(custom, fakeDb({ c1: { host: "https://api.example.com:443", authScheme: "bearer" } })) === null);
check("(1) binding: HOST MISMATCH is refused (the key may only go to the host it was stored for)",
  /must equal the Connection's host/.test(codexProviderBindingError(custom, fakeDb({ c1: { host: "evil.example.net", authScheme: "api-key" } })) ?? ""));
check("(1) binding: unknown connection refused", codexProviderBindingError(custom, fakeDb({})) !== null);
check("(1) binding: oauth2 / ssh connections refused", codexProviderBindingError(custom, fakeDb({ c1: { host: "api.example.com", authScheme: "oauth2" } })) !== null
  && codexProviderBindingError(custom, fakeDb({ c1: { host: "api.example.com", authScheme: "ssh" } })) !== null);
check("(1) binding: unparseable connection host fails CLOSED", codexProviderBindingError(custom, fakeDb({ c1: { host: "", authScheme: "api-key" } })) !== null);
check("(1) binding: a built-in provider has nothing to bind", codexProviderBindingError({ id: "ollama" }, fakeDb({})) === null);

// ===================== (2) validateProfile + trust boundary =====================
const base = { name: "P", role: "worker", harness: "codex" };
const v1 = validateProfile({ ...base, codexProvider: custom });
check("(2) validateProfile accepts a codex profile with a custom provider AND returns it (return-literal layer)", v1.ok && v1.value.codexProvider?.id === "myhost" && v1.value.codexProvider.connectionId === "c1");
const v2 = validateProfile({ name: "P", role: "worker", codexProvider: custom });
check("(2) a provider on a CLAUDE (default-harness) profile is refused", !v2.ok && /requires harness "codex"/.test(v2.error));
const v3 = validateProfile({ ...base, harness: "claude", codexProvider: custom });
check("(2) a provider on an explicit claude profile is refused", !v3.ok);
const v4 = validateProfile({ ...base, codexProvider: { id: "myhost", baseUrl: "http://api.example.com/v1", connectionId: "c1" } });
check("(2) validateProfile surfaces a URL rule violation", !v4.ok && /https/.test(v4.error));
const v5 = validateProfile({ ...base, codexProvider: null });
check("(2) an explicit null clear validates and normalizes to null", v5.ok && v5.value.codexProvider === null);
const v6 = validateProfile({ ...base });
check("(2) an absent provider normalizes to null (positive control: the field IS in the return literal)", v6.ok && v6.value.codexProvider === null && v6.value.harness === "codex");
check("(2) unknown sub-keys on codexProvider are rejected (strict)", !validateProfile({ ...base, codexProvider: { ...custom, apiKey: "sk-secret" } }).ok);
check("(2) agentProfileKeyError REJECTS codexProvider on any agent write path (human-only)", /codexProvider may not be set via an agent MCP tool/.test(agentProfileKeyError({ name: "x", codexProvider: custom }) ?? ""));
check("(2) agentProfileKeyError stays quiet on an unrelated key (negative control)", agentProfileKeyError({ name: "x" }) === null);
const grantBefore = { connections: [], capabilities: [], vaultWrite: false, harness: "codex", browserTesting: false, documentConversion: false, allowDelta: [], codexProvider: null };
check("(2) grant reach: ADDING a provider is a newly-granted key", addedProfileGrants(grantBefore, { ...grantBefore, codexProvider: custom }).includes("codexProvider"));
check("(2) grant reach: CHANGING the endpoint is a newly-granted key", addedProfileGrants({ ...grantBefore, codexProvider: custom }, { ...grantBefore, codexProvider: { ...custom, baseUrl: "https://other.example.com/v1" } }).includes("codexProvider"));
check("(2) grant reach: re-saving it unchanged, or REMOVING it, grants nothing",
  !addedProfileGrants({ ...grantBefore, codexProvider: custom }, { ...grantBefore, codexProvider: { ...custom } }).includes("codexProvider")
  && !addedProfileGrants({ ...grantBefore, codexProvider: custom }, grantBefore).includes("codexProvider"));

// ===================== (3) Db round-trip + session pin chokepoint =====================
const db = new Db();
db.insertProfile({ id: "pc", name: "Codex custom", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex", codexProvider: custom });
db.insertProfile({ id: "pn", name: "Codex plain", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
check("(3) insertProfile persists codexProvider and getProfile reads it back", JSON.stringify(db.getProfile("pc").codexProvider) === JSON.stringify(custom));
check("(3) an unset profile reads back absent", db.getProfile("pn").codexProvider === undefined);
db.updateProfile("pn", { description: "touched" });
db.updateProfile("pc", { description: "touched" });
check("(3) an UNRELATED update leaves the stored provider untouched (undefined = leave)", JSON.stringify(db.getProfile("pc").codexProvider) === JSON.stringify(custom));
db.updateProfile("pc", { codexProvider: { ...custom, baseUrl: "https://api.example.com/v2" } });
check("(3) updateProfile with a new value replaces it", db.getProfile("pc").codexProvider.baseUrl.endsWith("/v2"));
db.updateProfile("pc", { codexProvider: null });
check("(3) updateProfile with null CLEARS it", db.getProfile("pc").codexProvider === undefined);
db.updateProfile("pc", { codexProvider: custom });

let pinCheckSkipped = false;
try {
  const projectId = "proj";
  const now = new Date().toISOString();
  db.insertProject({ id: projectId, name: "proj", repoPath: process.cwd(), vaultPath: process.cwd(), config: {}, createdAt: now, archivedAt: null });
  const agentFor = (id, profileId) => { const a = { id, projectId, name: id, startupPrompt: "", position: 0, profileId, connections: [], capabilities: [] }; db.insertAgent(a); return a; };
  const aC = agentFor("agent-c", "pc");
  const aN = agentFor("agent-n", "pn");
  const sess = (id, agentId, extra) => ({ id, projectId, agentId, engineSessionId: null, title: id, cwd: process.cwd(), processState: "exited", resumability: "none", busy: false, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, ...extra });
  db.insertSession(sess("s-codex", aC.id, { harness: "codex" }));
  db.insertSession(sess("s-claude", aC.id, {}));
  db.insertSession(sess("s-plain-codex", aN.id, { harness: "codex" }));
  db.insertSession(sess("s-carry", aN.id, { harness: "codex", codexProvider: { id: "ollama" } }));
  check("(3) pin: a CODEX row takes its agent's profile endpoint at insert", JSON.stringify(db.getSession("s-codex").codexProvider) === JSON.stringify(custom));
  check("(3) pin: a NON-codex row never pins one, even though its profile carries one", db.getSession("s-claude").codexProvider === undefined);
  check("(3) pin: a codex row whose profile has none pins none", db.getSession("s-plain-codex").codexProvider === undefined);
  check("(3) pin: an explicit carried pin (worker recycle) wins over the profile", db.getSession("s-carry").codexProvider?.id === "ollama");
  db.updateProfile("pc", { codexProvider: null });
  check("(3) pin: a LATER profile edit does not move an already-pinned row (resume keeps the endpoint)", JSON.stringify(db.getSession("s-codex").codexProvider) === JSON.stringify(custom));
  db.updateProfile("pc", { codexProvider: custom });
} catch (e) {
  pinCheckSkipped = true;
  console.log(`FAIL  (3) pin block threw: ${e?.message ?? e}`); failures++;
}
check("(3) pin block ran to completion", !pinCheckSkipped);

// ===================== (4) buildCodexProviderArgs =====================
const argsC = buildCodexProviderArgs(custom);
check("(4) custom: exact argv", JSON.stringify(argsC) === JSON.stringify([
  "-c", 'model_provider="myhost"',
  "-c", 'model_providers.myhost.name="myhost"',
  "-c", 'model_providers.myhost.base_url="https://api.example.com/v1"',
  "-c", `model_providers.myhost.env_key="${CODEX_PROVIDER_KEY_ENV_VAR}"`,
  "-c", 'model_providers.myhost.wire_api="responses"',
  "-c", `shell_environment_policy.exclude=["${CODEX_PROVIDER_KEY_ENV_VAR}"]`,
]));
check("(4) built-in: NO shell_environment_policy override (no key rides env)", buildCodexProviderArgs({ id: "ollama" }).every((a) => !a.includes("shell_environment_policy")));
check("(4) custom: env_key is the fixed Loom-owned NAME, and no argv element holds a key-looking value", argsC.every((a) => !/sk-|secret/i.test(a)) && CODEX_PROVIDER_KEY_ENV_VAR === "LOOM_CODEX_PROVIDER_KEY");
check("(4) built-in: ONLY model_provider (no base_url / env_key)", JSON.stringify(buildCodexProviderArgs({ id: "lmstudio" })) === JSON.stringify(["-c", 'model_provider="lmstudio"']));
check("(4) none ⇒ [] (byte-identical spawn)", buildCodexProviderArgs(undefined).length === 0 && buildCodexProviderArgs(null).length === 0);
check("(4) an INVALID pin returns [] — never a partial set", buildCodexProviderArgs({ ...custom, baseUrl: 'https://a.example/v1"; x="' }).length === 0 && buildCodexProviderArgs({ id: "openai", baseUrl: "https://a.example", connectionId: "c" }).length === 0);

// ===================== (5) spawn-time env/argv contract =====================
const SECRET = "dummy-secret-DO-NOT-LOG";
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const mkHost = (pin, secrets, connHost = "api.example.com") => new PtyHost(events, {
  getCodexProvider: () => pin,
  resolveConnectionSecret: (cid, pid) => (pid === "proj" ? secrets[cid] : undefined),
  getConnectionForBinding: (cid) => (cid in secrets ? { host: connHost, authScheme: "api-key" } : undefined),
});
const logs = [];
const origWarn = console.warn; console.warn = (...a) => { logs.push(a.join(" ")); };
{
  const env = {};
  const a = mkHost(custom, { c1: SECRET }).applyCodexProvider({ sessionId: "s1", projectId: "proj" }, env);
  check("(5) env carries the secret under the fixed var, and ONLY there", env[CODEX_PROVIDER_KEY_ENV_VAR] === SECRET && Object.keys(env).length === 1);
  check("(5) argv never contains the secret", a.length > 0 && a.every((x) => !x.includes(SECRET)));
}
{
  const env = {};
  const a = mkHost({ id: "ollama" }, {}).applyCodexProvider({ sessionId: "s2", projectId: "proj" }, env);
  check("(5) built-in provider: argv set, NO env var, no secret lookup", a.length === 2 && !(CODEX_PROVIDER_KEY_ENV_VAR in env));
}
{
  const env = {};
  const a = mkHost(undefined, {}).applyCodexProvider({ sessionId: "s3", projectId: "proj" }, env);
  check("(5) no pin: [] and an untouched env", a.length === 0 && Object.keys(env).length === 0);
}
for (const [label, host, pid] of [
  ["a Connection whose host no longer matches the URL host (spawn-time binding re-check)", mkHost(custom, { c1: SECRET }, "evil.example.net"), "proj"],
  ["revoked/unknown connection", mkHost(custom, {}), "proj"],
  ["out-of-project scope", mkHost(custom, { c1: SECRET }), "other-project"],
  ["an invalid pinned row", mkHost({ ...custom, baseUrl: "http://evil.example.com" }, { c1: SECRET }), "proj"],
]) {
  let threw = null; const env = {};
  try { host.applyCodexProvider({ sessionId: "sx", projectId: pid }, env); } catch (e) { threw = e; }
  check(`(5) FAIL CLOSED on ${label}: throws, env untouched, no fallback to codex's default`, !!threw && !(CODEX_PROVIDER_KEY_ENV_VAR in env) && /refusing to fall back/.test(threw.message));
  check(`(5) ${label}: the error text carries NO secret`, !!threw && !threw.message.includes(SECRET));
}
{
  // POSITIVE CONTROL for the binding re-check: a MATCHING host still spawns (so the mismatch refusal above is the check, not a blanket failure).
  const env = {};
  const a = mkHost(custom, { c1: SECRET }, "https://api.example.com:443").applyCodexProvider({ sessionId: "sok", projectId: "proj" }, env);
  check("(5) binding re-check passes on a matching host (URL-form host, port ignored)", a.length > 0 && env[CODEX_PROVIDER_KEY_ENV_VAR] === SECRET);
}
// A CORRUPT stored sessions.codex_provider must read back as an always-invalid pin and REFUSE the spawn — never
// as "no pin" (which would fall through to codex's default, billed provider).
{
  const corruptDb = new Db(process.env.LOOM_HOME + "/corrupt.db");
  const t = new Date().toISOString();
  corruptDb.insertProject({ id: "pz", name: "pz", repoPath: process.cwd(), vaultPath: process.cwd(), config: {}, createdAt: t, archivedAt: null });
  corruptDb.insertAgent({ id: "az", projectId: "pz", name: "az", startupPrompt: "", position: 0, profileId: null, connections: [], capabilities: [] });
  const mk = (id) => ({ id, projectId: "pz", agentId: "az", engineSessionId: null, title: id, cwd: process.cwd(), processState: "exited", resumability: "none", busy: false, createdAt: t, lastActivity: t, lastError: null, role: "worker", harness: "codex" });
  corruptDb.insertSession(mk("z-bad-json"));
  corruptDb.insertSession(mk("z-bad-shape"));
  corruptDb.insertSession(mk("z-empty"));
  corruptDb.db.prepare("UPDATE sessions SET codex_provider = ? WHERE id = ?").run("{not json", "z-bad-json");
  corruptDb.db.prepare("UPDATE sessions SET codex_provider = ? WHERE id = ?").run('{"id":42}', "z-bad-shape");
  const corruptHost = new PtyHost(events, { getCodexProvider: (sid) => corruptDb.getSession(sid)?.codexProvider, resolveConnectionSecret: () => SECRET, getConnectionForBinding: () => ({ host: "api.example.com", authScheme: "api-key" }) });
  for (const sid of ["z-bad-json", "z-bad-shape"]) {
    const pin = corruptDb.getSession(sid).codexProvider;
    check(`(5) corrupt column ${sid}: reads back as a pin (NOT undefined/none)`, pin !== undefined && buildCodexProviderArgs(pin).length === 0);
    let threw = null; const env = {};
    try { corruptHost.applyCodexProvider({ sessionId: sid, projectId: "pz" }, env); } catch (e) { threw = e; }
    check(`(5) corrupt column ${sid}: the spawn is REFUSED, env untouched`, !!threw && /refusing to fall back/.test(threw.message) && !(CODEX_PROVIDER_KEY_ENV_VAR in env));
  }
  check("(5) CONTROL: an untouched NULL column still reads back as no pin", corruptDb.getSession("z-empty").codexProvider === undefined);
  corruptDb.close();
}
{
  // buildSpawnEnv scrubs an AMBIENT copy of the key var from the daemon's own env (the only legitimate source is applyCodexProvider).
  const { buildSpawnEnv } = await import("../dist/pty/host.js");
  const AMB = "ambient-DO-NOT-FORWARD";
  const out = buildSpawnEnv({ PATH: "/usr/bin", [CODEX_PROVIDER_KEY_ENV_VAR]: AMB, KEEP_ME: "1" }, {}, "/w", false);
  check("(5) buildSpawnEnv scrubs an AMBIENT LOOM_CODEX_PROVIDER_KEY", !(CODEX_PROVIDER_KEY_ENV_VAR in out) && !JSON.stringify(out).includes(AMB));
  check("(5) CONTROL: ... while an unrelated ambient var survives", out.KEEP_ME === "1");
}
console.warn = origWarn;
db.close();
check("(5) no log line captured during the contract carries the secret", logs.every((l) => !l.includes(SECRET)));
check("(5) positive control: the fail-closed path DID log something (so the scan above could have fired)", logs.length > 0);

finishAndExit(failures);
