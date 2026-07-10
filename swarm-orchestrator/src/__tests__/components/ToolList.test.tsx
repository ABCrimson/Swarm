// ── ToolList UI description rendering (Task 8 item 3) ──
//
// The Tools page must render each built-in tool's Title Case
// `uiDescription`, never the sentence-case `description` reserved for the
// Anthropic API tool-schema path (see #lib/tools).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolList } from "#components/tools/ToolList";

describe("ToolList built-in tool descriptions", () => {
  it("renders the Title Case uiDescription, not the sentence-case API description", () => {
    render(
      <ToolList customTools={[]} onEdit={() => {}} onDelete={() => {}} onCreateNew={() => {}} />,
    );

    expect(screen.getByText("Spawn A New Worker Process. Returns The Worker ID.")).toBeVisible();
    expect(
      screen.queryByText("Spawn a new worker process. Returns the worker ID."),
    ).not.toBeInTheDocument();
  });
});
