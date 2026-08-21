import { useAtom } from "jotai";
import { useEffect } from "react";
import { reducedMotionAtom } from "#store/ui";

const MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Detects the user's `prefers-reduced-motion` preference and keeps
 * the `reducedMotionAtom` in sync. Cleans up the media query listener
 * on unmount.
 */
export function useTheme(): { reducedMotion: boolean } {
  const [reducedMotion, setReducedMotion] = useAtom(reducedMotionAtom);

  useEffect(() => {
    const mql = globalThis.matchMedia(MEDIA_QUERY);

    // Set initial value
    setReducedMotion(mql.matches);

    const onChange = (e: MediaQueryListEvent): void => {
      setReducedMotion(e.matches);
    };

    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, [setReducedMotion]);

  return { reducedMotion };
}
