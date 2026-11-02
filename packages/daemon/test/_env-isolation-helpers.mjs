// Shared test helper (card fafae623): every stdio MCP mount `buildMcpServers`/`resolveCapabilityServer`
// returns is now rewritten to route through Loom's env-isolating launcher
// (assets/env-isolated-launch.mjs) — `command` becomes `process.execPath`, `args` becomes
// `[ENV_ISOLATED_LAUNCH_SCRIPT, "--allow", csv, "--", realCommand, ...realArgs]`. Tests that used to
// assert a mount's RAW command/args must instead unwrap it first — this is the ONE place that unwrap
// logic lives, so three test files can't independently drift on it.
import { ENV_ISOLATED_LAUNCH_SCRIPT } from "../dist/paths.js";

/** Returns {realCommand, realArgs, allowKeys} for a mount wrapped by `wrapStdioMountWithEnvIsolation`,
 *  or `null` if `mount` doesn't look wrapped (e.g. an http mount, or wrapping regressed). */
export function unwrapLauncherMount(mount) {
  if (!mount || mount.command !== process.execPath) return null;
  const args = mount.args ?? [];
  if (args[0] !== ENV_ISOLATED_LAUNCH_SCRIPT || args[1] !== "--allow" || args[3] !== "--") return null;
  const allowKeys = (args[2] ?? "").split(",").filter(Boolean);
  return { realCommand: args[4], realArgs: args.slice(5), allowKeys };
}
