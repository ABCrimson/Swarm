/**
 * GPU-driven particle system for the app background.
 *
 * A compute shader simulates particles (PCG RNG respawn, velocity
 * damping, one gravity-well attractor per running worker); a render
 * pipeline draws them as instanced billboard quads with additive blending
 * for a soft glow.
 *
 * @module particles
 */

/** Compute workgroup size — the WGSL `override` below is set from this. */
export const WORKGROUP_SIZE = 64;

/**
 * The WGSL particle layout shared by the compute and vertex shaders;
 * {@link PARTICLE_BYTE_SIZE} is its 16-byte-aligned size.
 */
const PARTICLE_STRUCT_WGSL = /* wgsl */ `struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  color: vec4f,
}`;

/** WGSL compute shader for particle simulation (position, velocity, life, colour). */
export const PARTICLE_COMPUTE_WGSL = /* wgsl */ `
${PARTICLE_STRUCT_WGSL}

struct SimParams {
  dt: f32,
  workerCount: u32,
  time: f32,
  deltaHue: f32,
  speedMultiplier: f32,
  chromaMultiplier: f32,
  throughput: f32,
  errorRate: f32,
  activeWorkers: u32,
  queueDepth: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: SimParams;

// PCG hash for deterministic pseudo-random
fn pcg(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  var word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand(seed: u32) -> f32 {
  return f32(pcg(seed)) / 4294967295.0;
}

override WORKGROUP_SIZE: u32 = 64u;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&particles)) { return; }

  var p = particles[idx];

  // queueDepth controls emission rate: higher queue = faster respawn
  let emissionRate = 0.15 + f32(params.queueDepth) * 0.02;

  // Update life
  p.life -= params.dt * emissionRate;

  // Respawn dead particles
  if (p.life <= 0.0) {
    let seed1 = idx * 17u + u32(params.time * 1000.0);
    let seed2 = seed1 + 7919u;
    let seed3 = seed1 + 104729u;
    let seed4 = seed1 + 224737u;

    p.pos = vec2f(
      rand(seed1) * 2.0 - 1.0,
      rand(seed2) * 2.0 - 1.0,
    );

    // throughput drives particle speed
    let throughputSpeed = max(params.throughput, 0.1);
    let speed = (rand(seed3) * 0.3 + 0.05) * params.speedMultiplier * throughputSpeed;
    let angle = rand(seed4) * 6.28318530718;
    p.vel = vec2f(cos(angle), sin(angle)) * speed;

    p.life = rand(seed1 + 31u) * 0.7 + 0.3;

    // Hue: one slot per worker around the wheel from deltaHue;
    // errorRate pulls it toward rose (h=10).
    let workerF = f32(params.workerCount);
    let baseHue = mix(params.deltaHue, 10.0, params.errorRate);
    let hueBase = baseHue + f32(idx % max(params.workerCount, 1u)) * (360.0 / max(workerF, 1.0));
    let hueNorm = fract(hueBase / 360.0);

    // OKLCH-inspired cosine palette (not an OKLCH conversion): three
    // phase-shifted cosines around a 0.78 grey, amplitude 0.18 × chroma.
    let h = hueNorm * 6.28318530718;
    let chroma = 0.18 * params.chromaMultiplier;
    p.color = vec4f(
      0.78 + chroma * cos(h),
      0.78 + chroma * cos(h - 2.094),
      0.78 + chroma * cos(h + 2.094),
      1.0,
    );
  }

  // Apply velocity
  p.pos += p.vel * params.dt;

  // Soft boundary wrapping
  if (p.pos.x < -1.2) { p.pos.x = 1.2; }
  if (p.pos.x >  1.2) { p.pos.x = -1.2; }
  if (p.pos.y < -1.2) { p.pos.y = 1.2; }
  if (p.pos.y >  1.2) { p.pos.y = -1.2; }

  // Gravity wells from active workers: each active worker creates an attractor
  let numAttractors = max(params.activeWorkers, 1u);
  for (var a = 0u; a < numAttractors; a = a + 1u) {
    let attractAngle = f32(a) * 6.28318530718 / f32(numAttractors);
    let attractPos = vec2f(cos(attractAngle) * 0.5, sin(attractAngle) * 0.5);
    let toAttractor = attractPos - p.pos;
    let dist = length(toAttractor);
    if (dist > 0.01) {
      p.vel += normalize(toAttractor) * 0.02 * params.dt / (dist + 0.5);
    }
  }

  // errorRate increases turbulence
  if (params.errorRate > 0.0) {
    let turbSeed = idx * 31u + u32(params.time * 500.0);
    let turbX = (rand(turbSeed) - 0.5) * 2.0 * params.errorRate * 0.5;
    let turbY = (rand(turbSeed + 1u) - 0.5) * 2.0 * params.errorRate * 0.5;
    p.vel += vec2f(turbX, turbY) * params.dt;
  }

  // Gentle drift toward center (fallback gravity well)
  let toCenter = -p.pos * 0.02;
  p.vel += toCenter * params.dt;

  // Damping
  p.vel *= 0.998;

  particles[idx] = p;
}
`;

/** WGSL vertex shader for instanced billboard quad rendering. */
const PARTICLE_VERTEX_WGSL = /* wgsl */ `
${PARTICLE_STRUCT_WGSL}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) alpha: f32,
}

struct RenderParams {
  aspectRatio: f32,
  particleSize: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> renderParams: RenderParams;

// Billboard quad: 4 vertices forming a quad via triangle-strip
const QUAD_POS = array<vec2f, 4>(
  vec2f(-1.0, -1.0),
  vec2f( 1.0, -1.0),
  vec2f(-1.0,  1.0),
  vec2f( 1.0,  1.0),
);

const QUAD_UV = array<vec2f, 4>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 1.0),
);

@vertex
fn main(
  @builtin(vertex_index) vertexIdx: u32,
  @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
  let p = particles[instanceIdx];
  let quadPos = QUAD_POS[vertexIdx];

  // Billboard expansion scaled by particle size
  let size = renderParams.particleSize * p.life;
  var offset = quadPos * size;
  offset.x /= renderParams.aspectRatio;

  var out: VertexOutput;
  out.position = vec4f(p.pos + offset, 0.0, 1.0);
  out.uv = QUAD_UV[vertexIdx];
  out.color = p.color;
  out.alpha = p.life * 0.6;
  return out;
}
`;

/** WGSL fragment shader with soft-circle falloff and alpha blending. */
const PARTICLE_FRAGMENT_WGSL = /* wgsl */ `
struct FragInput {
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) alpha: f32,
}

@fragment
fn main(in: FragInput) -> @location(0) vec4f {
  // Soft circle falloff
  let dist = length(in.uv - vec2f(0.5));
  let circle = 1.0 - smoothstep(0.4, 0.5, dist);

  if (circle < 0.01) {
    discard;
  }

  return vec4f(in.color.rgb * circle, circle * in.alpha);
}
`;

/** Uniform parameters for the compute shader (the WGSL `SimParams`). */
export interface SimParams {
  dt: number;
  workerCount: number;
  time: number;
  deltaHue: number;
  speedMultiplier: number;
  chromaMultiplier: number;
  /** Tokens/sec normalized to 0-1 range. Drives particle speed. */
  throughput?: number;
  /** Error rate normalized to 0-1. Shifts hue toward red and adds turbulence. */
  errorRate?: number;
  /** Count of running workers. Creates gravity well attractors. */
  activeWorkers?: number;
  /** AI queue depth. Controls particle emission rate. */
  queueDepth?: number;
}

/** Default simulation parameters. */
export const DEFAULT_SIM_PARAMS: Required<SimParams> = {
  dt: 0.016,
  workerCount: 0,
  time: 0,
  deltaHue: 205,
  speedMultiplier: 1.0,
  chromaMultiplier: 1.0,
  throughput: 0.5,
  errorRate: 0,
  activeWorkers: 0,
  queueDepth: 0,
};

// ── Particle byte layout ───────────────────────────
// pos: vec2f (8 bytes), vel: vec2f (8 bytes), life: f32 (4 bytes),
// padding: 12 bytes (align to 16), color: vec4f (16 bytes) = 48 bytes total
const PARTICLE_BYTE_SIZE = 48;
/** 10 four-byte fields (40 bytes), allocated in 16-byte steps. */
const SIM_PARAMS_FIELDS = 10;
const SIM_PARAMS_BYTE_SIZE = 48;
const RENDER_PARAMS_BYTE_SIZE = 8; // 2 fields * 4 bytes

/**
 * Staging memory for one SimParams write, reused every frame (`writeBuffer`
 * copies synchronously). f32 and u32 views over the same bytes.
 */
const simParamsBytes = new ArrayBuffer(SIM_PARAMS_FIELDS * 4);
const simParamsF32 = new Float32Array(simParamsBytes);
const simParamsU32 = new Uint32Array(simParamsBytes);

/**
 * sRGB-encoded clear colour of oklch(0.06 0.02 220) (the `--color-void`
 * token), written as-is into the non-sRGB canvas format. Its red channel
 * is just outside sRGB and clips to 0.
 */
const VOID_CLEAR: GPUColor = { r: 0, g: 0.0039, b: 0.0082, a: 1 };

/** GPU resource handles comprising the full particle simulation + render system. */
export interface ParticleSystem {
  computePipeline: GPUComputePipeline;
  renderPipeline: GPURenderPipeline;
  particleBuffer: GPUBuffer;
  simUniformBuffer: GPUBuffer;
  renderUniformBuffer: GPUBuffer;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
  maxParticles: number;
}

/**
 * Creates the full particle system: compute pipeline for simulation,
 * render pipeline for instanced billboard drawing.
 *
 * Both pipelines compile concurrently (`create*PipelineAsync`). If either
 * one rejects, the buffers are destroyed before the error propagates. New
 * WebGPU buffers are zero-filled, so every particle starts with zero life
 * and respawns on the first step.
 */
export async function createParticleSystem(
  device: GPUDevice,
  format: GPUTextureFormat,
  maxParticles: number,
): Promise<ParticleSystem> {
  // ── Buffers ────────────────────────────────────
  const particleBuffer = device.createBuffer({
    size: PARTICLE_BYTE_SIZE * maxParticles,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const simUniformBuffer = device.createBuffer({
    size: SIM_PARAMS_BYTE_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderUniformBuffer = device.createBuffer({
    size: RENDER_PARAMS_BYTE_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ── Compute Pipeline ───────────────────────────
  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  const computePipelinePromise = device.createComputePipelineAsync({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [computeBindGroupLayout],
    }),
    compute: {
      module: device.createShaderModule({ code: PARTICLE_COMPUTE_WGSL }),
      constants: { WORKGROUP_SIZE },
    },
  });

  const computeBindGroup = device.createBindGroup({
    layout: computeBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: simUniformBuffer } },
    ],
  });

  // ── Render Pipeline ────────────────────────────
  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });

  const renderPipelinePromise = device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout],
    }),
    vertex: { module: device.createShaderModule({ code: PARTICLE_VERTEX_WGSL }) },
    fragment: {
      module: device.createShaderModule({ code: PARTICLE_FRAGMENT_WGSL }),
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one",
              operation: "add",
            },
            alpha: {
              srcFactor: "src-alpha",
              dstFactor: "one",
              operation: "add",
            },
          },
          writeMask: GPUColorWrite.ALL,
        },
      ],
    },
    primitive: { topology: "triangle-strip" },
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: renderUniformBuffer } },
    ],
  });

  let computePipeline: GPUComputePipeline;
  let renderPipeline: GPURenderPipeline;
  try {
    [computePipeline, renderPipeline] = await Promise.all([
      computePipelinePromise,
      renderPipelinePromise,
    ]);
  } catch (err) {
    // The caller gets no handle on failure, so free the buffers here.
    particleBuffer.destroy();
    simUniformBuffer.destroy();
    renderUniformBuffer.destroy();
    throw err;
  }

  return {
    computePipeline,
    renderPipeline,
    particleBuffer,
    simUniformBuffer,
    renderUniformBuffer,
    computeBindGroup,
    renderBindGroup,
    maxParticles,
  };
}

/**
 * Writes simulation parameters into the GPU uniform, in the WGSL
 * `SimParams` field order (`workerCount`, `activeWorkers` and
 * `queueDepth` as u32, the rest as f32).
 */
export function writeSimParams(device: GPUDevice, system: ParticleSystem, params: SimParams): void {
  simParamsF32.set([
    params.dt,
    0, // workerCount (u32, below)
    params.time,
    params.deltaHue,
    params.speedMultiplier,
    params.chromaMultiplier,
    params.throughput ?? DEFAULT_SIM_PARAMS.throughput,
    params.errorRate ?? DEFAULT_SIM_PARAMS.errorRate,
  ]);
  simParamsU32[1] = params.workerCount;
  simParamsU32[8] = params.activeWorkers ?? DEFAULT_SIM_PARAMS.activeWorkers;
  simParamsU32[9] = params.queueDepth ?? DEFAULT_SIM_PARAMS.queueDepth;
  device.queue.writeBuffer(system.simUniformBuffer, 0, simParamsBytes);
}

/**
 * Byte offset of `time` in the WGSL `SimParams` uniform, read from the
 * shader source itself so a reordered struct cannot silently break the
 * per-frame write. Every field before it must be a 4-byte scalar;
 * otherwise this is `null` and {@link writeSimTime} does nothing, leaving
 * the clock to the parameter sync.
 */
export const SIM_TIME_OFFSET: number | null = (() => {
  const body = /struct\s+SimParams\s*\{([^}]*)\}/.exec(PARTICLE_COMPUTE_WGSL)?.[1];
  if (!body) return null;
  const fields = body
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => field.split(":").map((part) => part.trim()));
  const index = fields.findIndex(([name]) => name === "time");
  if (index === -1) return null;
  const scalar = fields.slice(0, index).every(([, type]) => type === "f32" || type === "u32");
  return scalar ? index * 4 : null;
})();

/**
 * Writes only the simulation clock (seconds) into the uniform, leaving
 * every other `SimParams` field as {@link writeSimParams} last set it.
 * The render loop calls this once per simulation step, so callers never
 * handle the struct's byte offsets.
 */
export function writeSimTime(device: GPUDevice, system: ParticleSystem, time: number): void {
  if (SIM_TIME_OFFSET === null) return;
  device.queue.writeBuffer(system.simUniformBuffer, SIM_TIME_OFFSET, Float32Array.of(time));
}

/** Write render parameters (aspect ratio + particle size). */
export function writeRenderParams(
  device: GPUDevice,
  system: ParticleSystem,
  width: number,
  height: number,
): void {
  const aspectRatio = width / Math.max(height, 1);
  const particleSize = 0.008;
  const data = new Float32Array([aspectRatio, particleSize]);
  device.queue.writeBuffer(system.renderUniformBuffer, 0, data);
}

/**
 * Encodes one simulation step for the first `count` particles (default:
 * all of them) — pass the drawn count so particles that are not drawn are
 * not simulated either.
 */
export function dispatchCompute(
  encoder: GPUCommandEncoder,
  system: ParticleSystem,
  count: number = system.maxParticles,
): void {
  const simulated = Math.min(Math.max(count, 0), system.maxParticles);
  if (simulated === 0) return;
  const pass = encoder.beginComputePass({ label: "particles-simulate" });
  pass.setPipeline(system.computePipeline);
  pass.setBindGroup(0, system.computeBindGroup);
  pass.dispatchWorkgroups(Math.ceil(simulated / WORKGROUP_SIZE));
  pass.end();
}

/** Render particles as instanced billboard quads. */
export function renderParticles(
  encoder: GPUCommandEncoder,
  system: ParticleSystem,
  textureView: GPUTextureView,
  particleCount: number,
): void {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: textureView,
        clearValue: VOID_CLEAR,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(system.renderPipeline);
  pass.setBindGroup(0, system.renderBindGroup);
  pass.draw(4, particleCount);
  pass.end();
}

/** Destroy all GPU resources held by the particle system. */
export function destroyParticleSystem(system: ParticleSystem): void {
  system.particleBuffer.destroy();
  system.simUniformBuffer.destroy();
  system.renderUniformBuffer.destroy();
}
