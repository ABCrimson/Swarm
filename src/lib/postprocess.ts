// ── Post-Processing Pipeline ─────────────────────────
// Bloom (threshold + dual Kawase blur + composite), chromatic aberration
// and vignette over the particle scene, chained through ping-pong
// textures. Every texture view and bind group is built once per pipeline
// (per canvas size); a frame only encodes passes.

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

/** Radial chromatic-aberration strength (distortion = dist² × intensity). */
const CA_INTENSITY = 2.0;

/** Bind groups that sample the scene texture, rebuilt only when that texture changes. */
interface InputBindGroups {
  readonly input: GPUTexture;
  readonly threshold: GPUBindGroup;
  readonly composite: GPUBindGroup;
}

/**
 * GPU resources for the post-processing chain at one canvas size. Treat
 * it as opaque: create it with {@link createPostProcessPipeline}, draw
 * with {@link renderPostProcess}, release it with
 * {@link destroyPostProcessPipeline}.
 */
export interface PostProcessPipeline {
  readonly width: number;
  readonly height: number;
  /** Bind groups for a scene texture (cached per texture). */
  readonly inputBindGroups: (input: GPUTexture) => InputBindGroups;
  readonly passes: {
    readonly threshold: GPURenderPipeline;
    readonly down: GPURenderPipeline;
    readonly up: GPURenderPipeline;
    readonly composite: GPURenderPipeline;
    readonly chromatic: GPURenderPipeline;
    readonly vignette: GPURenderPipeline;
  };
  /** Bloom mip views (index 0 = half resolution). */
  readonly mipViews: readonly GPUTextureView[];
  /** Down pass k reads mip k into mip k + 1. */
  readonly downBindGroups: readonly GPUBindGroup[];
  /** Up pass i reads mip i + 1 into mip i. */
  readonly upBindGroups: readonly GPUBindGroup[];
  readonly pingView: GPUTextureView;
  readonly pongView: GPUTextureView;
  readonly chromaticBindGroup: GPUBindGroup;
  readonly vignetteBindGroup: GPUBindGroup;
  /** Everything {@link destroyPostProcessPipeline} releases. */
  readonly owned: readonly (GPUTexture | GPUBuffer)[];
}

/** Indexes a list the caller has just sized; throws instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`post-process index ${index} out of range`);
  return item;
}

/**
 * Creates the post-processing chain for a `width` × `height` scene: its
 * six pipelines (compiled concurrently, sharing one vertex module), the
 * ping-pong and bloom-mip textures, uniforms, views and bind groups.
 */
export async function createPostProcessPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  width: number,
  height: number,
): Promise<PostProcessPipeline> {
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const vertexModule = device.createShaderModule({
    label: "fullscreen-vertex",
    code: FULLSCREEN_VERTEX_WGSL,
  });

  const texture = (w: number, h: number, label: string): GPUTexture =>
    device.createTexture({
      label,
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  const uniform = (data: Float32Array<ArrayBuffer>, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      // Uniform buffers are allocated in 16-byte steps.
      size: Math.ceil(data.byteLength / 16) * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };

  // ── Layouts ────────────────────────────────────
  const fragment = GPUShaderStage.FRAGMENT;
  const texSamplerLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: fragment, texture: {} },
      { binding: 1, visibility: fragment, sampler: {} },
    ],
  });
  const texSamplerUniformLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: fragment, texture: {} },
      { binding: 1, visibility: fragment, sampler: {} },
      { binding: 2, visibility: fragment, buffer: { type: "uniform" } },
    ],
  });
  const compositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: fragment, texture: {} },
      { binding: 1, visibility: fragment, texture: {} },
      { binding: 2, visibility: fragment, sampler: {} },
    ],
  });

  // Single-entry-point modules: the entry points are implied.
  const fullscreenPipeline = (
    label: string,
    code: string,
    layout: GPUBindGroupLayout,
  ): Promise<GPURenderPipeline> =>
    device.createRenderPipelineAsync({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: vertexModule },
      fragment: { module: device.createShaderModule({ label, code }), targets: [{ format }] },
    });

  const [threshold, down, up, composite, chromatic, vignette] = await Promise.all([
    fullscreenPipeline("bloom-threshold", BLOOM_THRESHOLD_WGSL, texSamplerLayout),
    fullscreenPipeline("kawase-down", KAWASE_DOWN_WGSL, texSamplerUniformLayout),
    fullscreenPipeline("kawase-up", KAWASE_UP_WGSL, texSamplerUniformLayout),
    fullscreenPipeline("bloom-composite", BLOOM_COMPOSITE_WGSL, compositeLayout),
    fullscreenPipeline("chromatic-aberration", CHROMATIC_ABERRATION_WGSL, texSamplerUniformLayout),
    fullscreenPipeline("vignette", VIGNETTE_WGSL, texSamplerLayout),
  ]);

  // ── Textures, views, uniforms ──────────────────
  const ping = texture(width, height, "ping");
  const pong = texture(width, height, "pong");
  const mips = Array.from({ length: BLOOM_MIP_COUNT }, (_, i) =>
    texture(width >> (i + 1), height >> (i + 1), `bloom-mip-${i}`),
  );
  const mipViews = mips.map((mip) => mip.createView());
  // One texel-size uniform per mip: the pass that writes mip i samples
  // with mip i's texel size, going down and coming back up alike.
  const texelBuffers = mips.map((mip, i) =>
    uniform(Float32Array.of(1 / mip.width, 1 / mip.height), `bloom-texel-${i}`),
  );
  const caBuffer = uniform(Float32Array.of(CA_INTENSITY), "chromatic-params");
  const pingView = ping.createView();
  const pongView = pong.createView();

  const blurBindGroup = (source: GPUTextureView, texel: GPUBuffer): GPUBindGroup =>
    device.createBindGroup({
      layout: texSamplerUniformLayout,
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: texel } },
      ],
    });

  const downBindGroups = mipViews
    .slice(1)
    .map((_, k) => blurBindGroup(at(mipViews, k), at(texelBuffers, k + 1)));
  const upBindGroups = mipViews
    .slice(1)
    .map((_, i) => blurBindGroup(at(mipViews, i + 1), at(texelBuffers, i)));

  const chromaticBindGroup = device.createBindGroup({
    layout: texSamplerUniformLayout,
    entries: [
      { binding: 0, resource: pingView },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: caBuffer } },
    ],
  });
  const vignetteBindGroup = device.createBindGroup({
    layout: texSamplerLayout,
    entries: [
      { binding: 0, resource: pongView },
      { binding: 1, resource: sampler },
    ],
  });

  let cached: InputBindGroups | null = null;
  const inputBindGroups = (input: GPUTexture): InputBindGroups => {
    if (cached?.input === input) return cached;
    const inputView = input.createView();
    cached = {
      input,
      threshold: device.createBindGroup({
        layout: texSamplerLayout,
        entries: [
          { binding: 0, resource: inputView },
          { binding: 1, resource: sampler },
        ],
      }),
      composite: device.createBindGroup({
        layout: compositeLayout,
        entries: [
          { binding: 0, resource: inputView },
          { binding: 1, resource: at(mipViews, 0) },
          { binding: 2, resource: sampler },
        ],
      }),
    };
    return cached;
  };

  return {
    width,
    height,
    inputBindGroups,
    passes: { threshold, down, up, composite, chromatic, vignette },
    mipViews,
    downBindGroups,
    upBindGroups,
    pingView,
    pongView,
    chromaticBindGroup,
    vignetteBindGroup,
    owned: [ping, pong, ...mips, ...texelBuffers, caBuffer],
  };
}

/**
 * Encodes and submits the whole chain, reading the scene from
 * `inputTexture` and writing the final image to `outputView` — the only
 * per-frame resource (normally the canvas's current texture). The scene
 * texture's bind groups are built on first use and reused while the same
 * texture comes back.
 */
export function renderPostProcess(
  device: GPUDevice,
  pipeline: PostProcessPipeline,
  inputTexture: GPUTexture,
  outputView: GPUTextureView,
): void {
  const encoder = device.createCommandEncoder({ label: "post-process" });
  const draw = (
    renderPipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    target: GPUTextureView,
  ): void => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const { passes, mipViews } = pipeline;
  const input = pipeline.inputBindGroups(inputTexture);

  // Bloom: bright-pass into mip 0, blur down the chain and back up, then
  // add it onto the scene.
  draw(passes.threshold, input.threshold, at(mipViews, 0));
  pipeline.downBindGroups.forEach((bindGroup, k) => {
    draw(passes.down, bindGroup, at(mipViews, k + 1));
  });
  for (let i = pipeline.upBindGroups.length - 1; i >= 0; i--) {
    draw(passes.up, at(pipeline.upBindGroups, i), at(mipViews, i));
  }
  draw(passes.composite, input.composite, pipeline.pingView);

  draw(passes.chromatic, pipeline.chromaticBindGroup, pipeline.pongView);
  draw(passes.vignette, pipeline.vignetteBindGroup, outputView);

  device.queue.submit([encoder.finish()]);
}

/** Destroys every texture and buffer the pipeline owns. */
export function destroyPostProcessPipeline(pipeline: PostProcessPipeline): void {
  for (const resource of pipeline.owned) resource.destroy();
}
