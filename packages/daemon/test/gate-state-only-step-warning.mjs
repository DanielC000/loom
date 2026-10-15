// Card c6543bbd, from a real escalation (f0e38d76): a gateCommand like `cd web && npm ci && npm test`
// runs `cd web` as its OWN process (splitGateSteps splits on top-level "&&"), so that cwd change never
// reaches `npm ci`/`npm test`. HERMETIC: pure functions, no daemon, no spawn — drives
// orchestration/gate-runner.js's exported helpers directly against the BUILT dist output.
// Run: 1) pnpm build (or `pnpm --filter @loom/daemon build`), 2) node packages/daemon/test/gate-state-only-step-warning.mjs
import { gateStateOnlyStepWarning, gateCommandFieldWarnings } from "../dist/orchestration/gate-runner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- the exact DoD case: `cd web && npm test` warns, naming `cd web` ---
const cdWeb = gateStateOnlyStepWarning("cd web && npm test");
check("(DoD) `cd web && npm test` returns a warning", typeof cdWeb === "string" && cdWeb.length > 0);
check('(DoD) the warning NAMES the offending step `"cd web"`', cdWeb?.includes('"cd web"'));
check("(DoD) the warning suggests the per-step form", cdWeb?.includes("--prefix"));

// --- negative control: a normal (no state-only step) command returns no warning ---
check("(negative control) a plain single-step command returns undefined",
  gateStateOnlyStepWarning("npm test") === undefined);
check("(negative control) a plain multi-step command (no builtin step) returns undefined",
  gateStateOnlyStepWarning("pnpm lint && pnpm test && pnpm build") === undefined);

// --- every listed builtin triggers the same way (cd, pushd, set, export, source, the "." alias) ---
check("(builtin) pushd", gateStateOnlyStepWarning("pushd web && npm test")?.includes('"pushd web"'));
check("(builtin) set", gateStateOnlyStepWarning("set FOO=bar && npm test")?.includes('"set FOO=bar"'));
check("(builtin) export", gateStateOnlyStepWarning("export FOO=bar && npm test")?.includes('"export FOO=bar"'));
check("(builtin) source", gateStateOnlyStepWarning("source ./env.sh && npm test")?.includes('"source ./env.sh"'));
check('(builtin) POSIX dot-source alias (".")', gateStateOnlyStepWarning(". ./env.sh && npm test")?.includes('". ./env.sh"'));

// --- word-boundary negative controls: a step merely STARTING with a builtin's letters is not a match ---
check("(word boundary) \"cdx web\" (not `cd`) is not flagged",
  gateStateOnlyStepWarning("cdx web && npm test") === undefined);
check("(word boundary) \"settings-test\" (not `set`) is not flagged",
  gateStateOnlyStepWarning("settings-test && npm test") === undefined);

// --- the LAST step is exempt even if it matches — there's no "next step" for it to fail to reach ---
check("(last-step exemption) `npm test && cd web` (cd is the LAST step) returns undefined",
  gateStateOnlyStepWarning("npm test && cd web") === undefined);
check("(last-step exemption) a lone single-step `cd web` (no `&&` at all) returns undefined",
  gateStateOnlyStepWarning("cd web") === undefined);

// --- a step that CHAINS a second command after the builtin, in the SAME step, is not state-only: its
// effect DOES reach something (the rest of that same process) ---
check("(chained-in-step) `cd web; npm test` as ONE step (no top-level &&) is not flagged",
  gateStateOnlyStepWarning("cd web; npm test") === undefined);
check("(chained-in-step) `cd web && npm test; npm run lint` — the chained SECOND step is unaffected",
  gateStateOnlyStepWarning("cd web && npm test; npm run lint")?.includes('"cd web"'));

// --- multiple offending steps are all named ---
const twoOffenders = gateStateOnlyStepWarning("cd web && export FOO=bar && npm test");
check("(multiple) both offending steps are named in one warning",
  twoOffenders?.includes('"cd web"') && twoOffenders?.includes('"export FOO=bar"'));

// --- gateCommandFieldWarnings: the multi-field wrapper used by project_configure / the REST PATCH ---
check("(fields) an undefined field is skipped, no warning",
  gateCommandFieldWarnings({ gateCommand: undefined }) === undefined);
check("(fields) an empty-string field is skipped, no warning",
  gateCommandFieldWarnings({ gateCommand: "" }) === undefined);
check("(fields) a clean gateCommand alongside an undefined deployCommand returns undefined",
  gateCommandFieldWarnings({ gateCommand: "pnpm build", deployCommand: undefined }) === undefined);
const fieldsWarning = gateCommandFieldWarnings({
  gateCommand: "cd web && npm test",
  ungatedLandingCheckCommand: "pnpm build",
  deployCommand: "export FOO=bar && pnpm deploy",
});
check("(fields) only the offending fields are named, each prefixed by its own field name",
  fieldsWarning?.includes("gateCommand:") && fieldsWarning?.includes("deployCommand:") && !fieldsWarning?.includes("ungatedLandingCheckCommand:"));

console.log(failures === 0
  ? "\n✅ ALL PASS — a state-only shell-builtin step (cd/pushd/set/export/source) that cannot reach the next `&&` step is flagged; an ordinary gate is not."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
