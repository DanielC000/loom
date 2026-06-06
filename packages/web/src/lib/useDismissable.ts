import { useEffect, useRef } from "react";

// Robust click-to-open / dismiss-to-close for popovers (dropdown menus, split-button menus).
// While `open`, a document `mousedown` outside the returned ref closes it, as does `Escape`.
// Replaces the fragile hover-close idiom (onMouseLeave) that vanished the panel when the cursor
// crossed the gap between the trigger button and the panel. Returns a ref to put on the wrapper
// element that contains BOTH the trigger and the panel.
export function useDismissable<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  // Keep the latest onClose in a ref so the listeners' effect depends only on `open` (no
  // re-subscribe churn when callers pass an inline arrow each render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return ref;
}
