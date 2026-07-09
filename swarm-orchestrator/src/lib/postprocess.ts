// ── Post-Processing Pipeline ─────────────────────────
// Milestone 0.6.3: Bloom, Chromatic Aberration, Vignette
// All passes chained via ping-pong framebuffers.

// ── Shared fullscreen triangle vertex shader ────────
const FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn main(@builtin(vertex_index) idx: u32) -> VertexOutput {
  // Fullscreen triangle (3 vertices cover the entire screen)
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );

  var out: VertexOutput;
  out.position = vec4f(pos[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}
`;

// ── Bloom Threshold + Downsample ────────────────────
const BLOOM_THRESHOLD_WGSL = /* wgsl */ `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSample(inputTex, inputSampler, uv);

  // Luminance threshold (approximate perceptual luminance)
  let luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let bright = select(vec4f(0.0), color, luminance > 0.7);
  return bright;
}
`;

// ── Dual Kawase Blur (Down) ─────────────────────────
const KAWASE_DOWN_WGSL = /* wgsl */ `
struct BlurParams {
  texelSize: vec2f,
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: BlurParams;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ts = params.texelSize;
  var color = textureSample(inputTex, inputSampler, uv) * 4.0;
  color += textureSample(inputTex, inputSampler, uv + vec2f(-ts.x, -ts.y));
  color += textureSample(inputTex, inputSampler, uv + vec2f( ts.x, -ts.y));
  color += textureSample(inputTex, inputSampler, uv + vec2f(-ts.x,  ts.y));
  color += textureSample(inputTex, inputSampler, uv + vec2f( ts.x,  ts.y));
  return color / 8.0;
}
`;

// ── Dual Kawase Blur (Up) ───────────────────────────
const KAWASE_UP_WGSL = /* wgsl */ `
struct BlurParams {
  texelSize: vec2f,
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: BlurParams;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ts = params.texelSize;
  var color = textureSample(inputTex, inputSampler, uv + vec2f(-ts.x,  0.0));
  color += textureSample(inputTex, inputSampler, uv + vec2f( ts.x,  0.0));
  color += textureSample(inputTex, inputSampler, uv + vec2f( 0.0, -ts.y));
  color += textureSample(inputTex, inputSampler, uv + vec2f( 0.0,  ts.y));
  color += textureSample(inputTex, inputSampler, uv + vec2f(-ts.x, -ts.y)) * 2.0;
  color += textureSample(inputTex, inputSampler, uv + vec2f( ts.x, -ts.y)) * 2.0;
  color += textureSample(inputTex, inputSampler, uv + vec2f(-ts.x,  ts.y)) * 2.0;
  color += textureSample(inputTex, inputSampler, uv + vec2f( ts.x,  ts.y)) * 2.0;
  return color / 12.0;
}
`;

// ── Bloom Composite ────────────────────────────────
const BLOOM_COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTex, inputSampler, uv);
  let bloom = textureSample(bloomTex, inputSampler, uv);
  return scene + bloom * 0.3;
}
`;

// ── Chromatic Aberration ───────────────────────────
const CHROMATIC_ABERRATION_WGSL = /* wgsl */ `
struct CAParams {
  texelSize: vec2f,
  intensity: f32,
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: CAParams;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let center = vec2f(0.5);
  let toCenter = uv - center;
  let dist = length(toCenter);
  let distortion = dist * dist * params.intensity;

  let r = textureSample(inputTex, inputSampler, uv + toCenter * distortion).r;
  let g = textureSample(inputTex, inputSampler, uv).g;
  let b = textureSample(inputTex, inputSampler, uv - toCenter * distortion).b;
  let a = textureSample(inputTex, inputSampler, uv).a;

  return vec4f(r, g, b, a);
}
`;

// ── Vignette ──────────────────────────────────────
const VIGNETTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSample(inputTex, inputSampler, uv);

  // Vignette: oklch(0 0 0 / 0.4) at edges, clear center
  let center = vec2f(0.5);
  let dist = length(uv - center) * 1.4;
  let vignette = 1.0 - smoothstep(0.4, 1.2, dist) * 0.4;

  return vec4f(color.rgb * vignette, color.a);
}
`;

// ── Bloom mip levels ────────────────────────────────
const BLOOM_MIP_COUNT = 4;

/** GPU resource handles for the full post-processing chain (bloom, CA, vignette). */
export interface PostProcessPipeline {
  bloomThresholdPipeline: GPURenderPipeline;
  kawaseDownPipeline: GPURenderPipeline;
  kawaseUpPipeline: GPURenderPipeline;
  bloomCompositePipeline: GPURenderPipeline;
  chromaticPipeline: GPURenderPipeline;
  vignettePipeline: GPURenderPipeline;
  sampler: GPUSampler;
  blurParamsBuffers: GPUBuffer[];
  caParamsBuffer: GPUBuffer;
  pingTexture: GPUTexture;
  pongTexture: GPUTexture;
  bloomMips: GPUTexture[];
  width: number;
  height: number;
}

/** Create a fullscreen pass pipeline with the given fragment shader. */
async function createFullscreenPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  fragmentCode: string,
  bindGroupLayout: GPUBindGroupLayout,
  label: string,
): Promise<GPURenderPipeline> {
  return await device.createRenderPipelineAsync({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: device.createShaderModule({ code: FULLSCREEN_VERTEX_WGSL }),
      entryPoint: "main",
    },
    fragment: {
      module: device.createShaderModule({ code: fragmentCode }),
      entryPoint: "main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });
}

/** Create the full post-processing pipeline. */
export async function createPostProcessPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  width: number,
  height: number,
): Promise<PostProcessPipeline> {
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });

  // Texture creation helper
  const createTex = (w: number, h: number, label: string): GPUTexture =>
    device.createTexture({
      label,
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

  const pingTexture = createTex(width, height, "ping");
  const pongTexture = createTex(width, height, "pong");

  // Bloom mip chain
  const bloomMips: GPUTexture[] = [];
  for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
    const mipW = Math.max(1, width >> (i + 1));
    const mipH = Math.max(1, height >> (i + 1));
    bloomMips.push(createTex(mipW, mipH, `bloom-mip-${i}`));
  }

  // ── Bind group layouts ─────────────────────────
  const texSamplerLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  const texSamplerUniformLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  });

  const bloomCompositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  // ── Pipelines ──────────────────────────────────
  const bloomThresholdPipeline = await createFullscreenPipeline(
    device,
    format,
    BLOOM_THRESHOLD_WGSL,
    texSamplerLayout,
    "bloom-threshold",
  );

  const kawaseDownPipeline = await createFullscreenPipeline(
    device,
    format,
    KAWASE_DOWN_WGSL,
    texSamplerUniformLayout,
    "kawase-down",
  );

  const kawaseUpPipeline = await createFullscreenPipeline(
    device,
    format,
    KAWASE_UP_WGSL,
    texSamplerUniformLayout,
    "kawase-up",
  );

  const bloomCompositePipeline = await createFullscreenPipeline(
    device,
    format,
    BLOOM_COMPOSITE_WGSL,
    bloomCompositeLayout,
    "bloom-composite",
  );

  const chromaticPipeline = await createFullscreenPipeline(
    device,
    format,
    CHROMATIC_ABERRATION_WGSL,
    texSamplerUniformLayout,
    "chromatic-aberration",
  );

  const vignettePipeline = await createFullscreenPipeline(
    device,
    format,
    VIGNETTE_WGSL,
    texSamplerLayout,
    "vignette",
  );

  // ── Uniform buffers ───────────────────────────
  const blurParamsBuffers: GPUBuffer[] = [];
  for (let i = 0; i < BLOOM_MIP_COUNT * 2; i++) {
    const buf = device.createBuffer({
      size: 8, // vec2f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    blurParamsBuffers.push(buf);
  }

  const caParamsBuffer = device.createBuffer({
    size: 16, // vec2f + f32 + padding
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Write initial blur params
  for (let i = 0; i < BLOOM_MIP_COUNT; i++) {
    const mipW = Math.max(1, width >> (i + 1));
    const mipH = Math.max(1, height >> (i + 1));
    const data = new Float32Array([1.0 / mipW, 1.0 / mipH]);
    device.queue.writeBuffer(blurParamsBuffers[i], 0, data);
    device.queue.writeBuffer(blurParamsBuffers[BLOOM_MIP_COUNT + i], 0, data);
  }

  // Write chromatic aberration params
  const caData = new Float32Array([1.0 / width, 1.0 / height, 2.0, 0.0]);
  device.queue.writeBuffer(caParamsBuffer, 0, caData);

  return {
    bloomThresholdPipeline,
    kawaseDownPipeline,
    kawaseUpPipeline,
    bloomCompositePipeline,
    chromaticPipeline,
    vignettePipeline,
    sampler,
    blurParamsBuffers,
    caParamsBuffer,
    pingTexture,
    pongTexture,
    bloomMips,
    width,
    height,
  };
}

/** Run all post-processing passes. Renders from inputTexture to outputView. */
export function renderPostProcess(
  device: GPUDevice,
  pipeline: PostProcessPipeline,
  inputTexture: GPUTexture,
  outputView: GPUTextureView,
): void {
  const { sampler } = pipeline;

  // Helper: fullscreen draw into a target
  const fullscreenPass = (
    encoder: GPUCommandEncoder,
    renderPipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    target: GPUTextureView,
  ): void => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const encoder = device.createCommandEncoder({ label: "post-process" });

  // ── Pass 1: Bloom ──────────────────────────────

  // 1a. Threshold
  const thresholdBG = device.createBindGroup({
    layout: pipeline.bloomThresholdPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: inputTexture.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  fullscreenPass(
    encoder,
    pipeline.bloomThresholdPipeline,
    thresholdBG,
    pipeline.bloomMips[0].createView(),
  );

  // 1b. Downsample chain
  for (let i = 1; i < BLOOM_MIP_COUNT; i++) {
    const downBG = device.createBindGroup({
      layout: pipeline.kawaseDownPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: pipeline.bloomMips[i - 1].createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: pipeline.blurParamsBuffers[i] } },
      ],
    });
    fullscreenPass(
      encoder,
      pipeline.kawaseDownPipeline,
      downBG,
      pipeline.bloomMips[i].createView(),
    );
  }

  // 1c. Upsample chain
  for (let i = BLOOM_MIP_COUNT - 2; i >= 0; i--) {
    const upBG = device.createBindGroup({
      layout: pipeline.kawaseUpPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: pipeline.bloomMips[i + 1].createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: pipeline.blurParamsBuffers[BLOOM_MIP_COUNT + i] } },
      ],
    });
    fullscreenPass(encoder, pipeline.kawaseUpPipeline, upBG, pipeline.bloomMips[i].createView());
  }

  // 1d. Composite bloom onto original
  const compositeBG = device.createBindGroup({
    layout: pipeline.bloomCompositePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: inputTexture.createView() },
      { binding: 1, resource: pipeline.bloomMips[0].createView() },
      { binding: 2, resource: sampler },
    ],
  });
  fullscreenPass(
    encoder,
    pipeline.bloomCompositePipeline,
    compositeBG,
    pipeline.pingTexture.createView(),
  );

  // ── Pass 2: Chromatic Aberration ───────────────
  const caBG = device.createBindGroup({
    layout: pipeline.chromaticPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: pipeline.pingTexture.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: pipeline.caParamsBuffer } },
    ],
  });
  fullscreenPass(encoder, pipeline.chromaticPipeline, caBG, pipeline.pongTexture.createView());

  // ── Pass 3: Vignette ──────────────────────────
  const vignetteBG = device.createBindGroup({
    layout: pipeline.vignettePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: pipeline.pongTexture.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  fullscreenPass(encoder, pipeline.vignettePipeline, vignetteBG, outputView);

  device.queue.submit([encoder.finish()]);
}

/** Destroy all post-process GPU resources. */
export function destroyPostProcessPipeline(pipeline: PostProcessPipeline): void {
  pipeline.pingTexture.destroy();
  pipeline.pongTexture.destroy();
  for (const mip of pipeline.bloomMips) {
    mip.destroy();
  }
  for (const buf of pipeline.blurParamsBuffers) {
    buf.destroy();
  }
  pipeline.caParamsBuffer.destroy();
}
