import { useEffect, useState, useSyncExternalStore } from "react";
import { color, font, radius, wash, fs } from "../theme";
import { rateLimitSnapshot, subscribeRateLimit } from "../lib/rateLimitBackoff";

/**
 * "Rate limited, retrying" — shown while at least one read is sleeping between a 429 and its retry
 * (lib/rateLimitBackoff.ts, card 4729d007). It is the visible half of the backoff: without it a refused pane
 * just stays blank. Renders nothing otherwise, so a loopback page (never rate limited) never sees it.
 */
export function RateLimitBanner() {
  const snap = useSyncExternalStore(subscribeRateLimit, rateLimitSnapshot, rateLimitSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.waiting === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [snap.waiting]);
  if (snap.waiting === 0) return null;
  const secs = Math.max(0, Math.ceil((snap.nextRetryAt - now) / 1000));
  return (
    <div
      role="status"
      data-testid="rate-limit-banner"
      style={{
        background: wash(color.amber, 10), border: `1px solid ${color.amber}`, borderRadius: radius.base,
        padding: "8px 12px", margin: "8px 0", fontFamily: font.ui, fontSize: fs.sm, color: color.text,
      }}
    >
      Rate limited by the daemon — retrying in {secs}s. Data on this page may be missing until it succeeds.
    </div>
  );
}
