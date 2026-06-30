import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { color, font, radius } from "../theme";

// Scoped in-document find for the Vault markdown viewer. Ctrl/Cmd+F opens this bar ONLY when the doc
// view is the active region (focus or last pointer inside the scroll container) — otherwise the
// browser's native find is left untouched. Matches are painted with the CSS Custom Highlight API
// (Range objects, no DOM mutation — so react-markdown's React-owned tree is never touched), with a
// distinct color for the active match. Navigating to a match inside a collapsed header section
// (child 1) expands every collapsed ancestor first via the shared CollapseContext registry.

const HL_ALL = "loom-find";
const HL_ACTIVE = "loom-find-active";

/** The CSS Custom Highlight registry, or null where the API is unavailable (older engines). */
function highlightRegistry(): { set: (k: string, v: unknown) => void; delete: (k: string) => void } | null {
  const css = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: unknown }) : null;
  if (css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === "function") {
    return css.highlights as { set: (k: string, v: unknown) => void; delete: (k: string) => void };
  }
  return null;
}

/** Build a Range per case-insensitive occurrence of `query` in the rendered text under `root`. */
function computeMatches(root: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  const needle = query.toLowerCase();
  if (!needle) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = (n as Text).parentElement;
      if (!parent || parent.closest("style,script")) return NodeFilter.FILTER_REJECT;
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = (node.nodeValue ?? "").toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      out.push(r);
      i = hay.indexOf(needle, i + needle.length);
    }
  }
  return out;
}

/** Repaint the "all matches" + "active match" highlights (the active one wins via higher priority). */
function paint(matches: Range[], active: number): void {
  const reg = highlightRegistry();
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_ACTIVE);
  if (matches.length === 0) return;
  const Hl = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  reg.set(HL_ALL, new Hl(...matches));
  const current = matches[active];
  if (current) {
    const h = new Hl(current) as { priority?: number };
    h.priority = 1;
    reg.set(HL_ACTIVE, h);
  }
}

function clearPaint(): void {
  const reg = highlightRegistry();
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_ACTIVE);
}

/** Open every collapsed header section that contains `node` (walks up the DOM, expanding via the registry). */
function expandAncestors(node: Node, registry: Map<HTMLElement, () => void>): void {
  let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  while (el) {
    registry.get(el)?.();
    el = el.parentElement;
  }
}

/** Center the active match within the scroll container (only the active one moves into view). */
function scrollToRange(range: Range, container: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // not laid out (e.g. still hidden) — skip
  const cRect = container.getBoundingClientRect();
  const target = container.scrollTop + (rect.top - cRect.top) - container.clientHeight / 2 + rect.height / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

export default function DocFind({ containerRef, registry, docKey }: {
  containerRef: RefObject<HTMLDivElement | null>;
  registry: Map<HTMLElement, () => void>;
  docKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPointerInside = useRef(false);

  // The doc view is "active" if focus is within it, or the last pointer interaction landed inside it.
  const isDocActive = useCallback(() => {
    const c = containerRef.current;
    if (!c) return false;
    const ae = document.activeElement;
    if (ae && c.contains(ae)) return true;
    return lastPointerInside.current;
  }, [containerRef]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const c = containerRef.current;
      lastPointerInside.current = !!(c && e.target instanceof Node && c.contains(e.target));
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [containerRef]);

  // Move the active match into view: expand any collapsed ancestor sections, repaint, then scroll
  // (after the expand has rendered + laid out, so the range has geometry — hence the double rAF).
  const focusMatch = useCallback((list: Range[], idx: number) => {
    const c = containerRef.current;
    const r = list[idx];
    if (!c || !r) return;
    expandAncestors(r.startContainer, registry);
    paint(list, idx);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToRange(r, c)));
  }, [containerRef, registry]);

  // Recompute on query/open/doc change. Collapsed sections stay mounted (CSS-hidden), so matches
  // inside them are found here and revealed on navigate.
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current?.querySelector(".loom-md") as HTMLElement | null;
    const list = root ? computeMatches(root, query) : [];
    setMatches(list);
    setActive(0);
    if (list.length) focusMatch(list, 0);
    else clearPaint();
  }, [query, open, docKey, containerRef, focusMatch]);

  // Closing the bar clears the paint and resets the query.
  useEffect(() => {
    if (open) return;
    clearPaint();
    setMatches([]);
    setQuery("");
    setActive(0);
  }, [open]);

  // A new doc closes the bar (its matches are stale); also clear paint when this unmounts.
  useEffect(() => { setOpen(false); }, [docKey]);
  useEffect(() => () => clearPaint(), []);

  // Scoped Ctrl/Cmd+F. Outside the doc view we do NOT preventDefault, so native find still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        if (!isDocActive()) return;
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDocActive]);

  const navigate = (delta: number) => {
    if (matches.length === 0) return;
    const next = (active + delta + matches.length) % matches.length;
    setActive(next);
    focusMatch(matches, next);
  };
  const close = () => setOpen(false);

  if (!open) return null;

  const count = query ? `${matches.length ? active + 1 : 0}/${matches.length}` : "0/0";

  return (
    <div style={{ position: "sticky", top: 0, height: 0, zIndex: 20 }}>
      <div
        className="loom-overlay-in loom-docfind"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); close(); }
          else if (e.key === "Enter") { e.preventDefault(); navigate(e.shiftKey ? -1 : 1); }
        }}
        style={{
          position: "absolute", top: 8, right: 8, display: "flex", alignItems: "center", gap: 6,
          background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base,
          padding: "4px 6px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        }}
      >
        <input
          ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in document…" aria-label="Find in document"
          style={{
            background: color.panel2, color: color.text, border: `1px solid ${color.border}`,
            borderRadius: radius.sm, padding: "3px 8px", width: 200, fontFamily: font.mono, fontSize: 12, outline: "none",
          }}
        />
        <span
          aria-live="polite"
          style={{ fontFamily: font.mono, fontSize: 11, color: matches.length ? color.textDim : color.textMuted, minWidth: 44, textAlign: "center", whiteSpace: "nowrap" }}
        >
          {count}
        </span>
        <IconButton label="Previous match" disabled={matches.length === 0} onClick={() => navigate(-1)} icon="up" />
        <IconButton label="Next match" disabled={matches.length === 0} onClick={() => navigate(1)} icon="down" />
        <IconButton label="Close find" onClick={close} icon="close" />
      </div>
    </div>
  );
}

function IconButton({ label, icon, disabled, onClick }: { label: string; icon: "up" | "down" | "close"; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="loom-btn"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22,
        padding: 0, border: `1px solid ${color.border}`, borderRadius: radius.sm,
        background: "transparent", color: color.textDim, cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
        {icon === "up" && <path d="M2.5 7.5 L6 4 L9.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        {icon === "down" && <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
        {icon === "close" && <path d="M3 3 L9 9 M9 3 L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      </svg>
    </button>
  );
}
