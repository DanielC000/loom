import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// windowsPowerShellEnv (capabilities/powershell-env.ts): strips PSModulePath in ANY casing (Windows env keys are
// case-insensitive), preserves every other key, and never mutates its input.
import { windowsPowerShellEnv } from "../dist/capabilities/powershell-env.js";

let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

for (const key of ["PSModulePath", "PSMODULEPATH", "psmodulepath"]) {
  const base = { [key]: "C:\\Program Files\\PowerShell\\7\\Modules", Path: "C:\\x", LOOM_KEEP: "1" };
  const out = windowsPowerShellEnv(base);
  check(`${key} is removed`, !Object.keys(out).some((k) => k.toLowerCase() === "psmodulepath"));
  check(`${key}: other keys preserved`, out.Path === "C:\\x" && out.LOOM_KEEP === "1");
  check(`${key}: input not mutated`, key in base);
}
// Negative control: an env with no PSModulePath passes through unchanged.
check("no PSModulePath -> identical contents", JSON.stringify(windowsPowerShellEnv({ A: "1", B: "2" })) === JSON.stringify({ A: "1", B: "2" }));
// Negative control for the case-insensitivity: a key merely CONTAINING the name is kept.
check("a similarly-named key is kept", windowsPowerShellEnv({ XPSModulePath: "1" }).XPSModulePath === "1");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
