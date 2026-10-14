// ── ProviderBadge ─────────────────────────────────────
// Shared Pill badge for a live agent session's provider + model —
// covers the Title Case provider label and that the model is shown in
// the badge text, not only in a hover title.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderBadge } from "#components/worker/ProviderBadge";

describe("ProviderBadge", () => {
  it("shows the Title Case provider label and the model together", () => {
    render(<ProviderBadge provider="claude_code" model="sonnet" />);

    expect(screen.getByText("Claude Code · sonnet")).toBeInTheDocument();
  });

  it("renders as a Pill (swarm-pill class), not a bespoke span", () => {
    render(<ProviderBadge provider="claude_code" model="opus" />);

    expect(screen.getByText("Claude Code · opus").closest(".swarm-pill")).not.toBeNull();
  });

  it("shows the Codex label for a codex-provider session", () => {
    render(<ProviderBadge provider="codex" model="gpt-5-codex" />);

    expect(screen.getByText("Codex · gpt-5-codex")).toBeInTheDocument();
  });
});

describe("ProviderBadge — Trojan Source", () => {
  it("shows an agent-supplied model with a bidi override as escaped data", () => {
    render(<ProviderBadge provider="codex" model={"m\u202Eodel"} />);

    const badge = screen.getByText(String.raw`Codex · m\u202Eodel`);
    expect(badge.closest("[title]")).toHaveAttribute("title", String.raw`Codex · m\u202Eodel`);
  });
});
