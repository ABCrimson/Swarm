import { beforeEach, describe, expect, it } from "vitest";
import {
  createParticleSystem,
  DEFAULT_SIM_PARAMS,
  dispatchCompute,
  PARTICLE_COMPUTE_WGSL,
  WORKGROUP_SIZE,
  writeSimParams,
} from "#lib/particles";
import { recordingDevice, stubGpuGlobals } from "#test/gpu-device";

/** Field names of the WGSL `SimParams` struct, in declaration order. */
function wgslSimParamsFields(): string[] {
  const body = /struct\s+SimParams\s*\{([^}]*)\}/.exec(PARTICLE_COMPUTE_WGSL)?.[1] ?? "";
  return body
    .split(",")
    .map((field) => field.split(":")[0]?.trim() ?? "")
    .filter(Boolean);
}

beforeEach(stubGpuGlobals);

describe("createParticleSystem", () => {
  it("compiles both pipelines, sets the workgroup-size override and uploads nothing", async () => {
    const { device, asGpu } = recordingDevice();

    const system = await createParticleSystem(asGpu, "bgra8unorm", 1000);

    expect(device.createComputePipelineAsync.mock.calls[0]?.[0].compute.constants).toEqual({
      WORKGROUP_SIZE,
    });
    // New buffers are zero-filled: no initial particle upload.
    expect(device.queue.writeBuffer).not.toHaveBeenCalled();
    expect(system.maxParticles).toBe(1000);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledOnce();
    expect(device.createRenderPipelineAsync.mock.calls[0]?.[0].fragment?.targets).toEqual([
      expect.objectContaining({ format: "bgra8unorm" }),
    ]);
    expect(system.computePipeline).toMatchObject({ kind: "compute-pipeline" });
    expect(system.renderPipeline).toMatchObject({ kind: "render-pipeline" });
    expect(device.createBuffer.mock.calls.map(([d]) => d.size)).toEqual([48 * 1000, 48, 8]);
  });
});

describe("writeSimParams", () => {
  it("packs every field at its WGSL struct offset, integers as u32", async () => {
    const { device, asGpu } = recordingDevice();
    const system = await createParticleSystem(asGpu, "bgra8unorm", 64);

    writeSimParams(asGpu, system, {
      ...DEFAULT_SIM_PARAMS,
      dt: 0.5,
      workerCount: 3,
      time: 12,
      deltaHue: 10,
      speedMultiplier: 2,
      chromaMultiplier: 1.5,
      throughput: 0.25,
      errorRate: 0.75,
      activeWorkers: 2,
      queueDepth: 7,
    });

    const bytes = device.queue.writeBuffer.mock.calls[0]?.[2] as ArrayBuffer;
    const f32 = new Float32Array(bytes);
    const u32 = new Uint32Array(bytes);
    const at = (name: string): number => wgslSimParamsFields().indexOf(name);
    expect(wgslSimParamsFields()).toHaveLength(bytes.byteLength / 4);
    expect(f32[at("dt")]).toBe(0.5);
    expect(u32[at("workerCount")]).toBe(3);
    expect(f32[at("time")]).toBe(12);
    expect(f32[at("deltaHue")]).toBe(10);
    expect(f32[at("speedMultiplier")]).toBe(2);
    expect(f32[at("chromaMultiplier")]).toBe(1.5);
    expect(f32[at("throughput")]).toBe(0.25);
    expect(f32[at("errorRate")]).toBe(0.75);
    expect(u32[at("activeWorkers")]).toBe(2);
    expect(u32[at("queueDepth")]).toBe(7);
    expect(device.queue.writeBuffer.mock.calls[0]?.[0]).toBe(system.simUniformBuffer);
    expect(device.queue.writeBuffer.mock.calls[0]?.[1]).toBe(0);
  });

  it("fills omitted optional fields from DEFAULT_SIM_PARAMS", async () => {
    const { device, asGpu } = recordingDevice();
    const system = await createParticleSystem(asGpu, "bgra8unorm", 64);
    writeSimParams(asGpu, system, {
      dt: 0.016,
      workerCount: 1,
      time: 0,
      deltaHue: 0,
      speedMultiplier: 1,
      chromaMultiplier: 1,
    });
    const bytes = device.queue.writeBuffer.mock.calls[0]?.[2] as ArrayBuffer;
    const f32 = new Float32Array(bytes);
    const at = (name: string): number => wgslSimParamsFields().indexOf(name);
    expect(f32[at("throughput")]).toBe(DEFAULT_SIM_PARAMS.throughput);
    expect(f32[at("errorRate")]).toBe(DEFAULT_SIM_PARAMS.errorRate);
  });
});

describe("dispatchCompute", () => {
  it("simulates only the requested count, in whole workgroups", async () => {
    const { device, pass, asGpu } = recordingDevice();
    const system = await createParticleSystem(asGpu, "bgra8unorm", 10_000);
    const encoder = device.createCommandEncoder() as unknown as GPUCommandEncoder;

    dispatchCompute(encoder, system, 2000);
    dispatchCompute(encoder, system);
    dispatchCompute(encoder, system, 50_000);

    expect(pass.dispatchWorkgroups.mock.calls).toEqual([
      [Math.ceil(2000 / WORKGROUP_SIZE)],
      [Math.ceil(10_000 / WORKGROUP_SIZE)],
      [Math.ceil(10_000 / WORKGROUP_SIZE)],
    ]);
    expect(pass.setPipeline).toHaveBeenCalledWith(system.computePipeline);
    expect(pass.setBindGroup).toHaveBeenCalledWith(0, system.computeBindGroup);
    expect(pass.end).toHaveBeenCalledTimes(3);
  });

  it("encodes nothing for zero particles", async () => {
    const { device, pass, asGpu } = recordingDevice();
    const system = await createParticleSystem(asGpu, "bgra8unorm", 100);

    dispatchCompute(device.createCommandEncoder() as unknown as GPUCommandEncoder, system, 0);

    expect(pass.dispatchWorkgroups).not.toHaveBeenCalled();
  });
});
