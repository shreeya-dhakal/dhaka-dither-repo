/**
 * Encode processed frames and mux them back into a file.
 *
 * MP4/H.264 first, WebM/VP9 as the fallback. The audio track rides along: on
 * MP4 it is passed through untouched, which is both lossless and free. Never
 * export a silent video and expect the user to recombine it.
 */

import { ArrayBufferTarget, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import type { AudioTrack } from "./decode.ts";

export type Container = "mp4" | "webm";

export interface EncodeOptions {
  encoding: Encoding;
  fps: number;
  audio: AudioTrack | null;
  /**
   * The source's own rotation, written straight back out. Frames are encoded
   * the way they decode — upright in the bitstream — so dropping this turns a
   * portrait recording on its side, which reads to the user as the export
   * changing the size of their video.
   */
  rotation?: 0 | 90 | 180 | 270;
}

/** Baseline profile, level 3.1 — the widest-playing H.264 configuration. */
const H264 = "avc1.42001f";
const VP9 = "vp09.00.10.08";

/**
 * H.264 requires even dimensions, and mp4box reports track size from a 16.16
 * fixed-point field that is not always a whole number. An odd or fractional
 * width reaches `configure()` as an unsupported configuration, which throws
 * `NotSupportedError` — a message that says nothing about which number was
 * wrong.
 */
export function evenDimension(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export interface Encoding {
  container: Container;
  config: VideoEncoderConfig;
}

/**
 * Probes the **exact** configuration that will be used, not an approximation of
 * it. Checking one config and then configuring with another — a different
 * bitrate, a missing `avc.format`, no framerate — is how a supported probe
 * still throws at `configure()`.
 */
export async function chooseEncoding(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<Encoding> {
  const w = evenDimension(width);
  const h = evenDimension(height);
  const framerate = Number.isFinite(fps) && fps > 0 ? fps : 30;

  const candidates: Encoding[] = [
    {
      container: "mp4",
      config: { codec: H264, width: w, height: h, bitrate, framerate, avc: { format: "avc" } },
    },
    { container: "webm", config: { codec: VP9, width: w, height: h, bitrate, framerate } },
    { container: "webm", config: { codec: "vp8", width: w, height: h, bitrate, framerate } },
  ];

  const tried: string[] = [];
  for (const candidate of candidates) {
    const support = await VideoEncoder.isConfigSupported(candidate.config).catch(() => null);
    if (support?.supported) return candidate;
    tried.push(candidate.config.codec);
  }
  throw new Error(
    `this browser cannot encode ${w}×${h} video — tried ${tried.join(", ")}`,
  );
}

/**
 * Audio pass-through is MP4-only, and that is a codec fact rather than a
 * shortcut: the source track is AAC, and AAC cannot go into a WebM container.
 * A WebM export would have to re-encode to Opus, so rather than silently
 * dropping the sound the caller is told what happened.
 */
export function audioSurvives(container: Container, audio: AudioTrack | null): boolean {
  return (
    audio !== null &&
    container === "mp4" &&
    audio.codec.startsWith("mp4a") &&
    // No decoder config, no pass-through. The muxer needs it to write the track
    // and throws from deep inside `finalize()` without it, which cost the user a
    // whole export to learn. Reporting the sound as dropped hands back a working
    // file and a sentence explaining it — the export is the part they cannot
    // redo cheaply.
    audio.description !== null
  );
}

export class VideoExporter {
  private muxer: Mp4Muxer<ArrayBufferTarget> | WebmMuxer<WebmTarget>;
  private encoder: VideoEncoder;
  private options: EncodeOptions;
  private failure: Error | null = null;

  constructor(options: EncodeOptions) {
    this.options = options;
    const { encoding, fps, audio, rotation = 0 } = options;
    const { container, config } = encoding;
    const width = config.width;
    const height = config.height;
    const keepAudio = audioSurvives(container, audio);

    if (container === "mp4") {
      this.muxer = new Mp4Muxer({
        target: new ArrayBufferTarget(),
        // `rotation` goes in the track header, not the bitstream — the frames
        // handed to the encoder are already the way the decoder produced them.
        video: { codec: "avc", width, height, ...(rotation ? { rotation } : {}) },
        ...(keepAudio && audio
          ? {
              audio: {
                codec: "aac",
                numberOfChannels: audio.channels,
                sampleRate: audio.sampleRate,
              },
            }
          : {}),
        fastStart: "in-memory",
      });
    } else {
      this.muxer = new WebmMuxer({
        target: new WebmTarget(),
        video: { codec: "V_VP9", width, height, frameRate: fps },
      });
    }

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        (this.muxer as Mp4Muxer<ArrayBufferTarget>).addVideoChunk(chunk, meta);
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
      },
    });

    try {
      // Exactly the config that was probed, so a successful probe means this
      // cannot throw for reasons the probe would have caught.
      this.encoder.configure(config);
    } catch (error) {
      throw new Error(
        `video encoder (${config.codec} at ${width}×${height}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `index` rather than a running clock: timestamps derive from the frame
   * number so float drift cannot accumulate across a long export and break
   * byte-identical rendering.
   */
  async addFrame(source: CanvasImageSource, index: number, mediaTime?: number): Promise<void> {
    if (this.failure) throw this.failure;
    // A supplied media time wins: the element path can miss a frame, and timing
    // the output by its own counter would then run the whole clip fast.
    const micros =
      mediaTime === undefined
        ? Math.round((index * 1e6) / this.options.fps)
        : Math.round(mediaTime * 1e6);
    const frame = new VideoFrame(source, {
      timestamp: micros,
      duration: Math.round(1e6 / this.options.fps),
    });
    this.encoder.encode(frame, { keyFrame: index % Math.round(this.options.fps * 2) === 0 });
    frame.close();
    if (this.encoder.encodeQueueSize > 8) await this.encoder.flush();
  }

  async finish(): Promise<Blob> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.failure) throw this.failure;

    const { audio } = this.options;
    const container = this.options.encoding.container;
    if (audioSurvives(container, audio) && audio) {
      const muxer = this.muxer as Mp4Muxer<ArrayBufferTarget>;
      for (const sample of audio.samples) {
        if (!sample.data) continue;
        muxer.addAudioChunkRaw(
          sample.data,
          sample.is_sync ? "key" : "delta",
          Math.round((sample.cts * 1e6) / audio.timescale),
          Math.round((sample.duration * 1e6) / audio.timescale),
          // The muxer only reads `description` off this, but the DOM type
          // insists on a full AudioDecoderConfig, so the rest is filled in from
          // the track we are passing through.
          audio.description
            ? {
                decoderConfig: {
                  codec: audio.codec,
                  numberOfChannels: audio.channels,
                  sampleRate: audio.sampleRate,
                  description: audio.description,
                },
              }
            : undefined,
        );
      }
    }

    this.muxer.finalize();
    const { buffer } = this.muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: container === "mp4" ? "video/mp4" : "video/webm" });
  }
}
