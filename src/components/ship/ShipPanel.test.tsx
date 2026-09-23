// ── ShipPanel Receipt Tests ─────────────────────────
//
// The settled receipt's "Open" link re-opens the compare page through
// @tauri-apps/plugin-opener. Regression: the click handler used to fire
// `void open(url)` with no rejection handling, so an opener failure
// (no default browser, a URL outside the capability scope) became an
// unhandled promise rejection instead of a user-visible error.

import { openUrl } from "@tauri-apps/plugin-opener";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShipPanel } from "#components/ship/ShipPanel";

const COMPARE_URL = "https://github.com/example/repo/compare/main...swarm/agent-abcd1234";

vi.mock("#hooks/useShip", () => ({
  useShip: () => ({
    state: "settled",
    preflight: null,
    message: "",
    setMessage: vi.fn(),
    mode: "all",
    setMode: vi.fn(),
    progress: [],
    error: null,
    result: {
      commitSha: "deadbeefcafe0123",
      pushedRef: "swarm/agent-abcd1234",
      prUrl: COMPARE_URL,
    },
    context: null,
    aiProse: null,
    setAiProse: vi.fn(),
    aiProseState: "idle",
    regenerateProse: vi.fn(),
    composedBody: null,
    runPreflight: vi.fn(),
    commitOnly: vi.fn(),
    commitAndPush: vi.fn(),
    commitPushAndOpenCompare: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe("ShipPanel receipt", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the compare page URL via the opener plugin", async () => {
    const user = userEvent.setup();
    render(<ShipPanel workerId="w-1" />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(openUrl).toHaveBeenCalledWith(COMPARE_URL);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces an opener rejection as a Title Case error toast instead of an unhandled rejection", async () => {
    const user = userEvent.setup();
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no default browser configured"));
    render(<ShipPanel workerId="w-1" />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Could Not Open The Compare Page: no default browser configured",
      );
    });
  });
});
