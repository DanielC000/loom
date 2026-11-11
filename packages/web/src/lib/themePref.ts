import { useSyncExternalStore } from "react";

// The colour-theme preference (Graphite epic e25fa8a9, card 593674a7): System, Light or Dark.
//
// Contract:
//   • A per-browser, HUMAN-only display preference, built as a plain localStorage preference: never project or daemon
//     config, so it goes nowhere near `resolveConfig` or any `api.ts` member.
//   • Anything stored other than exactly "system" | "light" | "dark" (absent, stale, garbage, a throw)
//     reads as THEME_DEFAULT. EVERY storage access is wrapped: storage can throw outright (private
//     mode, a blocked-cookies origin, quota), and the only safe answer to "can't tell" is the default.
//   • index.html carries an inline copy of `resolve` + `apply` that runs before first paint, so the
//     page never flashes the wrong theme. It must use the same key and default as this module; a unit
//     test (test/theme-pref.mjs) reads index.html and checks both.
//   • The resolved theme lands on <html> as `data-theme` (the CSS tokens hang off it) and as
//     `color-scheme` (native scrollbars, form controls and <select> popups follow it).
export const THEME_STORAGE_KEY = "loom.theme";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

// Follow the OS (card 3b5b3106, the last Graphite card, flipped this from the interim "dark"). Keep the
// index.html script's default in step (the unit test checks it). Where the OS setting can't be read,
// "system" resolves to dark (see `systemTheme`).
export const THEME_DEFAULT: ThemePref = "system";

export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

export function parseThemePref(raw: unknown): ThemePref {
  return raw === "system" || raw === "light" || raw === "dark" ? raw : THEME_DEFAULT;
}

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return THEME_DEFAULT;
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
    }
  } catch {
    /* fall through */
  }
  return "dark";
}

export function resolveTheme(pref: ThemePref, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  return pref === "system" ? system : pref;
}

function apply(t: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.theme = t;
  el.style.colorScheme = t;
}

let pref = readPref();
let resolved = resolveTheme(pref);

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function update(next: ThemePref): void {
  const nextResolved = resolveTheme(next);
  if (next === pref && nextResolved === resolved) return;
  pref = next;
  resolved = nextResolved;
  apply(resolved);
  emit();
}

// ✅ A cross-tab change IS applied immediately here, and that is
// deliberate: switching the theme flips one attribute on <html> and unmounts nothing, so no
// half-typed input can be lost. Don't turn it into an offer-and-reload notice.
// `localStorage.clear()` fires with `key === null`, so re-read rather than trust the event payload.
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
  update(readPref());
}

// While on "system", follow the OS setting live.
function onSystemChange(): void {
  if (pref === "system") update(pref);
}

let wired = false;
function wireGlobalListeners(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("storage", onStorage);
  try {
    window.matchMedia?.(DARK_QUERY).addEventListener?.("change", onSystemChange);
  } catch {
    /* no matchMedia: "system" stays on whatever it resolved to at load */
  }
}

// Call once at app start. It re-applies the resolved theme (the inline script normally already has)
// and starts following other tabs and the OS. Listeners live for the page's lifetime, not a component's,
// so the theme keeps following even while nothing that reads it is mounted.
export function initThemePref(): void {
  apply(resolved);
  wireGlobalListeners();
}

export function setThemePref(next: ThemePref): void {
  const value = parseThemePref(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* storage unavailable: the choice still holds for this page's lifetime, it just won't persist */
  }
  update(value);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getPref = () => pref;
const getResolved = () => resolved;

/** The stored preference and its setter, for the Settings control. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  return [useSyncExternalStore(subscribe, getPref, getPref), setThemePref];
}

/** The theme actually in force ("light" | "dark"), for code that needs real colour values. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolved, getResolved);
}

/** Non-hook read of the stored preference. */
export function getThemePref(): ThemePref {
  return pref;
}

/** Non-hook read of the theme in force. Subscribe with `subscribeResolvedTheme` to follow changes. */
export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function subscribeResolvedTheme(cb: (t: ResolvedTheme) => void): () => void {
  return subscribe(() => cb(resolved));
}
