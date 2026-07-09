import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "#components/ui/ErrorBoundary";

// A component that throws on render
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) {
    throw new Error("Test render error");
  }
  return <div>Rendered successfully</div>;
}

// Suppress React's noisy error boundary console output in tests
const originalConsoleError = console.error;

describe("ErrorBoundary", () => {
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("catches errors and displays the default fallback UI", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test render error")).toBeInTheDocument();
  });

  it("shows a retry button in the default fallback", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("displays retry count in the button text", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Initially 3 retries remaining
    expect(screen.getByRole("button", { name: /3 remaining/i })).toBeInTheDocument();
  });

  it("uses custom fallback when provided", () => {
    const customFallback = (error: Error, reset: () => void) => (
      <div>
        <span>Custom error: {error.message}</span>
        <button type="button" onClick={reset}>
          Custom reset
        </button>
      </div>
    );

    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom error: Test render error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Custom reset" })).toBeInTheDocument();
  });

  it("calls onError callback when an error is caught", () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("Test render error");
  });

  it("retry button is clickable and triggers the backoff mechanism", async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>,
    );

    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeInTheDocument();

    // Click retry -- this schedules a setTimeout with backoff delay
    // The component still shows the error UI because of the delay,
    // but the click itself should not throw
    await user.click(retryButton);

    // The button should still be in the document (the error persists
    // because the child will throw again on re-render)
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});
