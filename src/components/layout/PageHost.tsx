import { useAtomValue } from "jotai";
import { Activity, lazy, Suspense, useState, ViewTransition } from "react";
import { ErrorBoundary } from "#components/ui/ErrorBoundary";
import { Spinner } from "#components/ui/Spinner";
import { NAVIGATE_TRANSITION, type PageId } from "#hooks/useNavigate";
import { currentPageAtom } from "#store/ui";

// ── Lazy-loaded pages (one chunk each) ───────────────
const PAGES = {
  dashboard: lazy(() => import("#pages/Dashboard").then((m) => ({ default: m.Dashboard }))),
  workers: lazy(() => import("#pages/Workers").then((m) => ({ default: m.Workers }))),
  sessions: lazy(() => import("#pages/Sessions").then((m) => ({ default: m.Sessions }))),
  metrics: lazy(() => import("#pages/Metrics").then((m) => ({ default: m.Metrics }))),
  logs: lazy(() => import("#pages/Logs").then((m) => ({ default: m.Logs }))),
  tools: lazy(() => import("#pages/Tools").then((m) => ({ default: m.Tools }))),
  workspace: lazy(() => import("#pages/Workspace").then((m) => ({ default: m.Workspace }))),
  settings: lazy(() => import("#pages/Settings").then((m) => ({ default: m.Settings }))),
} as const satisfies Record<PageId, React.ComponentType>;

/** Every page id, in sidebar order. */
const PAGE_IDS = Object.keys(PAGES) as PageId[];

/**
 * Only navigations tagged with {@link NAVIGATE_TRANSITION} (see
 * `useNavigate`) animate; every other update swaps pages instantly.
 * The `swarm-page` view-transition class is styled in animations.css.
 */
const PAGE_TRANSITION = { [NAVIGATE_TRANSITION]: "swarm-page", default: "none" };

/** Centered spinner shown while a page chunk loads. */
function PageFallback(): React.ReactElement {
  return (
    <div className="flex size-full items-center justify-center">
      <Spinner size="md" />
    </div>
  );
}

/**
 * Renders the current page and keeps every page visited so far mounted.
 *
 * Each visited page lives in an `<Activity>`: the current one is
 * `visible`, the rest are `hidden` (display: none, effects unmounted,
 * state kept), so leaving a page and coming back restores its scroll
 * position, open panels, terminal and inputs. Pages mount on first
 * visit, so their chunks still load lazily.
 *
 * The swap animates with a `<ViewTransition>` when navigation went
 * through `useNavigate` (a transition). Because a transition keeps the
 * current page on screen until the next page's chunk has loaded, the
 * shared Suspense fallback only shows for untransitioned updates.
 * Every page has its own error boundary, so one crashed page never
 * takes the others down.
 */
export function PageHost(): React.ReactElement {
  const currentPage = useAtomValue(currentPageAtom);
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(() => new Set([currentPage]));

  // Adjusting state while rendering (React's documented pattern for
  // state derived from a changed input): record the page before the
  // first render that shows it, so it never flashes as unvisited.
  if (!visited.has(currentPage)) {
    setVisited(visited.union(new Set([currentPage])));
  }

  return (
    <Suspense fallback={<PageFallback />}>
      {PAGE_IDS.filter((id) => visited.has(id)).map((id) => {
        const Page = PAGES[id];
        return (
          <Activity key={id} name={id} mode={id === currentPage ? "visible" : "hidden"}>
            <ViewTransition enter={PAGE_TRANSITION} exit={PAGE_TRANSITION} default="none">
              <div className="absolute inset-0 overflow-auto" data-page={id}>
                <ErrorBoundary>
                  <Page />
                </ErrorBoundary>
              </div>
            </ViewTransition>
          </Activity>
        );
      })}
    </Suspense>
  );
}
