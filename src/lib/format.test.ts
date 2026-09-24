import { describe, expect, it } from "vitest";
import { pluralize, pluralizeWorkers } from "#lib/format";

describe("pluralize", () => {
  it("uses the singular noun for exactly one", () => {
    expect(pluralize("Session", 1)).toBe("1 Session");
  });

  it("appends s for zero and for more than one", () => {
    expect(pluralize("Session", 0)).toBe("0 Sessions");
    expect(pluralize("Session", 12)).toBe("12 Sessions");
  });

  it("uses an irregular plural when one is given", () => {
    expect(pluralize("Entry", 1, "Entries")).toBe("1 Entry");
    expect(pluralize("Entry", 3, "Entries")).toBe("3 Entries");
  });
});

describe("pluralizeWorkers", () => {
  it("counts workers in Title Case", () => {
    expect(pluralizeWorkers(1)).toBe("1 Worker");
    expect(pluralizeWorkers(4)).toBe("4 Workers");
  });
});
