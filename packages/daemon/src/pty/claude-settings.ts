import fs from "node:fs";
import path from "node:path";
import type { PermissionPolicy } from "@loom/shared";
import { SETTINGS_DIR, RELAY_SCRIPT, PORT } from "../paths.js";

/**
 * Write the per-session --settings file: the hooks that relay back to the daemon, plus the
 * resolved permission policy. SessionStart captures the engine id; UserPromptSubmit/Stop/
 * StopFailure drive the busy state machine (rising/falling edges). acceptEdits + allowlist
 * avoids the "Bypass Permissions mode" acceptance gate that --dangerously-skip-permissions
 * triggers. (All behaviors validated in the spike.)
 */
export function writeSessionSettings(sessionId: string, permission: PermissionPolicy): string {
  const hookCmd = {
    hooks: [{ type: "command", command: `node "${RELAY_SCRIPT}" ${sessionId} ${PORT}` }],
  };
  const settings = {
    hooks: {
      SessionStart: [hookCmd],
      UserPromptSubmit: [hookCmd],
      Stop: [hookCmd],
      StopFailure: [hookCmd],
    },
    permissions: {
      defaultMode: permission.mode,
      allow: permission.allow,
      deny: permission.deny,
    },
  };
  const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  return file;
}
