import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6a94d4f0 — codex analogue of spawn-env-anthropic-scrub.mjs. buildSpawnEnv must NOT forward the
// DAEMON's own inherited OPENAI_* / CODEX_API_KEY / CODEX_ACCESS_TOKEN into a CODEX session (openAi mode
// "scrub"), while CODEX_HOME / other CODEX_* survive, and a CLAUDE spawn (default mode "off") is
// byte-identical. Pure seam (no pty, no network); the hatch is a buildSpawnEnv PARAMETER so process.env is
// only touched for the predicate check, saved and restored. console.warn is captured.
//   A  scrub: inherited names (mixed case too) dropped; CODEX_HOME/CODEX_OTHER/PATH/ANTHROPIC survive;
//      silent-scrub diagnostic is ONE line, keys only, no values; a SECOND spawn logs none (latch — runs first)
//   B  a project sessionEnv OPENAI_* still wins; warn names the KEY, never the VALUE
//   C  pass: forwards, names-only log; only the literal "1" opens the predicate; sessionEnv cannot open it
//   D  claude (default "off"): output byte-identical to the 4-arg call, OPENAI_* forwarded, no OpenAI logging
//   E  nothing relevant present: env unchanged, nothing logged
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { buildSpawnEnv } = await import("../dist/pty/host.js");

const CANARY = "sk-CANARY-do-not-log-6a94d4f0";
const CANARY_URL = "http://canary-openai.invalid/v1";
const origWarn = console.warn;
let warns = [];
console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
const run = (processEnv, sessionEnv, mode) => { warns = []; return buildSpawnEnv(processEnv, sessionEnv, "/w", false, mode); };
try {
  const inherited = {
    PATH: "/usr/bin", CODEX_HOME: "/home/.codex", CODEX_OTHER: "keep", ANTHROPIC_API_KEY: "anth",
    OPENAI_API_KEY: CANARY, OPENAI_BASE_URL: CANARY_URL, OPENAI_ORG_ID: "org", OpenAI_Api_Key: CANARY,
    openai_base_url: CANARY_URL, CODEX_API_KEY: CANARY, CODEX_ACCESS_TOKEN: CANARY, codex_api_key: CANARY,
  };
  const scrubbed = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OpenAI_Api_Key", "openai_base_url", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "codex_api_key"];

  // ---- A ----
  const a = run(inherited, {}, "scrub");
  for (const k of scrubbed) check(`A: inherited ${k} is scrubbed`, !(k in a));
  check("A: CODEX_HOME survives (the ChatGPT login home)", a.CODEX_HOME === "/home/.codex");
  check("A: other CODEX_* survives (exact-name scrub, not the prefix)", a.CODEX_OTHER === "keep");
  check("A: PATH survives", a.PATH === "/usr/bin");
  check("A: ANTHROPIC_* is not this scrub's business (passAnthropic=false still scrubs it, separately)", !("ANTHROPIC_API_KEY" in a));
  const aLog = warns.join("\n");
  const openAiLines = warns.filter((w) => w.includes("LOOM_PASS_OPENAI_ENV"));
  check("A: the silent-scrub diagnostic is exactly ONE OpenAI line", openAiLines.length === 1);
  check("A: that line names the keys and both escape hatches", aLog.includes("OPENAI_API_KEY") && aLog.includes("CODEX_API_KEY") && aLog.includes("sessionEnv"));
  check("A: that line NEVER contains a value", !aLog.includes("sk-CANARY") && !aLog.includes("canary-openai"));
  run(inherited, {}, "scrub");
  check("A: a SECOND spawn logs no OpenAI line (once-per-process latch)", !warns.some((w) => w.includes("LOOM_PASS_OPENAI_ENV")));
  check("A: ...and still scrubs on that second spawn", !("OPENAI_API_KEY" in run(inherited, {}, "scrub")));

  // ---- B ----
  const b = run(inherited, { OPENAI_BASE_URL: CANARY_URL, OPENAI_API_KEY: CANARY }, "scrub");
  check("B: sessionEnv OPENAI_BASE_URL still reaches the child", b.OPENAI_BASE_URL === CANARY_URL);
  check("B: sessionEnv OPENAI_API_KEY still reaches the child", b.OPENAI_API_KEY === CANARY);
  const bLog = warns.join("\n");
  check("B: warn names both keys", bLog.includes("OPENAI_BASE_URL") && bLog.includes("OPENAI_API_KEY"));
  check("B: warn NEVER contains a value", !bLog.includes("sk-CANARY") && !bLog.includes("canary-openai"));
  check("B: the inherited (non-sessionEnv) ones are still scrubbed", !("OPENAI_ORG_ID" in b) && !("CODEX_API_KEY" in b));

  // ---- C ----
  const c = run(inherited, {}, "pass");
  check("C: pass forwards OPENAI_API_KEY / OPENAI_BASE_URL / CODEX_API_KEY / CODEX_ACCESS_TOKEN",
    c.OPENAI_API_KEY === CANARY && c.OPENAI_BASE_URL === CANARY_URL && c.CODEX_API_KEY === CANARY && c.CODEX_ACCESS_TOKEN === CANARY);
  const cLog = warns.join("\n");
  check("C: pass logs a loud line naming the keys", cLog.includes("LOOM_PASS_OPENAI_ENV") && cLog.includes("OPENAI_API_KEY"));
  check("C: pass log NEVER contains a value", !cLog.includes("sk-CANARY") && !cLog.includes("canary-openai"));
  check("C: sessionEnv LOOM_PASS_OPENAI_ENV=1 does NOT open the hatch", !("OPENAI_API_KEY" in run(inherited, { LOOM_PASS_OPENAI_ENV: "1" }, "scrub")));
  const { isPassOpenAiEnvEnabled } = await import("../dist/paths.js");
  const saved = process.env.LOOM_PASS_OPENAI_ENV;
  try {
    process.env.LOOM_PASS_OPENAI_ENV = "1";
    check('C: predicate true for the literal "1"', isPassOpenAiEnvEnabled() === true);
    for (const bogus of ["true", "0", "", "yes"]) {
      process.env.LOOM_PASS_OPENAI_ENV = bogus;
      check(`C: predicate false for ${JSON.stringify(bogus)}`, isPassOpenAiEnvEnabled() === false);
    }
    delete process.env.LOOM_PASS_OPENAI_ENV;
    check("C: predicate false when unset", isPassOpenAiEnvEnabled() === false);
    process.env.LOOM_PASS_ANTHROPIC_ENV = "1";
    check("C: the Anthropic hatch does NOT open the OpenAI one", isPassOpenAiEnvEnabled() === false);
  } finally {
    delete process.env.LOOM_PASS_ANTHROPIC_ENV;
    if (saved === undefined) delete process.env.LOOM_PASS_OPENAI_ENV; else process.env.LOOM_PASS_OPENAI_ENV = saved;
  }

  // ---- D ----
  warns = [];
  const dDefault = buildSpawnEnv(inherited, { X: "1" }, "/w");
  const dFourArg = buildSpawnEnv(inherited, { X: "1" }, "/w", false);
  const dOff = buildSpawnEnv(inherited, { X: "1" }, "/w", false, "off");
  check("D: claude (default) forwards inherited OPENAI_API_KEY / CODEX_API_KEY untouched", dDefault.OPENAI_API_KEY === CANARY && dDefault.CODEX_API_KEY === CANARY && dDefault.CODEX_ACCESS_TOKEN === CANARY);
  check("D: omitted param, 4-arg call and explicit \"off\" produce byte-identical env", JSON.stringify(dDefault) === JSON.stringify(dFourArg) && JSON.stringify(dDefault) === JSON.stringify(dOff));
  check("D: claude path logs nothing about OpenAI", !warns.some((w) => w.includes("OPENAI") || w.includes("CODEX_API_KEY")));

  // ---- E ----
  const e = run({ PATH: "/usr/bin", FOO: "bar" }, { BAZ: "1" }, "scrub");
  check("E: nothing relevant: ordinary vars pass through", e.PATH === "/usr/bin" && e.FOO === "bar" && e.BAZ === "1");
  check("E: nothing relevant: nothing logged", warns.length === 0);
} finally {
  console.warn = origWarn;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
