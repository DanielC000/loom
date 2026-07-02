import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion Reminders s2: ASSISTANT_BASE_BRIEF teaches the companion it can set ONE-SHOT reminders
// via wake_me (already-reachable universal MCP tools — no MCP/allowlist change here, doc-only). DETERMINISTIC
// + CLAUDE-FREE + hermetic (no db, no daemon, no network — pure string assertions against the composed brief).
// Proves the card's DoD: the brief mentions wake_me/wake_list/wake_cancel, frames a fired reminder as a
// [loom:reminder] turn the companion SHOULD act on + chat_reply about, and keeps that framing distinct from
// (not contradicting) the SILENT [loom:memory] recall framing already in the brief.
const { ASSISTANT_BASE_BRIEF, composeAssistantStartupPrompt } = await import("../dist/sessions/assistant-prompt.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const brief = ASSISTANT_BASE_BRIEF;

check("brief has a Reminders section", /## Reminders/.test(brief));
check("brief teaches wake_me with note + delaySeconds/wakeAt", /wake_me/.test(brief) && /note/.test(brief) && /delaySeconds/.test(brief) && /wakeAt/.test(brief));
check("brief documents the min/max bounds (30s / 24h)", /30s/.test(brief) && /24h/.test(brief));
check("brief teaches wake_list", /wake_list/.test(brief));
check("brief teaches wake_cancel(wakeId)", /wake_cancel/.test(brief) && /wakeId/.test(brief));
check("brief says a fired reminder arrives as a [loom:reminder] turn", /\[loom:reminder\]/.test(brief));
check("brief frames a fired reminder as something to ACT ON and chat_reply about",
  /\[loom:reminder\][^]*?(act on it|chat_reply)/i.test(brief) || /act on it[^]*?chat_reply/i.test(brief));
check("brief ties the reminder framing to the SAME chat channel it was set from",
  /SAME chat channel/i.test(brief));

// Distinct-from-memory framing: the brief must contrast [loom:reminder] (act) against [loom:memory]
// (silent) rather than contradicting the memory section's "never chat_reply just because it arrived" rule.
check("brief keeps the memory-recall section's SILENT framing intact (unchanged contradiction guard)",
  /\[loom:memory\][^]*?SILENT background context/i.test(brief) && /never[^]*?`chat_reply`\s*just because it arrived/i.test(brief));
check("brief explicitly calls the reminder framing the OPPOSITE of the silent memory recall",
  /OPPOSITE[^]*?\[loom:memory\]/i.test(brief) || /\[loom:memory\][^]*?OPPOSITE/i.test(brief));

// composeAssistantStartupPrompt / appendMemoryRecallToStartupPrompt behavior is unchanged: the reminders
// section is baked into ASSISTANT_BASE_BRIEF itself, so composition still works exactly as before.
check("compose(undefined) === the base brief alone (composition unchanged)", composeAssistantStartupPrompt(undefined) === ASSISTANT_BASE_BRIEF);
check("compose(brief) still prepends base then '---' then the agent brief (composition unchanged)",
  composeAssistantStartupPrompt("MY BRIEF") === `${ASSISTANT_BASE_BRIEF}\n\n---\n\nMY BRIEF`);

console.log(failures === 0
  ? "\n✅ ALL PASS — ASSISTANT_BASE_BRIEF teaches wake_me/wake_list/wake_cancel with a fired reminder framed as an act-on-it [loom:reminder] turn, kept distinct from the silent [loom:memory] recall framing, with composition behavior unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
