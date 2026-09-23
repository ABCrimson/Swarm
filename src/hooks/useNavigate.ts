import { type ExtractAtomValue, useSetAtom } from "jotai";
import { addTransitionType, startTransition } from "react";
import { currentPageAtom } from "#store/ui";

/** Every routable page, derived from `currentPageAtom` so the two cannot drift. */
export type PageId = ExtractAtomValue<typeof currentPageAtom>;

/**
 * Transition type tagged on page navigations. The page host's
 * `<ViewTransition>` animates only transitions carrying it, so other
 * updates (a sync `setPage`, a Suspense reveal) swap pages instantly.
 */
export const NAVIGATE_TRANSITION = "navigate";

/**
 * Returns a function that switches the current page inside a transition.
 *
 * The page on screen stays visible and interactive while a page chunk
 * that has not loaded yet streams in (no flash of the loading fallback),
 * and the swap plays the page view transition (see `PageHost` in
 * `#components/layout/AppShell`).
 */
export function useNavigate(): (page: PageId) => void {
  const setPage = useSetAtom(currentPageAtom);
  return (page) =>
    startTransition(() => {
      addTransitionType(NAVIGATE_TRANSITION);
      setPage(page);
    });
}
