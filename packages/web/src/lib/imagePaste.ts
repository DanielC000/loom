// Image paste into a terminal tile. The CLI inside the pty attaches an image by reading the HOST's OS
// clipboard on its own keypress (it never receives image bytes from the terminal), but xterm.js's paste
// handler reads only `text/plain`, so an image-only paste would reach the pty as an EMPTY bracketed
// paste. `imagePasteKey` decides when to send the CLI's own image-paste key instead.
//
// @decision 3da47390 — the key is chosen from the BROWSER's platform, never a daemon field: same-machine
// is already a precondition of this feature, and a daemon field would be a daemon change.

/** The CLI's image-paste key on a Windows host (Alt+V → ESC v). */
export const IMAGE_PASTE_KEY_WINDOWS = "\x1bv";
/** The CLI's image-paste key everywhere else (Ctrl+V → 0x16). */
export const IMAGE_PASTE_KEY_OTHER = "\x16";

/** The two fields of a `DataTransferItem` the decision reads. */
export interface ClipboardItemLike { kind: string; type: string }

/**
 * The browser's platform string, preferring the non-deprecated `userAgentData.platform` and falling back
 * to the deprecated `navigator.platform`. Why the BROWSER's and not the daemon's: the CLI reads the HOST
 * clipboard, so this feature only works when browser and daemon share a machine, and in exactly that
 * case the two platforms are the same.
 */
export function browserPlatform(nav: { userAgentData?: { platform?: string }; platform?: string } | undefined): string {
  return nav?.userAgentData?.platform || nav?.platform || "";
}

/** The CLI image-paste key for a platform string: any "Windows"/"Win32" match → ESC v, else 0x16. */
export function imagePasteKeyFor(platform: string): string {
  return /^win/i.test(platform.trim()) ? IMAGE_PASTE_KEY_WINDOWS : IMAGE_PASTE_KEY_OTHER;
}

/**
 * What an image-only paste should send, or `null` for "do nothing special" (xterm's own text paste runs,
 * byte-identical to before). Forwards only when the clipboard holds an image file AND no text/plain: a
 * text clipboard, a mixed text+image clipboard (e.g. copied from a web page) and an empty one all return
 * `null`.
 */
export function imagePasteKey(items: readonly ClipboardItemLike[], text: string, platform: string): string | null {
  if (text.length > 0) return null;
  const hasImage = items.some((i) => i.kind === "file" && i.type.toLowerCase().startsWith("image/"));
  return hasImage ? imagePasteKeyFor(platform) : null;
}
