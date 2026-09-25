// ── Test-Only Recording GPUDevice ────────────────────
// jsdom has no WebGPU. This fake records what the particle and
// post-processing modules ask of a device — enough to test allocation
// and encoding behaviour, not rendering. Imported only by tests.

import { vi } from "vitest";

/** WebGPU flag namespaces jsdom lacks; values are irrelevant to the fake. */
export function stubGpuGlobals(): void {
  const flags = new Proxy({}, { get: () => 1 });
  vi.stubGlobal("GPUBufferUsage", flags);
  vi.stubGlobal("GPUTextureUsage", flags);
  vi.stubGlobal("GPUShaderStage", flags);
  vi.stubGlobal("GPUColorWrite", flags);
}

/** A fake device whose every factory is a spy returning a tagged stub. */
export function recordingDevice() {
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
  const texture = (descriptor: GPUTextureDescriptor) => {
    const size = descriptor.size as GPUExtent3DDict;
    return {
      label: descriptor.label,
      width: size.width,
      height: size.height ?? 1,
      createView: vi.fn(() => ({ kind: "view", of: descriptor.label })),
      destroy: vi.fn(),
    };
  };
  const device = {
    createSampler: vi.fn(() => ({ kind: "sampler" })),
    createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => ({ kind: "module", code: d.code })),
    createTexture: vi.fn(texture),
    createBuffer: vi.fn((d: GPUBufferDescriptor) => ({
      kind: "buffer",
      size: d.size,
      destroy: vi.fn(),
    })),
    createBindGroupLayout: vi.fn(() => ({ kind: "layout" })),
    createPipelineLayout: vi.fn(() => ({ kind: "pipeline-layout" })),
    createRenderPipelineAsync: vi.fn(async (d: GPURenderPipelineDescriptor) => ({
      kind: "render-pipeline",
      descriptor: d,
    })),
    createComputePipelineAsync: vi.fn(async (d: GPUComputePipelineDescriptor) => ({
      kind: "compute-pipeline",
      descriptor: d,
    })),
    createBindGroup: vi.fn(() => ({ kind: "bind-group" })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => pass),
      beginComputePass: vi.fn(() => pass),
      finish: vi.fn(() => ({ kind: "command-buffer" })),
    })),
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  };
  return { device, pass, asGpu: device as unknown as GPUDevice };
}
