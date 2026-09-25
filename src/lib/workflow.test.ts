import { describe, expect, it } from "vitest";
import { exportWorkflow, parseWorkflow, WorkflowFileError } from "#lib/workflow";

const NODE = { id: "w-a", type: "worker", position: { x: 10, y: 20 }, data: { label: "Alpha" } };

describe("exportWorkflow", () => {
  it("writes positions, display data and annotation edges (string labels only)", () => {
    const workflow = exportWorkflow(
      [NODE, { id: "w-b", position: { x: 0, y: 0 }, data: {} }],
      [
        { id: "e1", source: "w-a", target: "w-b", label: "note" },
        { id: "e2", source: "w-b", target: "w-a", label: { rich: true } },
      ],
    );

    expect(workflow.nodes).toEqual([
      NODE,
      { id: "w-b", type: "worker", position: { x: 0, y: 0 }, data: {} },
    ]);
    expect(workflow.edges).toEqual([
      { id: "e1", source: "w-a", target: "w-b", label: "note" },
      { id: "e2", source: "w-b", target: "w-a" },
    ]);
    expect(workflow.name).toMatch(/^Workflow \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("round-trips through parseWorkflow", () => {
    const workflow = exportWorkflow([NODE], []);

    expect(parseWorkflow(JSON.stringify(workflow))).toEqual(workflow);
  });
});

describe("parseWorkflow", () => {
  it("rejects text that is not JSON", () => {
    expect(() => parseWorkflow("{nope")).toThrow(
      new WorkflowFileError("The File Is Not Valid JSON"),
    );
  });

  it("rejects a file without nodes, naming the field", () => {
    expect(() => parseWorkflow(JSON.stringify({ id: "x", name: "y", edges: [] }))).toThrow(
      "Not A SWARM Workflow File (Invalid Value At nodes)",
    );
  });

  it("rejects a non-finite position (JSON has no Infinity, so null stands in)", () => {
    const bad = {
      id: "x",
      name: "y",
      nodes: [{ ...NODE, position: { x: null, y: 0 } }],
      edges: [],
    };

    expect(() => parseWorkflow(JSON.stringify(bad))).toThrow("At nodes.0.position.x");
  });

  it("rejects an empty edge endpoint", () => {
    const bad = { id: "x", name: "y", nodes: [], edges: [{ id: "e", source: "", target: "w" }] };

    expect(() => parseWorkflow(JSON.stringify(bad))).toThrow(WorkflowFileError);
  });

  it("ignores unknown keys from older files", () => {
    const legacy = { id: "x", name: "y", version: 1, nodes: [{ ...NODE, width: 220 }], edges: [] };

    expect(parseWorkflow(JSON.stringify(legacy)).nodes).toEqual([NODE]);
  });
});
