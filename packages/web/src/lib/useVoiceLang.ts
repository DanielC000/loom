import { useSyncExternalStore } from "react";

// One persisted, GLOBAL voice-input language preference. Voice dictation is now on every terminal's
// composer, so the recognizer language is a single app-wide choice — not per-tile. Backed by
// localStorage under `loom.voiceLang`; default = navigator.language (preserves the prior behavior,
// where the hook fell back to the browser locale). Shared across every mounted composer via a tiny
// module-level store + useSyncExternalStore, so changing it in one composer updates them all (and a
// later mount reads the persisted value) WITHOUT needing a Context provider in the tree.
const STORAGE_KEY = "loom.voiceLang";

// Curated BCP-47 tags with readable, compact labels. The browser-default tag is injected on top of
// this list if it isn't already present (see voiceLangOptions) so the current locale is always
// selectable.
export const VOICE_LANGS: ReadonlyArray<{ tag: string; label: string }> = [
  { tag: "en-US", label: "English (US)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "de-DE", label: "Deutsch" },
  { tag: "es-ES", label: "Español" },
  { tag: "fr-FR", label: "Français" },
  { tag: "it-IT", label: "Italiano" },
  { tag: "pt-BR", label: "Português (BR)" },
  { tag: "nl-NL", label: "Nederlands" },
];

export function browserDefaultLang(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
}

// The options to render: the curated list, with the browser-default tag prepended iff it's not
// already one of the curated tags — so the recognizer's default locale is always pickable.
export function voiceLangOptions(): ReadonlyArray<{ tag: string; label: string }> {
  const def = browserDefaultLang();
  if (VOICE_LANGS.some((l) => l.tag === def)) return VOICE_LANGS;
  return [{ tag: def, label: `${def} (browser default)` }, ...VOICE_LANGS];
}

function read(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? browserDefaultLang();
  } catch {
    return browserDefaultLang();
  }
}

let current = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // Keep cross-tab writes in sync too (cheap, best-effort).
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(e: StorageEvent) {
  if (e.key !== STORAGE_KEY) return;
  current = e.newValue ?? browserDefaultLang();
  emit();
}

function setVoiceLang(lang: string): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore — preference is best-effort */
  }
  emit();
}

const getSnapshot = () => current;

// The shared preference hook. Returns the active BCP-47 tag and a setter, both stable across mounts.
export function useVoiceLang(): [string, (lang: string) => void] {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return [lang, setVoiceLang];
}
