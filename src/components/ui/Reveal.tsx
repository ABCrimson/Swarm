import { Suspense, ViewTransition } from "react";

interface RevealProps {
  /** Shown while `children` suspend (a `use()` read in flight). */
  readonly fallback: React.ReactNode;
  readonly children: React.ReactNode;
}

/**
 * A Suspense boundary whose reveal cross-fades: wrapped in
 * `<ViewTransition update="auto" default="none">`, the swap from `fallback`
 * to the content that `use()` was waiting on animates as a view-transition
 * update, while `default="none"` keeps every other change inside it (mount,
 * unmount, an ordinary re-render) from animating. Where the engine has no
 * View Transitions API the swap is instant, as a bare `<Suspense>` would be,
 * and the reduced-motion override in animations.css stills the cross-fade.
 */
export function Reveal({ fallback, children }: RevealProps): React.ReactElement {
  return (
    <ViewTransition update="auto" default="none">
      <Suspense fallback={fallback}>{children}</Suspense>
    </ViewTransition>
  );
}
