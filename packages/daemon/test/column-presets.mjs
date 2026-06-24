import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board-column PRESETS guard test (card 5f). HERMETIC + pure — no daemon, no Db, no real claude. Asserts
// the HARD CONTRACT every shipped preset must uphold so it feeds straight into the atomic columns API:
//   - feeding each preset as `desired` to planColumnLayout (against BOTH the default board AND a custom
//     board as `current`) yields plan.ok === true (it would be applyable to a real project);
//   - each preset has EXACTLY one defaultLanding + EXACTLY one terminal, and any other role at most once;
//   - presetToDesired() round-trips into a payload the planner still accepts (key/label/role only);
//   - the default preset (agent-dev) matches PLATFORM_DEFAULTS' columns key/label/role (today's board).
// Run: 1) build shared + daemon, 2) node test/column-presets.mjs
import { planColumnLayout } from "../dist/tasks/columns.js";
import {
  COLUMN_PRESETS, DEFAULT_COLUMN_PRESET_ID, presetById, presetToDesired, resolveConfig, PLATFORM_DEFAULTS,
} from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Two distinct `current` boards to plan AGAINST — a preset must be a valid desired layout regardless of
// what the board currently looks like (the planner diffs desired-vs-current).
const DEFAULT_BOARD = resolveConfig({}).kanbanColumns; // the role-annotated default board
const CUSTOM_BOARD = [
  { key: "ideas", label: "Ideas", role: "defaultLanding" },
  { key: "wip", label: "WIP", role: "active" },
  { key: "shipped", label: "Shipped", role: "terminal" },
];

const roleCount = (cols, role) => cols.filter((c) => c.role === role).length;

// === every preset is internally valid (the role contract) ===
check("there are 5 presets", COLUMN_PRESETS.length === 5);
check("the default preset id resolves to a real preset", presetById(DEFAULT_COLUMN_PRESET_ID).id === DEFAULT_COLUMN_PRESET_ID);
check("an unknown/absent id falls back to the default preset", presetById("nope").id === DEFAULT_COLUMN_PRESET_ID && presetById(undefined).id === DEFAULT_COLUMN_PRESET_ID);

for (const preset of COLUMN_PRESETS) {
  const cols = preset.columns;
  check(`[${preset.id}] keeps ≥1 column`, cols.length >= 1);
  check(`[${preset.id}] EXACTLY one defaultLanding`, roleCount(cols, "defaultLanding") === 1);
  check(`[${preset.id}] EXACTLY one terminal`, roleCount(cols, "terminal") === 1);
  // every OTHER role appears at most once (a duplicate role is ambiguous for columnKeyForRole)
  const others = cols.map((c) => c.role).filter((r) => r && r !== "defaultLanding" && r !== "terminal");
  check(`[${preset.id}] no non-required role is duplicated`, new Set(others).size === others.length);
  // keys + labels non-empty and unique
  const keys = cols.map((c) => c.key);
  check(`[${preset.id}] keys are non-empty + unique`, keys.every((k) => k && k.trim()) && new Set(keys).size === keys.length);
  check(`[${preset.id}] labels are non-empty`, cols.every((c) => c.label && c.label.trim()));

  // === the load-bearing assertion: each preset PASSES planColumnLayout against multiple current boards ===
  const desired = presetToDesired(preset); // the exact payload the web sends to the atomic API
  for (const [name, current] of [["default board", DEFAULT_BOARD], ["custom board", CUSTOM_BOARD]]) {
    const plan = planColumnLayout(current, desired);
    check(`[${preset.id}] plans OK against the ${name} (plan.ok)`, plan.ok === true);
    if (plan.ok) {
      check(`[${preset.id}] planned board has exactly one defaultLanding (vs ${name})`, roleCount(plan.columns, "defaultLanding") === 1);
      check(`[${preset.id}] planned board has exactly one terminal (vs ${name})`, roleCount(plan.columns, "terminal") === 1);
      check(`[${preset.id}] plan carries a defaultLandingKey (vs ${name})`, typeof plan.defaultLandingKey === "string" && plan.defaultLandingKey.length > 0);
    }
  }
}

// === the default preset preserves today's exact board (key/label/role) ===
const agentDev = presetById(DEFAULT_COLUMN_PRESET_ID).columns;
const stripAccent = (cols) => cols.map((c) => (c.role ? { key: c.key, label: c.label, role: c.role } : { key: c.key, label: c.label }));
check("agent-dev preset === PLATFORM_DEFAULTS columns (key/label/role)",
  JSON.stringify(stripAccent(agentDev)) === JSON.stringify(stripAccent(PLATFORM_DEFAULTS.kanbanColumns)));

console.log(failures === 0
  ? "\n✅ ALL PASS — every board preset upholds the role contract (exactly one defaultLanding + terminal, no duplicate roles) and plans OK through planColumnLayout against both a default and a custom board; the default preset preserves today's board."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
