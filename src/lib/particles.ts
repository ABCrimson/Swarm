/**
 * GPU-driven particle system (Milestones 0.6.1 + 0.6.2).
 *
 * Compute shader simulates particles with PCG RNG, velocity damping,
 * and a gravity-well attractor. Render pipeline uses instanced billboard
 * quads with additive blending for a soft-glow aesthetic.
 *
 * @module particles
 */

/** WGSL compute shader for particle simulation (position, velocity, life, colour). */
export const PARTICLE_COMPUTE_WGSL = /* wgsl */ `
struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  color: vec4f,
}

struct SimParams {
  dt: f32,
  workerCount: u32,
  time: f32,
  deltaHue: f32,
  canvasWidth: f32,
  canvasHeight: f32,
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

@compute @workgroup_size(64)
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

    // OKLCH-derived color: rotate hue based on worker count
    // errorRate shifts hue toward red (h=10)
    let workerF = f32(params.workerCount);
    let baseHue = mix(params.deltaHue, 10.0, params.errorRate);
    let hueBase = baseHue + f32(idx % max(params.workerCount, 1u)) * (360.0 / max(workerF, 1.0));
    let hueNorm = fract(hueBase / 360.0);

    // Approximate OKLCH to linear sRGB for GPU rendering
    // Using a simplified mapping: hue -> RGB with constant L=0.78 C=0.18
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
export const PARTICLE_VERTEX_WGSL = /* wgsl */ `
struct Particle {
  pos: vec2f,
  vel: vec2f,
  life: f32,
  color: vec4f,
}

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
export const PARTICLE_FRAGMENT_WGSL = /* wgsl */ `
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

/** Uniform parameters passed to the compute shader each frame. */
export interface SimParams {
  dt: number;
  workerCount: number;
  time: number;
  deltaHue: number;
  canvasWidth: number;
  canvasHeight: number;
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
  canvasWidth: 1920,
  canvasHeight: 1080,
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
const SIM_PARAMS_BYTE_SIZE = 48; // 12 fields * 4 bytes
const RENDER_PARAMS_BYTE_SIZE = 8; // 2 fields * 4 bytes

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
  querySet: GPUQuerySet | null;
  queryBuffer: GPUBuffer | null;
  readbackBuffer: GPUBuffer | null;
  timestampsSupported: boolean;
}

/**
 * Creates the full particle system: compute pipeline for simulation,
 * render pipeline for instanced billboard drawing.
 *
 * Uses `createComputePipelineAsync` / `createRenderPipelineAsync` for
 * non-blocking pipeline compilation.
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

  // Initialize particles with zero life so they respawn immediately
  const initData = new Float32Array(maxParticles * (PARTICLE_BYTE_SIZE / 4));
  device.queue.writeBuffer(particleBuffer, 0, initData);

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

  const computePipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [computeBindGroupLayout],
    }),
    compute: {
      module: device.createShaderModule({ code: PARTICLE_COMPUTE_WGSL }),
      entryPoint: "main",
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

  const renderPipeline = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout],
    }),
    vertex: {
      module: device.createShaderModule({ code: PARTICLE_VERTEX_WGSL }),
      entryPoint: "main",
    },
    fragment: {
      module: device.createShaderModule({ code: PARTICLE_FRAGMENT_WGSL }),
      entryPoint: "main",
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
    primitive: {
      topology: "triangle-strip",
      stripIndexFormat: "uint32",
    },
    multisample: { count: 1 },
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: renderUniformBuffer } },
    ],
  });

  // ── Timestamp Queries (optional) ───────────────
  const timestampsSupported = device.features.has("timestamp-query");
  let querySet: GPUQuerySet | null = null;
  let queryBuffer: GPUBuffer | null = null;
  let readbackBuffer: GPUBuffer | null = null;

  if (timestampsSupported) {
    querySet = device.createQuerySet({
      type: "timestamp",
      count: 2,
    });

    queryBuffer = device.createBuffer({
      size: 16, // 2 * BigUint64
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });

    readbackBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
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
    querySet,
    queryBuffer,
    readbackBuffer,
    timestampsSupported,
  };
}

/** Write simulation parameters into the GPU uniform buffer. */
export function writeSimParams(device: GPUDevice, system: ParticleSystem, params: SimParams): void {
  const throughput = params.throughput ?? DEFAULT_SIM_PARAMS.throughput;
  const errorRate = params.errorRate ?? DEFAULT_SIM_PARAMS.errorRate;
  const activeWorkers = params.activeWorkers ?? DEFAULT_SIM_PARAMS.activeWorkers;
  const queueDepth = params.queueDepth ?? DEFAULT_SIM_PARAMS.queueDepth;

  const data = new Float32Array([
    params.dt,
    params.workerCount, // will be reinterpreted as u32 in shader via bitcast
    params.time,
    params.deltaHue,
    params.canvasWidth,
    params.canvasHeight,
    params.speedMultiplier,
    params.chromaMultiplier,
    throughput,
    errorRate,
    activeWorkers, // u32, patched below
    queueDepth, // u32, patched below
  ]);

  // Patch integer fields as u32
  const u32View = new Uint32Array(data.buffer);
  u32View[1] = params.workerCount;
  u32View[10] = activeWorkers;
  u32View[11] = queueDepth;

  device.queue.writeBuffer(system.simUniformBuffer, 0, data);
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

/** Dispatch the compute shader to update particles. */
export function dispatchCompute(encoder: GPUCommandEncoder, system: ParticleSystem): void {
  const pass = encoder.beginComputePass({
    timestampWrites:
      system.timestampsSupported && system.querySet
        ? { querySet: system.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
        : undefined,
  });
  pass.setPipeline(system.computePipeline);
  pass.setBindGroup(0, system.computeBindGroup);
  pass.dispatchWorkgroups(Math.ceil(system.maxParticles / 64));
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
        clearValue: { r: 0.024, g: 0.022, b: 0.027, a: 1.0 }, // oklch(0.06 0.02 220) approx
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

/**
 * Resolve GPU timestamps and read back frame time in milliseconds.
 * Returns null if timestamps are not supported or the buffer is still mapped.
 */
export async function readGPUFrameTime(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  system: ParticleSystem,
): Promise<number | null> {
  if (
    !system.timestampsSupported ||
    !system.querySet ||
    !system.queryBuffer ||
    !system.readbackBuffer
  ) {
    return null;
  }

  encoder.resolveQuerySet(system.querySet, 0, 2, system.queryBuffer, 0);
  encoder.copyBufferToBuffer(system.queryBuffer, 0, system.readbackBuffer, 0, 16);

  device.queue.submit([encoder.finish()]);

  try {
    await system.readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new BigUint64Array(system.readbackBuffer.getMappedRange());
    const start = data[0];
    const end = data[1];
    system.readbackBuffer.unmap();

    if (start === undefined || end === undefined) return null;

    // Timestamps are in nanoseconds
    const ns = Number(end - start);
    return ns / 1_000_000; // Convert to milliseconds
  } catch {
    return null;
  }
}

/** Destroy all GPU resources held by the particle system. */
export function destroyParticleSystem(system: ParticleSystem): void {
  system.particleBuffer.destroy();
  system.simUniformBuffer.destroy();
  system.renderUniformBuffer.destroy();
  system.querySet?.destroy();
  system.queryBuffer?.destroy();
  system.readbackBuffer?.destroy();
}
