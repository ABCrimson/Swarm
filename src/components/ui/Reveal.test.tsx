import { act, render, screen } from "@testing-library/react";
import { use } from "react";
import { describe, expect, it } from "vitest";
import { Reveal } from "#components/ui/Reveal";

function Answer({ read }: { readonly read: Promise<string> }): React.ReactElement {
  return <p>{use(read)}</p>;
}

describe("Reveal", () => {
  it("renders its children at once when nothing suspends", () => {
    render(
      <Reveal fallback={<p>Loading</p>}>
        <p>Ready</p>
      </Reveal>,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
  });

  it("is a Suspense boundary: the fallback shows until the read answers, then the content", async () => {
    const read = Promise.withResolvers<string>();
    await act(async () =>
      render(
        <Reveal fallback={<p role="status">Loading</p>}>
          <Answer read={read.promise} />
        </Reveal>,
      ),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    await act(async () => read.resolve("Answered"));

    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("adds no element of its own around the content", () => {
    const { container } = render(
      <Reveal fallback={null}>
        <section aria-label="Content" />
      </Reveal>,
    );

    expect(container.firstElementChild).toBe(screen.getByRole("region", { name: "Content" }));
  });
});
