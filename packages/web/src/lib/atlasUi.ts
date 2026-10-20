import { useSyncExternalStore } from "react";

// The Atlas-UI opt-in switch (card 757c80dd). Why Atlas is built behind a switch at all, and what the
// phases are: docs/plans/atlas-ui/02-architecture.md.
//
// Contract, and the parts that are load-bearing:
//   • OFF unless the stored value is exactly "1" — absent, cleared, stale, garbage and a throw all read
//     as OFF, so no input can switch a user into Atlas by accident.
//   • HUMAN-only: a per-browser display preference, never project or daemon config, so it goes nowhere
//     near `resolveConfig`, the platform-config store or any `api.ts` member, and no agent can flip it.
//   • EVERY read and write is wrapped. Storage can throw outright (private mode, a blocked-cookies
//     origin, quota) and the only safe answer to "can't tell" is the default.
//   • Shared across consumers through a module-level store + useSyncExternalStore, the same shape as
//     lib/useVoiceLang.ts, so the Settings toggle and the shell re-render together with no Context.
export const ATLAS_UI_STORAGE_KEY = "loom.atlasUi";

function read(): boolean {
  try {
    return localStorage.getItem(ATLAS_UI_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let current = read();

// A write by ANOTHER TAB that disagrees with this tab's live shell. Held as a flag instead of being
// applied, deliberately — see onStorage.
let externalPending = false;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// ⛔ A cross-tab change is NEVER hot-applied. Swapping the shell unmounts every page in the receiving
// tab, which would silently destroy whatever the user was part-way through typing there — a half-written
// agent prompt, an unsaved Settings form. The owner's standing rule is that unfinished input is never
// destroyed, so the other tab's choice is recorded and OFFERED (components/AtlasSwitchNotice.tsx), and
// only a real reload applies it: `read()` runs fresh at module load, so the next load is already correct
// with nothing extra to do. The SAME-tab path (the Settings toggle, the shell's escape hatch) stays
// immediate — there the swap IS the deliberate action the user just took.
//
// A `localStorage.clear()` fires with `key === null` and no newValue, so re-READ rather than trusting
// the event payload.
function onStorage(e: StorageEvent) {
  if (e.key !== null && e.key !== ATLAS_UI_STORAGE_KEY) return;
  // Back in agreement (the other tab undid it, or cleared storage while we were already OFF) ⇒ there is
  // nothing left to offer, so the notice retracts itself rather than lingering as a stale prompt.
  externalPending = read() !== current;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
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

// Stored as "1" / absent rather than "1" / "0": an absent key is the same state as a never-visited
// browser, so turning Atlas off leaves no residue to reason about later.
export function setAtlasUi(on: boolean): void {
  if (on === current) return;
  current = on;
  // This tab's own deliberate choice supersedes whatever another tab was offering.
  externalPending = false;
  try {
    if (on) localStorage.setItem(ATLAS_UI_STORAGE_KEY, "1");
    else localStorage.removeItem(ATLAS_UI_STORAGE_KEY);
  } catch {
    /* storage unavailable — the switch still holds for this page's lifetime, it just won't persist */
  }
  emit();
}

export function dismissAtlasUiExternalChange(): void {
  if (!externalPending) return;
  externalPending = false;
  emit();
}

const getSnapshot = () => current;
const getExternalSnapshot = () => externalPending;

// The shared switch hook: `[on, set]`, both stable across mounts.
export function useAtlasUi(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return [on, setAtlasUi];
}

// True while another tab's stored preference disagrees with this tab's live shell.
export function useAtlasUiExternalChange(): boolean {
  return useSyncExternalStore(subscribe, getExternalSnapshot, getExternalSnapshot);
}
