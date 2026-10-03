import { useLayoutEffect, useRef } from "react";

/** The modal primitive has no trigger element, so hand focus back to whatever opened it. */
export function useRestoreFocus(open: boolean): void {
  const origin = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (!open && wasOpen.current) {
      const target = origin.current;
      origin.current = null;
      if (target) {
        window.setTimeout(() => {
          if (target.isConnected) target.focus();
        }, 0);
      }
    }
    wasOpen.current = open;
  }, [open]);
}
