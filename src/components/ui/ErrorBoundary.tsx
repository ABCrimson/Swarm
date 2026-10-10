import type { ReactNode } from "react";
import { Component } from "react";
import { Button } from "#components/ui/Button";
import { toast } from "#components/ui/Toast";
import { isError } from "#lib/is-error";

/** Retries allowed before the fallback offers only a full reload. */
export const MAX_RETRIES = 3;
/** First retry delay; each further retry doubles it (1s, 2s, 4s). */
const BASE_DELAY_MS = 1000;
/**
 * How long the children must render without throwing again before the
 * retry budget refills. A retry that fails straight away keeps using up
 * the budget; a real recovery gives the next failure a fresh one.
 */
export const STABLE_RESET_MS = 10_000;

/**
 * An error rejected by a Tauri command: the IPC layer delivers the
 * serialized Rust error as a plain object, never as an `Error` instance.
 */
interface TauriError {
  readonly message: string;
  readonly kind?: string;
}

function isTauriError(error: unknown): error is TauriError {
  return (
    typeof error === "object" &&
    error !== null &&
    !isError(error) &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** Shows a toast describing a caught error. */
function toastError(error: unknown): void {
  if (isError(error)) {
    toast.error(error.message || "An Unexpected Error Occurred.");
  } else if (isTauriError(error)) {
    toast.error(`IPC Error: ${error.message}`, {
      description: error.kind ?? "An Error Occurred Communicating With The Backend.",
    });
  } else {
    toast.error("An Unexpected Error Occurred.");
  }
}

/**
 * React passes along whatever was thrown, and a non-`Error` throw
 * (a string, a Tauri error object) has no `.message` to show; wrap it.
 */
function toError(thrown: unknown): Error {
  if (isError(thrown)) return thrown;
  if (isTauriError(thrown)) return new Error(thrown.message, { cause: thrown });
  return new Error(String(thrown), { cause: thrown });
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  /** Retries used since the children last rendered stably. */
  readonly retryCount: number;
  /** A retry is scheduled; further Retry clicks are ignored until it runs. */
  readonly retrying: boolean;
}

/**
 * Error boundary with a retry-with-backoff fallback. React 19 still has
 * no hook for catching render errors, so this is a class component.
 *
 * - Every caught error raises a toast (a typed Tauri IPC error gets its
 *   own title). The root's `onCaughtError` (`reportRenderError` in
 *   main.tsx) already logs the error to the console and records it, with
 *   the component stack, on the Logs page, so this boundary does not log
 *   it a second time.
 * - "Retry" re-renders the children after 1s, 2s, then 4s. Clicks while
 *   a retry is pending are ignored. Once the children have rendered for
 *   {@link STABLE_RESET_MS} without throwing, the budget refills.
 * - When all {@link MAX_RETRIES} retries are spent, the fallback offers
 *   "Reload Application" instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, retryCount: 0, retrying: false };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(thrown: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(thrown) };
  }

  override componentDidCatch(thrown: unknown): void {
    clearTimeout(this.stableTimer);
    toastError(thrown);
  }

  override componentDidUpdate(_: ErrorBoundaryProps, prev: ErrorBoundaryState): void {
    // The children just rendered again after a retry: refill the budget
    // once they have stayed up for the stability window.
    if (prev.error !== null && this.state.error === null && this.state.retryCount > 0) {
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => this.setState({ retryCount: 0 }), STABLE_RESET_MS);
    }
  }

  override componentWillUnmount(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
  }

  private readonly handleRetry = (): void => {
    const { retryCount, retrying } = this.state;
    if (retrying) return;
    if (retryCount >= MAX_RETRIES) {
      toast.error("Maximum Retries Exceeded. Please Reload The Application.");
      return;
    }

    const delay = BASE_DELAY_MS * 2 ** retryCount;
    this.setState({ retrying: true });
    this.retryTimer = setTimeout(() => {
      this.setState((prev) => ({ error: null, retryCount: prev.retryCount + 1, retrying: false }));
    }, delay);
    toast.info(`Retrying In ${delay / 1000}s…`);
  };

  override render(): ReactNode {
    const { error, retryCount, retrying } = this.state;
    const { children } = this.props;

    if (!error) return children;

    const remaining = MAX_RETRIES - retryCount;
    return (
      <div
        role="alert"
        className="flex min-h-50 flex-col items-center justify-center gap-4 rounded-xl border border-rose/50 bg-surface-0 p-8"
      >
        <p className="font-semibold text-base text-rose">Something Went Wrong</p>
        <p className="max-w-100 text-center text-fg-muted text-md">{error.message}</p>
        {remaining > 0 ? (
          <Button variant="secondary" size="sm" onClick={this.handleRetry} loading={retrying}>
            Retry ({remaining} Remaining)
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => location.reload()}>
            Reload Application
          </Button>
        )}
      </div>
    );
  }
}
