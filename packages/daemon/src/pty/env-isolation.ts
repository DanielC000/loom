/**
 * Card fafae623: rewrite a stdio MCP mount's `command`/`args` so claude launches Loom's own
 * env-isolating launcher (assets/env-isolated-launch.mjs) instead of the real target directly. The
 * launcher rebuilds the real target's child env from ONLY a small fixed base allowlist (read from the
 * launcher's OWN inherited env, which is claude's full process env merged with this mount's own `env`
 * additions — see buildMcpServers/resolveCapabilityServer) plus the named `allowKeys` passed here — key
 * NAMES only ever ride argv (process-listing-visible, never secret VALUES, which are read from the
 * launcher's own env at its own startup and never logged or placed on an intermediate argv). Every other
 * inherited env var — `LOOM_MCP_TOKEN`, a delivered project credential meant for a DIFFERENT mount, the
 * daemon's own ambient process env — is absent from the real target's env by construction.
 *
 * Mutates `mount` in place (`command`/`args` only) — `env` is deliberately untouched by this function, so
 * it still merges onto the LAUNCHER's own inherited env exactly as before (claude's existing, measured
 * merge behavior), which is how the launcher gets access to THIS mount's own declared secret/output-dir
 * value in the first place.
 *
 * @decision fafae623 — never call this for an `http` mount (any first-party Loom mount, or any other
 * HTTP-type integration) — those aren't subprocesses and have no env-inheritance exposure to isolate;
 * callers gate on the same non-http check `blanksMcpToken` (pty/host.ts) already uses.
 */
import { ENV_ISOLATED_LAUNCH_SCRIPT } from "../paths.js";

export function wrapStdioMountWithEnvIsolation(
  mount: { command?: string; args?: string[] },
  allowKeys: readonly string[],
): void {
  if (typeof mount.command !== "string") return; // malformed/absent command — nothing to wrap
  const realCommand = mount.command;
  const realArgs = mount.args ?? [];
  mount.args = [ENV_ISOLATED_LAUNCH_SCRIPT, "--allow", allowKeys.join(","), "--", realCommand, ...realArgs];
  mount.command = process.execPath;
}
