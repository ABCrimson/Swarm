import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { toast } from "#components/ui/Toast";

// ── Exponential backoff helper ───────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function getBackoffDelay(attempt: number): number {
  return BASE_DELAY_MS * 2 ** attempt; // 1s, 2s, 4s
}

// ── Typed Tauri error detection ──────────────────────

interface TauriError {
  readonly message: string;
  readonly kind?: string;
}

function isTauriError(error: unknown): error is TauriError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as TauriError).message === "string"
  );
}

function toastError(error: unknown): void {
  if (isTauriError(error)) {
    toast.error(`IPC Error: ${error.message}`, {
      description: error.kind ?? "An Error Occurred Communicating With The Backend.",
    });
  } else if (error instanceof Error) {
    toast.error(error.message);
  } else {
    toast.error("An Unexpected Error Occurred.");
  }
}

// ── Error Boundary component ─────────────────────────

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Optional fallback UI factory. Receives error and reset callback. */
  readonly fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called when the boundary catches an error. */
  readonly onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly retryCount: number;
}

/**
 * React 19 error boundary using class component (required by React).
 *
 * Features:
 * - OKLCH-styled fallback UI
 * - "Retry" button with exponential backoff (1s / 2s / 4s, max 3 retries)
 * - Typed Tauri errors are surfaced via Sonner toast notifications
 * - Reset capability to recover from transient errors
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log full error with stack trace for debugging
    console.error(
      "[ErrorBoundary] Caught error:",
      error.message,
      "\n\nStack trace:",
      error.stack ?? "(no stack)",
      "\n\nComponent stack:",
      errorInfo.componentStack ?? "(no component stack)",
    );

    this.props.onError?.(error, errorInfo);
    toastError(error);
  }

  componentWillUnmount(): void {
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId);
    }
  }

  private handleReset = (): void => {
    const { retryCount } = this.state;

    if (retryCount >= MAX_RETRIES) {
      toast.error("Maximum Retries Exceeded. Please Reload The Application.");
      return;
    }

    const delay = getBackoffDelay(retryCount);

    this.retryTimeoutId = setTimeout(() => {
      this.setState((prev) => ({
        error: null,
        retryCount: prev.retryCount + 1,
      }));
      this.retryTimeoutId = null;
    }, delay);

    toast.info(`Retrying In ${delay / 1000}s...`);
  };

  render(): ReactNode {
    const { error, retryCount } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (fallback) {
        return fallback(error, this.handleReset);
      }

      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 32,
            minHeight: 200,
            background: "oklch(0.08 0.02 220)",
            border: "1px solid oklch(0.50 0.14 10 / 0.5)",
            borderRadius: 12,
            color: "oklch(0.72 0.20 10)",
            fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "oklch(0.72 0.20 10)",
            }}
          >
            Something Went Wrong
          </div>
          <div
            style={{
              fontSize: 13,
              color: "oklch(0.55 0.05 220)",
              maxWidth: 400,
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            {error.message}
          </div>
          {retryCount < MAX_RETRIES && (
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                padding: "8px 20px",
                fontSize: 13,
                fontWeight: 500,
                background: "oklch(0.78 0.18 205 / 0.15)",
                border: "1px solid oklch(0.78 0.18 205 / 0.3)",
                borderRadius: 8,
                color: "oklch(0.78 0.18 205)",
                cursor: "pointer",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.25)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.15)";
              }}
            >
              Retry ({MAX_RETRIES - retryCount} Remaining)
            </button>
          )}
        </div>
      );
    }

    return children;
  }
}
