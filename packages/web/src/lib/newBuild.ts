// Card e98bf784 — "this tab is running a superseded bundle" detection.
//
// Incident + rationale: docs/decisions/e98bf784-prompt-an-open-tab-to-reload-after-a-new-web-build.md.
//
// @decision e98bf784 — this compares WEB BUNDLES only, so it is deliberately silent after a
// daemon-`src`-only deploy (the tab's JS really is current then). Never widen it into a daemon-staleness
// proxy: `webBundle` is provably blind to that case — see the record for card 5e30c4bd.

/** The query key the notice reads and `FleetSocketProvider` invalidates on a reconnect. */
export const WEB_BUNDLE_QUERY_KEY = ["webBundle"] as const;

/** A production bundle filename as vite emits it, and as the daemon's `currentWebBundle()` reports it. */
const BUNDLE_RE = /^index-.*\.js$/;

/**
 * This tab's OWN bundle filename, read from the module script the document actually loaded, or null when
 * it isn't a production bundle.
 *
 * The production `index.html` carries exactly one `<script type="module" src>`, pointing at
 * `/assets/index-<hash>.js` — the same filename the daemon reports. Under `pnpm web` it instead points at
 * `/src/main.tsx`, which is why the shape check below is load-bearing and not belt-and-braces: without it
 * every dev tab compares `main.tsx` against the daemon's own unrelated dist build and false-alarms forever.
 */
export function ownBundle(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!el) return null;
  let name: string;
  try {
    name = new URL(el.src, document.baseURI).pathname.split("/").pop() ?? "";
  } catch {
    return null;
  }
  return BUNDLE_RE.test(name) ? name : null;
}

/**
 * Whether to offer a reload: both sides must be real, comparable production bundles, and they must differ.
 *
 * Every "unknown" case resolves to NO notice — an unbuilt dist (`served` null, per the daemon's own
 * degrade), a dev tab, a document we couldn't read a script from. A false "you are stale" is worse than a
 * missed one: it would train the owner to ignore the very banner this exists to make them trust.
 */
export function isSuperseded(own: string | null, served: string | null | undefined): boolean {
  if (!own || !served) return false;
  if (!BUNDLE_RE.test(served)) return false;
  return own !== served;
}

/** localStorage key for a dismissal, scoped to the SERVED hash so a LATER build re-offers the reload. */
export function dismissKeyFor(served: string): string {
  return `loom.newBuildDismissed.${served}`;
}

export function isDismissed(served: string): boolean {
  try {
    return localStorage.getItem(dismissKeyFor(served)) === "1";
  } catch {
    return false; // private mode / blocked storage — show the notice rather than suppress it
  }
}

export function markDismissed(served: string): void {
  try {
    localStorage.setItem(dismissKeyFor(served), "1");
  } catch {
    /* storage unavailable — the notice stays up for this tab; nothing durable to record */
  }
}
