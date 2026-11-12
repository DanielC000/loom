/**
 * Env for a child `powershell.exe` (Windows PowerShell 5.1) that must load a stock module (e.g. `Expand-Archive`).
 *
 * A daemon hosted under PowerShell 7 inherits a `PSModulePath` naming PS7's Modules dir; 5.1 then autoloads the
 * PS7 `Microsoft.PowerShell.Archive`, which calls a .NET overload absent on .NET Framework and fails. Removing
 * the variable makes 5.1 rebuild its own default module path. Windows env keys are case-insensitive, so every
 * casing is dropped; all other keys are preserved. Returns a copy — never mutates `base`.
 */
export function windowsPowerShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.toLowerCase() !== "psmodulepath") out[k] = v;
  }
  return out;
}
