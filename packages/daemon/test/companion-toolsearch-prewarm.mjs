import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion ToolSearch pre-warm (Platform card be8c2c12): the harness defers MCP tools by a blanket,
// count-independent policy Loom can't influence (verified against a real 2-tool worker MCP surface still
// being deferred) — so instead of a dedicated eager endpoint, ASSISTANT_BASE_BRIEF now instructs the
// companion to ToolSearch its `chat_reply` (+ `my_context`) BEFORE going silent on its startup turn, so
// the first real inbound message doesn't pay the discovery round-trip. DETERMINISTIC + CLAUDE-FREE +
// hermetic (no db, no daemon, no network — pure string assertions against the composed brief). Proves
// the pre-warm directive is present, still frames the startup turn as SILENT (no capability change), and
// that composition behavior is otherwise unchanged.
const { ASSISTANT_BASE_BRIEF, composeAssistantStartupPrompt } = await import("../dist/sessions/assistant-prompt.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const brief = ASSISTANT_BASE_BRIEF;

check("brief instructs a ToolSearch pre-warm before going silent", /ToolSearch/.test(brief));
check("pre-warm names chat_reply", /ToolSearch[^]*?`chat_reply`/.test(brief));
check("pre-warm names my_context in the same call", /ToolSearch[^]*?`chat_reply`[^]*?`my_context`/.test(brief));
check("pre-warm is framed as resolving tools NOW, ahead of the silent wait", /resolve your reply tool now/i.test(brief));
check("pre-warm explicitly does NOT count as a reply", /not a message to the user/i.test(brief));
check("brief still tells the companion to stay silent / produce no output on initial boot",
  /do nothing and produce no output/i.test(brief) && /still stay silent/i.test(brief));

// composeAssistantStartupPrompt / appendMemoryRecallToStartupPrompt behavior is unchanged: the pre-warm
// directive is baked into ASSISTANT_BASE_BRIEF itself, so composition still works exactly as before.
check("compose(undefined) === the base brief alone (composition unchanged)", composeAssistantStartupPrompt(undefined) === ASSISTANT_BASE_BRIEF);
check("compose(brief) still prepends base then '---' then the agent brief (composition unchanged)",
  composeAssistantStartupPrompt("MY BRIEF") === `${ASSISTANT_BASE_BRIEF}\n\n---\n\nMY BRIEF`);

console.log(failures === 0
  ? "\n✅ ALL PASS — ASSISTANT_BASE_BRIEF now pre-warms ToolSearch for chat_reply/my_context ahead of the companion's silent startup turn, with no capability change and composition behavior unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
