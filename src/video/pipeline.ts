/**
 * Decode → process → encode.
 *
 * The core knows nothing about whether it was handed a photo or a frame, which
 * is the whole reason this file is short: it moves frames, and the same
 * rendering path that draws a still draws every one of them.
 */

import type { ParamSet, ParamSource } from "../params.ts";
import { GpuPipeline, gpuSupports, textArtFor } from "../render/gpu.ts";
import { FONT_STACK, sourceSize } from "../render/image.ts";
import type { StillPipeline } from "../render/image.ts";
import type { TextSource } from "../text.ts";
import {
  canDecode,
  decodeFrames,
  decodeFramesViaElement,
  inspect,
} from "./decode.ts";
import { audioSurvives, chooseEncoding, VideoExporter, type Container } from "./encode.ts";

export interface ExportProgress {
  frame: number;
  total: number;
  container: Container;
  audioKept: boolean;
}

export interface ExportResult {
  blob: Blob;
  container: Container;
  frames: number;
  /**
   * How many frames the container said the track held.
   *
   * Returned beside the count actually encoded so the caller can tell the user
   * when an export came up short. A truncated file that reports success is the
   * worst outcome here: the export is the expensive step, and a shortfall is
   * only obvious once the file is played somewhere else.
   */
  expectedFrames: number;
  audioKept: boolean;
  /** True when WebCodecs refused the stream and the element fallback ran. */
  usedFallback: boolean;
}

/**
 * Which path renders a given set. Error diffusion is sequential and cannot be a
 * fragment shader, so it stays on the CPU — the app picks, the user never does,
 * and the choice is shown rather than hidden.
 */
export function pathFor(params: ParamSet, clusters?: readonly string[]): "gpu" | "cpu" {
  if (!gpuSupports(params.algorithm)) return "cpu";
  if (params.text === "off") return "gpu";
  // Braille has no GPU path yet. 256 patterns is exactly a 16×16 atlas, so it
  // is nearly free to add — but it is not added, and routing it to a shader
  // that cannot draw it would render nothing.
  if (params.text === "braille") return "cpu";
  // The glow is a Canvas 2D shadow. Blooming on the GPU means a second render
  // target and a separable blur over the finished frame, not a wider atlas
  // sample — an in-shader blur reads across the atlas and bleeds neighbouring
  // glyphs into each other. Until that exists the honest move is the one
  // braille already makes: send it to the path that can actually draw it.
  if (params.glow > 0) return "cpu";
  // Text art runs on the GPU through the glyph atlas, which addresses cells
  // with one byte. Past that the Canvas 2D path takes over — it has no atlas
  // and therefore no ceiling.
  return clusters !== undefined && GpuPipeline.canDrawText(clusters) ? "gpu" : "cpu";
}

/**
 * Renders every frame offline and returns the finished file.
 *
 * `t` comes from the frame index, never from an accumulating clock, so the same
 * three seconds render identically every time — which is what makes the export
 * reproducible and, in Phase 2, what keeps it in sync with the beat grid.
 */
/**
 * Names the stage that failed. WebCodecs reports almost everything as a bare
 * `NotSupportedError` — "Operation is not supported" — which says nothing about
 * whether the decoder, the encoder or the muxer refused, or with what settings.
 */
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${reason}`);
  }
}

export async function exportVideo(options: {
  file: File;
  params: ParamSource;
  text: TextSource;
  cpu: StillPipeline;
  gpu: GpuPipeline;
  bitrate: number;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}): Promise<ExportResult> {
  const { file, params, text, cpu, gpu, bitrate, onProgress, signal } = options;
  const { source, mp4 } = await stage("reading the video", () => inspect(file));

  // The first decoded frame is the authority on dimensions, so the encoder
  // cannot be built until one arrives. The track header is not that authority:
  // it disagrees with the bitstream on any file carrying a rotation matrix — a
  // portrait phone clip reports 1080×1920 over a 1920×1080 stream — and sizing
  // the encoder from it re-encodes every frame into the wrong shape. The
  // orientation is not lost, it is carried to the muxer as a rotation instead.
  interface Ready {
    exporter: VideoExporter;
    container: Container;
    audioKept: boolean;
    outW: number;
    outH: number;
  }
  // A holder rather than a bare `let`: the assignment happens inside the frame
  // callback, which the checker cannot see, so a plain local narrows to null
  // for the rest of the function and the finish below becomes unreachable.
  const state: { ready: Ready | null } = { ready: null };

  const scratch = document.createElement("canvas");
  // The CPU path sizes its own output from the frame it was handed, which is
  // the same frame the encoder was configured from — but `evenDimension` may
  // have taken a pixel off. Cropping closes that gap; scaling would resample a
  // dithered image and destroy the pattern that is the whole point.
  const fitted = document.createElement("canvas");
  let frames = 0;

  // WebCodecs first; the element fallback exists because Chrome will not open
  // 10-bit HEVC in `VideoDecoder` even though it plays it perfectly well.
  const webCodecs = await canDecode(source);

  /**
   * One frame handler for both decode paths. A `VideoFrame` owns memory and
   * must be closed; the fallback's `<video>` element is reused for every frame
   * and must not be.
   */
  const onFrame = async (
    frame: VideoFrame | HTMLVideoElement,
    index: number,
    // The element path knows the real media time; WebCodecs derives it from the
    // frame index, which cannot drift because it never accumulates.
    mediaTime = index / source.fps,
  ) => {
    try {
      if (signal?.aborted) return;

      if (!state.ready) {
        // Sized from the frame itself, never from the header. Both frame kinds
        // report their size through a different property — see `sourceSize`.
        const { w, h } = sourceSize(frame);
        const encoding = await stage("choosing an encoder", () =>
          chooseEncoding(w, h, source.fps, bitrate),
        );
        state.ready = {
          exporter: new VideoExporter({
            encoding,
            fps: source.fps,
            audio: source.audio,
            rotation: source.rotation,
          }),
          container: encoding.container,
          audioKept: audioSurvives(encoding.container, source.audio),
          outW: encoding.config.width,
          outH: encoding.config.height,
        };
      }
      const { exporter, container, audioKept, outW, outH } = state.ready;

      const resolved = params.resolve(mediaTime);

      let painted: CanvasImageSource;
      if (pathFor(resolved, text.at(mediaTime).clusters) === "gpu") {
        const cols = Math.max(1, Math.round(outW / resolved.pixelSize));
        const rows = Math.max(1, Math.round(outH / (resolved.pixelSize * resolved.cellAspect)));
        const art = textArtFor(resolved, text, FONT_STACK[resolved.textFont], cols, rows);
        gpu.render(frame, outW, outH, resolved, art ?? undefined, mediaTime);
        painted = gpu.canvas;
      } else {
        cpu.render(frame, resolved, text, scratch, 1, mediaTime);
        painted = scratch;
        // A frame that is not exactly the configured size is not a frame the
        // encoder will take unchanged: it silently rescales, which is the
        // export coming back a different shape than it went in.
        if (scratch.width !== outW || scratch.height !== outH) {
          if (fitted.width !== outW || fitted.height !== outH) {
            fitted.width = outW;
            fitted.height = outH;
          }
          const fctx = fitted.getContext("2d");
          if (fctx) {
            fctx.clearRect(0, 0, outW, outH);
            fctx.drawImage(scratch, 0, 0, outW, outH, 0, 0, outW, outH);
            painted = fitted;
          }
        }
      }

      await exporter.addFrame(painted, index, mediaTime);
      frames++;
      onProgress?.({ frame: index + 1, total: source.frameCount, container, audioKept });
    } finally {
      if ("close" in frame) frame.close();
    }
  };

  await stage(`decoding ${source.codec}`, () =>
    webCodecs
      ? decodeFrames(mp4, source, onFrame, signal)
      : decodeFramesViaElement(file, onFrame, signal),
  );

  // Nothing readied means no frame ever arrived. Finishing a file that was
  // never started would hand back an empty blob and call it a success.
  if (!state.ready) {
    throw new Error(`decoding ${source.codec}: the file decoded to no frames at all`);
  }
  const { exporter, container, audioKept } = state.ready;

  const blob = await stage("writing the file", () => exporter.finish());
  return {
    blob,
    container,
    frames,
    expectedFrames: source.frameCount,
    audioKept,
    usedFallback: !webCodecs,
  };
}
