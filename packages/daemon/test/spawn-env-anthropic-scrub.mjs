import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c8eeda93 — buildSpawnEnv must NOT forward the DAEMON's own inherited ANTHROPIC_* (or
// AWS_BEARER_TOKEN_BEDROCK) into a session: an inherited ANTHROPIC_API_KEY would flip the whole fleet from
// the subscription to per-token billing and ANTHROPIC_BASE_URL would silently reroute it. Pure-seam test
// (no pty, no claude, no network). The LOOM_PASS_ANTHROPIC_ENV hatch is a buildSpawnEnv PARAMETER (callers
// resolve it via isPassAnthropicEnvEnabled()), so this test never touches process.env; console.warn is
// captured, never the real stream.
//   A  inherited names (incl. mixed-case) scrubbed; unrelated vars (PATH/CLAUDE_CONFIG_DIR/proxy/AWS_PROFILE) survive;
//      the silent-scrub diagnostic is at most ONE line (keys only, no values), and a SECOND spawn logs none
//      (once-per-daemon-process latch — this block MUST run first, the latch is module-level)
//   B  a project sessionEnv ANTHROPIC_* still wins; the warn line names the KEY, never the VALUE (canary)
//   C  LOOM_PASS_ANTHROPIC_ENV=1 restores pass-through (+ names-only log); only the literal "1" counts
//   D  with no ANTHROPIC_* anywhere the env is unchanged and nothing is logged
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { buildSpawnEnv } = await import("../dist/pty/host.js");

const CANARY = "sk-CANARY-do-not-log-7f3a91";
const CANARY_URL = "http://canary-gateway.invalid/v1";
const origWarn = console.warn;
let warns = [];
console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
const run = (processEnv, sessionEnv, pass = false) => { warns = []; return buildSpawnEnv(processEnv, sessionEnv, "/w", pass); };
try {

  // ---- A ----
  const inherited = {
    PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/cfg", HTTPS_PROXY: "http://prx", AWS_PROFILE: "p",
    ANTHROPIC_API_KEY: CANARY, ANTHROPIC_AUTH_TOKEN: CANARY, ANTHROPIC_BASE_URL: CANARY_URL,
    ANTHROPIC_MODEL: "m", Anthropic_Api_Key: CANARY, anthropic_base_url: CANARY_URL,
    AWS_BEARER_TOKEN_BEDROCK: CANARY,
  };
  const a = run(inherited, {});
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "Anthropic_Api_Key", "anthropic_base_url", "AWS_BEARER_TOKEN_BEDROCK"]) {
    check(`A: inherited ${k} is scrubbed`, !(k in a));
  }
  check("A: PATH survives", a.PATH === "/usr/bin");
  check("A: CLAUDE_CONFIG_DIR survives (fbb6e8ec/a92a0913: never scrubbed)", a.CLAUDE_CONFIG_DIR === "/cfg");
  check("A: HTTPS_PROXY survives", a.HTTPS_PROXY === "http://prx");
  check("A: AWS_PROFILE survives (only the bearer token is scrubbed)", a.AWS_PROFILE === "p");
  const aLog = warns.join("\n");
  check("A: the silent-scrub diagnostic is AT MOST one line", warns.length === 1);
  check("A: that line names the scrubbed KEYS and the escape hatches", aLog.includes("ANTHROPIC_API_KEY") && aLog.includes("AWS_BEARER_TOKEN_BEDROCK") && aLog.includes("LOOM_PASS_ANTHROPIC_ENV") && aLog.includes("sessionEnv"));
  check("A: that line NEVER contains a value (canary absent)", !aLog.includes(CANARY) && !aLog.includes("sk-CANARY") && !aLog.includes("canary-gateway"));
  run(inherited, {});
  check("A: a SECOND spawn logs nothing (once-per-daemon-process latch)", warns.length === 0);
  check("A: ...and still scrubs on that second spawn", !("ANTHROPIC_API_KEY" in run(inherited, {})));

  // ---- B ----
  const b = run(inherited, { ANTHROPIC_BASE_URL: CANARY_URL, ANTHROPIC_API_KEY: CANARY });
  check("B: sessionEnv ANTHROPIC_BASE_URL still reaches the child", b.ANTHROPIC_BASE_URL === CANARY_URL);
  check("B: sessionEnv ANTHROPIC_API_KEY still reaches the child", b.ANTHROPIC_API_KEY === CANARY);
  const bLog = warns.join("\n");
  check("B: a warn line was emitted", warns.length >= 1);
  check("B: warn names ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY", bLog.includes("ANTHROPIC_BASE_URL") && bLog.includes("ANTHROPIC_API_KEY"));
  check("B: warn NEVER contains the secret value (canary)", !bLog.includes(CANARY) && !bLog.includes("sk-CANARY"));
  check("B: warn NEVER contains the URL value (canary)", !bLog.includes(CANARY_URL) && !bLog.includes("canary-gateway"));
  check("B: the inherited (non-sessionEnv) ones are still scrubbed", !("ANTHROPIC_MODEL" in b));

  // ---- C ----
  const c = run(inherited, {}, true);
  check("C: hatch=1 forwards inherited ANTHROPIC_API_KEY", c.ANTHROPIC_API_KEY === CANARY);
  check("C: hatch=1 forwards inherited ANTHROPIC_BASE_URL", c.ANTHROPIC_BASE_URL === CANARY_URL);
  check("C: hatch=1 forwards AWS_BEARER_TOKEN_BEDROCK", c.AWS_BEARER_TOKEN_BEDROCK === CANARY);
  const cLog = warns.join("\n");
  check("C: hatch=1 logs a loud line naming the keys", cLog.includes("LOOM_PASS_ANTHROPIC_ENV") && cLog.includes("ANTHROPIC_API_KEY"));
  check("C: hatch=1 log NEVER contains a value", !cLog.includes(CANARY) && !cLog.includes("canary-gateway"));
  check("C: the default (no hatch argument) scrubs", !("ANTHROPIC_API_KEY" in buildSpawnEnv(inherited, {}, "/w")));
  // the hatch is a parameter: a sessionEnv key of that name must NOT open it.
  check("C: sessionEnv LOOM_PASS_ANTHROPIC_ENV=1 does NOT open the hatch", !("ANTHROPIC_API_KEY" in run(inherited, { LOOM_PASS_ANTHROPIC_ENV: "1" })));
  // The literal-"1" rule lives in the predicate callers use. The ONLY process.env touch in this file, scoped to
  // that predicate (never buildSpawnEnv), saved and restored.
  const { isPassAnthropicEnvEnabled } = await import("../dist/paths.js");
  const savedHatch = process.env.LOOM_PASS_ANTHROPIC_ENV;
  try {
    process.env.LOOM_PASS_ANTHROPIC_ENV = "1";
    check('C: predicate true for the literal "1"', isPassAnthropicEnvEnabled() === true);
    for (const bogus of ["true", "0", "", "yes"]) {
      process.env.LOOM_PASS_ANTHROPIC_ENV = bogus;
      check(`C: predicate false for ${JSON.stringify(bogus)} (not the literal "1")`, isPassAnthropicEnvEnabled() === false);
    }
    delete process.env.LOOM_PASS_ANTHROPIC_ENV;
    check("C: predicate false when unset", isPassAnthropicEnvEnabled() === false);
  } finally {
    if (savedHatch === undefined) delete process.env.LOOM_PASS_ANTHROPIC_ENV; else process.env.LOOM_PASS_ANTHROPIC_ENV = savedHatch;
  }

  // ---- D ----
  const d = run({ PATH: "/usr/bin", FOO: "bar" }, { BAZ: "1" });
  check("D: no ANTHROPIC_* anywhere: ordinary vars pass through", d.PATH === "/usr/bin" && d.FOO === "bar" && d.BAZ === "1");
  check("D: no ANTHROPIC_* anywhere: nothing logged", warns.length === 0);
} finally {
  console.warn = origWarn;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
