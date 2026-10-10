import { beforeEach, describe, expect, it } from "vitest";
import {
  createPostProcessPipeline,
  destroyPostProcessPipeline,
  renderPostProcess,
} from "#lib/postprocess";
import { recordingDevice, stubGpuGlobals } from "#test/gpu-device";

beforeEach(stubGpuGlobals);

const outputView = { kind: "swap-chain-view" } as unknown as GPUTextureView;

async function setup() {
  const recorder = recordingDevice();
  const pipeline = await createPostProcessPipeline(recorder.asGpu, "bgra8unorm", 800, 600);
  const scene = recorder.device.createTexture({
    label: "scene",
    size: { width: 800, height: 600 },
    format: "bgra8unorm",
    usage: 1,
  });
  return { ...recorder, pipeline, scene: scene as unknown as GPUTexture };
}

describe("createPostProcessPipeline", () => {
  it("compiles the six passes from one shared vertex module", async () => {
    const { device } = await setup();

    expect(device.createRenderPipelineAsync).toHaveBeenCalledTimes(6);
    const vertexModules = new Set(
      device.createRenderPipelineAsync.mock.calls.map(([d]) => d.vertex.module),
    );
    expect(vertexModules.size).toBe(1);
  });

  it("allocates one texel-size uniform per bloom mip plus the chromatic uniform", async () => {
    const { device } = await setup();

    // 4 mips + 1 chromatic-aberration uniform (no unbound buffers).
    expect(device.createBuffer).toHaveBeenCalledTimes(5);
  });
});

describe("renderPostProcess", () => {
  it("allocates no bind groups or views per frame once the scene texture is known", async () => {
    const { device, pipeline, scene } = await setup();
    renderPostProcess(device as unknown as GPUDevice, pipeline, scene, outputView);
    const bindGroups = device.createBindGroup.mock.calls.length;
    const sceneViews = (scene.createView as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;

    for (let frame = 0; frame < 5; frame++) {
      renderPostProcess(device as unknown as GPUDevice, pipeline, scene, outputView);
    }

    expect(device.createBindGroup.mock.calls.length).toBe(bindGroups);
    expect((scene.createView as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      sceneViews,
    );
  });

  it("draws threshold, 3 down, 3 up, composite, chromatic and vignette — the last into the output", async () => {
    const { device, pass, pipeline, scene } = await setup();

    renderPostProcess(device as unknown as GPUDevice, pipeline, scene, outputView);

    expect(pass.draw).toHaveBeenCalledTimes(10);
    const encoder = device.createCommandEncoder.mock.results.at(-1)?.value;
    const targets = encoder.beginRenderPass.mock.calls.map(
      ([d]: [GPURenderPassDescriptor]) => [...d.colorAttachments][0]?.view,
    );
    expect(targets.at(-1)).toBe(outputView);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the scene bind groups when a new scene texture arrives", async () => {
    const { device, pipeline, scene } = await setup();
    renderPostProcess(device as unknown as GPUDevice, pipeline, scene, outputView);
    const before = device.createBindGroup.mock.calls.length;
    const next = device.createTexture({
      label: "scene-2",
      size: { width: 800, height: 600 },
      format: "bgra8unorm",
      usage: 1,
    }) as unknown as GPUTexture;

    renderPostProcess(device as unknown as GPUDevice, pipeline, next, outputView);

    expect(device.createBindGroup.mock.calls.length).toBe(before + 2);
  });
});

describe("destroyPostProcessPipeline", () => {
  it("destroys every texture and buffer it created", async () => {
    const { device, pipeline } = await setup();

    destroyPostProcessPipeline(pipeline);

    // ping, pong and 4 mips (the test's own scene texture is not owned).
    const owned = device.createTexture.mock.results.slice(0, 6).map((r) => r.value);
    for (const texture of owned) expect(texture.destroy).toHaveBeenCalledTimes(1);
    for (const { value } of device.createBuffer.mock.results) {
      expect(value.destroy).toHaveBeenCalledTimes(1);
    }
  });
});
