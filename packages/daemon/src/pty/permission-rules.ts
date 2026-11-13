/**
 * The ONE place Loom turns an absolute filesystem path into a Claude Code `permissions.deny` glob.
 * Pure (no imports) so any emitter can use it without a cycle.
 *
 * @decision 8d0ba38b — a single-slash absolute rule is INERT on POSIX (anchors at the settings file's dir);
 * emit `//<path>` only via these helpers, never a hand-built `Read(${absPath}…)`.
 */

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Convert an absolute path into the CLI's documented universal-absolute glob form — `//<path>` on POSIX,
 * `//<drive-letter>/<rest>` on Windows (lowercase drive, no colon).
 */
export function toClaudeAbsoluteGlob(absPath: string): string {
  const slashed = toForwardSlash(absPath);
  const winDrive = /^(?<drive>[A-Za-z]):\/(?<rest>.*)$/.exec(slashed);
  if (winDrive?.groups) {
    return `//${winDrive.groups.drive!.toLowerCase()}/${winDrive.groups.rest}`;
  }
  return `/${slashed}`;
}

/**
 * Every absolute-path glob form to emit for `absPath`. POSIX: only the documented `//` form. win32: that
 * form PLUS the plain `C:/…` form, because `C:/…` is the form measured working on Windows (claude 2.1.286+)
 * before the documented form was adopted and the two are not proven interchangeable there.
 */
export function claudeAbsoluteGlobForms(absPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const universal = toClaudeAbsoluteGlob(absPath);
  if (platform !== "win32") return [universal];
  const plain = toForwardSlash(absPath);
  return plain === universal ? [universal] : [universal, plain];
}

/** `Tool(<form><suffix>)` for every form of {@link claudeAbsoluteGlobForms}. `suffix` is e.g. `/**`. */
export function claudeAbsoluteRules(
  tool: "Read" | "Edit",
  absPath: string,
  suffix = "",
  platform: NodeJS.Platform = process.platform,
): string[] {
  return claudeAbsoluteGlobForms(absPath, platform).map((f) => `${tool}(${f}${suffix})`);
}
