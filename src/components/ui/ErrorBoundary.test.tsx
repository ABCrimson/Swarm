import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, MAX_RETRIES, STABLE_RESET_MS } from "#components/ui/ErrorBoundary";

/** What the child throws on render; `null` renders normally. */
const failure: { thrown: unknown } = { thrown: null };

function Child(): React.ReactElement {
  if (failure.thrown !== null) throw failure.thrown;
  return <p>Rendered Successfully</p>;
}

function renderBoundary(props: Partial<React.ComponentProps<typeof ErrorBoundary>> = {}) {
  return render(
    <ErrorBoundary {...props}>
      <Child />
    </ErrorBoundary>,
  );
}

const retryButton = () => screen.getByRole("button", { name: /Retry/ });

describe("ErrorBoundary", () => {
  beforeEach(() => {
    failure.thrown = new Error("Test Render Error");
    // React reports caught render errors through console.error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders children when nothing throws", () => {
    failure.thrown = null;
    renderBoundary();

    expect(screen.getByText("Rendered Successfully")).toBeInTheDocument();
  });

  it("shows the default fallback as an alert with the error message", () => {
    renderBoundary();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something Went Wrong");
    expect(alert).toHaveTextContent("Test Render Error");
    expect(retryButton()).toHaveTextContent(`Retry (${MAX_RETRIES} Remaining)`);
  });

  // Every Error has a string `message`, so the Tauri-error check must
  // exclude Error instances.
  it("toasts a plain Error with its own message, not as an IPC error", () => {
    renderBoundary();

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Test Render Error");
  });

  it("toasts a serialized Tauri error object as an IPC error", () => {
    failure.thrown = { message: "Worker Not Found", kind: "NotFound" };
    renderBoundary();

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("IPC Error: Worker Not Found", {
      description: "NotFound",
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Worker Not Found");
  });

  it("normalizes a thrown non-Error value into a readable message", () => {
    failure.thrown = "Plain String Failure";
    const onError = vi.fn();
    renderBoundary({ onError });

    expect(screen.getByRole("alert")).toHaveTextContent("Plain String Failure");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0].message).toBe("Plain String Failure");
  });

  it("uses a custom fallback when provided", () => {
    render(
      <ErrorBoundary
        fallback={(error, reset) => (
          <button type="button" onClick={reset}>
            Custom: {error.message}
          </button>
        )}
      >
        <Child />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: "Custom: Test Render Error" })).toBeInTheDocument();
  });

  it("retries after a 1s backoff and renders the recovered children", () => {
    vi.useFakeTimers();
    renderBoundary();

    fireEvent.click(retryButton());
    expect(toast.info).toHaveBeenCalledExactlyOnceWith("Retrying In 1s…");
    expect(retryButton()).toHaveAttribute("aria-busy", "true");

    failure.thrown = null;
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Rendered Successfully")).toBeInTheDocument();
  });

  // Extra Retry clicks while a retry is pending schedule no timer and spend no retry.
  it("ignores extra Retry clicks while a retry is pending", () => {
    vi.useFakeTimers();
    renderBoundary();

    fireEvent.click(retryButton());
    fireEvent.click(retryButton());
    fireEvent.click(retryButton());
    expect(toast.info).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(1000));
    expect(retryButton()).toHaveTextContent(`Retry (${MAX_RETRIES - 1} Remaining)`);
  });

  it("backs off 1s, 2s, 4s and then offers only a reload", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...location, reload });
    renderBoundary();

    for (const [attempt, delay] of [1000, 2000, 4000].entries()) {
      fireEvent.click(retryButton());
      expect(toast.info).toHaveBeenLastCalledWith(`Retrying In ${delay / 1000}s…`);
      act(() => vi.advanceTimersByTime(delay));
      if (attempt < MAX_RETRIES - 1) {
        expect(retryButton()).toHaveTextContent(`Retry (${MAX_RETRIES - attempt - 1} Remaining)`);
      }
    }

    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload Application" }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  // The budget refills once the children stay up, so the app-lifetime root
  // boundary can keep retrying.
  it("refills the retry budget once the children stay up", () => {
    vi.useFakeTimers();
    const { rerender } = renderBoundary();

    fireEvent.click(retryButton());
    failure.thrown = null;
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(STABLE_RESET_MS));

    failure.thrown = new Error("Second Failure");
    rerender(
      <ErrorBoundary>
        <Child key="remount" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Second Failure");
    expect(retryButton()).toHaveTextContent(`Retry (${MAX_RETRIES} Remaining)`);
  });
});
