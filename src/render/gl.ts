/**
 * Minimal WebGL2 helper: compile a fragment shader, run it over a full-screen
 * triangle, upload textures.
 *
 * No framework, and none needed. We are filtering a flat texture, not drawing a
 * scene, so there is no scene graph, no camera, and no vertex data — the
 * triangle is generated from `gl_VertexID`, which is why nothing here binds a
 * buffer.
 */

/** Covers the viewport with one oversized triangle. Cheaper than a quad and no seam down the diagonal. */
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

export type Uniforms = Record<string, number | number[] | boolean>;

export class GlSurface {
  readonly gl: WebGL2RenderingContext;
  private locations = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // Read back exactly what was drawn: no premultiply, no colour management,
      // no browser compositing in between. Parity with the CPU path depends on
      // every one of these.
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      colorSpace: "srgb",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
  }

  program(fragment: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("could not create shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    this.locations.set(program, new Map());

    // Samplers must be set with uniform1i; routing them through the generic
    // uniform path below would set a float and raise INVALID_OPERATION.
    gl.useProgram(program);
    ["uSource", "uMask", "uAtlas", "uCells", "uWordEnd"].forEach((name, unit) => {
      const location = gl.getUniformLocation(program, name);
      if (location) gl.uniform1i(location, unit);
    });
    return program;
  }

  private location(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const cache = this.locations.get(program);
    if (cache?.has(name)) return cache.get(name) ?? null;

    // Array uniforms answer to `name[0]`, not `name`, on some drivers — and
    // this returned null there, which the caller skipped in silence. The array
    // then stayed at its zero-initialized value, which for a lookup table means
    // every fragment reads entry 0 and the whole frame draws one glyph.
    const found =
      this.gl.getUniformLocation(program, name) ??
      this.gl.getUniformLocation(program, `${name}[0]`);
    cache?.set(name, found);
    return found;
  }

  /**
   * `mipmapped` is what makes GPU pixelization area-average instead of point
   * sampling. A snapped UV read at LOD 0 takes one texel out of each block, so
   * anything that moves between frames flickers between neighbouring texels —
   * crawl. Sampling the mip level that matches the block size averages the
   * block instead, which is both stable in video and the same operation the
   * CPU path's area downsample performs.
   */
  texture(
    source: TexImageSource,
    mipmapped: boolean,
    repeat = false,
    existing?: WebGLTexture | null,
  ): WebGLTexture {
    const gl = this.gl;
    // Reused across frames when the caller keeps one. `texImage2D` reallocates
    // the storage itself, so a clip that changes size mid-stream needs no
    // special case — but a video holds its size, and creating and destroying a
    // texture object for every frame asks the driver for an allocation the
    // upload was going to overwrite anyway.
    const texture = existing ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (mipmapped) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    }
    return texture;
  }

  /** Single-channel 8-bit data: the blue-noise mask, and flow's cell indices. */
  maskTexture(
    data: Uint8Array,
    width: number,
    height = width,
    repeat = true,
    existing?: WebGLTexture | null,
  ): WebGLTexture {
    const gl = this.gl;
    const texture = existing ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  draw(program: WebGLProgram, textures: WebGLTexture[], uniforms: Uniforms): void {
    const gl = this.gl;
    gl.useProgram(program);
    textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });

    for (const [name, value] of Object.entries(uniforms)) {
      const location = this.location(program, name);
      if (location === null) continue;
      if (typeof value === "boolean") gl.uniform1i(location, value ? 1 : 0);
      else if (typeof value === "number") {
        if (Number.isInteger(value) && name.startsWith("i")) gl.uniform1i(location, value);
        else gl.uniform1f(location, value);
      } else if (value.length === 2) gl.uniform2f(location, value[0]!, value[1]!);
      else if (value.length === 3) gl.uniform3f(location, value[0]!, value[1]!, value[2]!);
      // Anything longer is a uniform array — the ramp's rank-to-atlas table.
      // Falling off the end of this chain uploads nothing, silently, and the
      // array keeps its zero-initialized value: every fragment then reads
      // entry 0 and the frame draws one glyph everywhere.
      else gl.uniform1fv(location, value);
    }

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Rows come back bottom-up from GL; this returns them top-down like `ImageData`. */
  readPixels(width: number, height: number): Uint8ClampedArray {
    const gl = this.gl;
    const flipped = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);

    const out = new Uint8ClampedArray(width * height * 4);
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      out.set(flipped.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }
    return out;
  }
}
