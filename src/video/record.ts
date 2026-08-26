/**
 * Rendered frames → a file, for the two things that produce frames without a
 * source video to decode: a live camera, and a still under an animation.
 *
 * Both are the same problem — a canvas that keeps changing and a clock — so
 * both go through one sink. The sink has two implementations because the two
 * output formats want opposite things: a video encoder wants a fixed frame rate
 * and gets timestamps, while a GIF stores a delay *per frame* and so can carry
 * a variable rate exactly as it happened. Neither is emulated in terms of the
 * other; each is asked for what it is good at.
 *
 * `src/video/pipeline.ts` remains the path for a decoded file. This is not a
 * second copy of it: that one owns decoding and audio pass-through, which
 * neither of these has any of.
 */

import { delayFor, GifWriter, MIN_DELAY_CS } from "./gif.ts";
import { chooseEncoding, evenDimension, VideoExporter, type Container } from "./encode.ts";

/** What the user picks. The video path then chooses mp4 or webm on its own. */
export type RecordFormat = "video" | "gif";

export interface RecordResult {
  blob: Blob;
  /** `mp4`, `webm`, or `gif` — the actual container, which for video is negotiated. */
  container: Container | "gif";
  frames: number;
  /** Seconds of footage, from the timestamps rather than from the frame count. */
  duration: number;
  /**
   * What a GIF really plays at, once its delays have been rounded to
   * centiseconds. Null for video, which keeps the rate it was given.
   */
  gifFps: number | null;
  /** True when a GIF frame needed more than 256 colours and had to approximate. */
  approximated: boolean;
  /** True when recording stopped early because the file hit its size ceiling. */
  hitLimit: boolean;
}

export interface RecordOptions {
  format: RecordFormat;
  /** The locked output size. Every frame is fitted to it — see `fit`. */
  width: number;
  height: number;
  /** Nominal rate, for the encoder's configuration and keyframe spacing. */
  fps: number;
  bitrate?: number;
  /**
   * GIF only: frames arriving faster than this are dropped rather than written.
   * A GIF at 60 fps is four times the bytes of one at 15 for motion the format
   * cannot represent anyway — its delays are whole centiseconds.
   */
  gifFps?: number;
  /**
   * Stop and hand back what exists rather than build a file the browser cannot
   * hold. Reached in practice only by GIF, which is uncompressed-ish by modern
   * standards and has no temporal compression at all.
   */
  maxBytes?: number;
}

const DEFAULT_BITRATE = 5_000_000;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;

/**
 * Draws a frame into the locked output size **without resampling**.
 *
 * This tool's whole output is a pattern of hard-edged marks on a lattice.
 * Scaling that to fit resamples it, and a resampled dither is not a smaller
 * version of the picture — it is a different, worse picture with moiré in it.
 * So a frame that does not match is cropped or padded at 1:1 instead, which is
 * the same choice `exportVideo` makes for the same reason.
 *
 * In practice this almost never fires: the renderer sizes its target from the
 * source, and neither a camera nor a still changes size mid-recording. It is
 * here so that the one time something does, the encoder is handed the size it
 * was configured with rather than throwing halfway through a take.
 */
function fit(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): void {
  if (source.width === target.width && source.height === target.height) {
    ctx.drawImage(source, 0, 0);
    return;
  }
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.imageSmoothingEnabled = false;
  const w = Math.min(source.width, target.width);
  const h = Math.min(source.height, target.height);
  ctx.drawImage(source, 0, 0, w, h, 0, 0, w, h);
}

interface Sink {
  /** `time` is seconds since recording began. Returns false when the sink is full. */
  add(frame: HTMLCanvasElement, time: number): Promise<boolean>;
  finish(): Promise<{ blob: Blob; container: Container | "gif"; frames: number }>;
  /**
   * Frames actually **written**, which is not the number offered: the GIF sink
   * drops anything arriving faster than its target rate. A progress read-out
   * counting offers would tell the user a 15 fps GIF was gaining 60 frames a
   * second.
   */
  readonly written: number;
  readonly approximated: boolean;
  readonly gifFps: number | null;
}

class VideoSink implements Sink {
  private exporter: VideoExporter;
  private container: Container;
  private frames = 0;
  /**
   * A frame budget rather than a byte one. The muxer buffers in memory and
   * exposes no running size, so there is nothing to weigh mid-take — but the
   * encoder was configured with a bitrate, and bytes ÷ bytes-per-frame is the
   * frame count that bitrate implies. It is an estimate, and it only has to be
   * good enough to stop a take before the tab runs out of memory.
   */
  private frameBudget: number;
  readonly approximated = false;
  readonly gifFps = null;

  private constructor(
    exporter: VideoExporter,
    container: Container,
    maxBytes: number,
    bitrate: number,
    fps: number,
  ) {
    this.exporter = exporter;
    this.container = container;
    const bytesPerFrame = bitrate / 8 / Math.max(1, fps);
    this.frameBudget = Math.max(1, Math.floor(maxBytes / bytesPerFrame));
  }

  get written(): number {
    return this.frames;
  }

  static async create(options: RecordOptions): Promise<VideoSink> {
    const encoding = await chooseEncoding(
      options.width,
      options.height,
      options.fps,
      options.bitrate ?? DEFAULT_BITRATE,
    );
    return new VideoSink(
      // No audio: neither a camera recording nor an animated still has a track
      // to pass through, and encoding a microphone the user was never asked for
      // would be a surprise of the worst kind.
      new VideoExporter({ encoding, fps: options.fps, audio: null }),
      encoding.container,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      options.bitrate ?? DEFAULT_BITRATE,
      options.fps,
    );
  }

  async add(frame: HTMLCanvasElement, time: number): Promise<boolean> {
    await this.exporter.addFrame(frame, this.frames, time);
    this.frames++;
    return this.frames < this.frameBudget;
  }

  async finish(): Promise<{ blob: Blob; container: Container; frames: number }> {
    return { blob: await this.exporter.finish(), container: this.container, frames: this.frames };
  }
}

class GifSink implements Sink {
  private writer: GifWriter;
  private scratch: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private maxBytes: number;
  private minGap: number;
  /**
   * One frame is held back, because a GIF frame carries the delay *before the
   * next one* and that is not known until the next one arrives. Writing each
   * frame on arrival with the gap that preceded it would shift the whole
   * animation by a frame and give the first one a delay it never had.
   */
  private pending: { pixels: Uint8ClampedArray; time: number } | null = null;
  private frames = 0;
  private full = false;
  readonly gifFps: number;

  constructor(options: RecordOptions) {
    this.writer = new GifWriter({ width: options.width, height: options.height });
    this.scratch = document.createElement("canvas");
    this.scratch.width = options.width;
    this.scratch.height = options.height;
    const ctx = this.scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("could not get a 2D context for the GIF frames");
    this.ctx = ctx;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const target = options.gifFps ?? 12.5;
    this.gifFps = delayFor(target).actualFps;
    // A little under the nominal gap, so a frame that arrives a millisecond
    // early is kept rather than dropped — the drop would halve the rate.
    this.minGap = (1 / target) * 0.9;
  }

  get approximated(): boolean {
    return this.writer.approximated;
  }

  get written(): number {
    return this.frames;
  }

  async add(frame: HTMLCanvasElement, time: number): Promise<boolean> {
    if (this.full) return false;
    if (this.pending && time - this.pending.time < this.minGap) return true;

    fit(frame, this.scratch, this.ctx);
    const pixels = this.ctx.getImageData(0, 0, this.scratch.width, this.scratch.height).data;

    if (this.pending) this.write(this.pending, time - this.pending.time);
    this.pending = { pixels, time };

    if (this.writer.size >= this.maxBytes) {
      this.full = true;
      return false;
    }
    return true;
  }

  private write(frame: { pixels: Uint8ClampedArray; time: number }, gap: number): void {
    const delayCs = Math.max(MIN_DELAY_CS, Math.round(gap * 100));
    this.writer.addFrame(frame.pixels, delayCs);
    this.frames++;
  }

  async finish(): Promise<{ blob: Blob; container: "gif"; frames: number }> {
    // The held frame goes out with the nominal delay: there is no next arrival
    // to measure against, and a last frame with no delay flashes past.
    if (this.pending) this.write(this.pending, 1 / this.gifFps);
    this.pending = null;
    const bytes = this.writer.finish();
    return {
      // A fresh copy, because a Blob over a view into the writer's buffer would
      // alias memory the writer still owns.
      blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/gif" }),
      container: "gif",
      frames: this.frames,
    };
  }

}

/**
 * Collects rendered frames and hands back a file.
 *
 * The caller drives it: there is no internal timer and no `captureStream`.
 * Both would record whatever the browser happened to composite, at whatever
 * rate it felt like, which for a canvas this app repaints on demand means
 * duplicated and dropped frames. Being pushed one frame at a time is what makes
 * an offline animation export byte-reproducible and a live take honest about
 * its own timing.
 */
export class Recorder {
  private sink: Sink;
  private lastTime = 0;
  private stopped = false;
  private hitLimit = false;
  /**
   * The clock reading of the **first frame**, subtracted from every one after
   * it so a take starts at exactly zero.
   *
   * Not cosmetic. A live take begins when the first camera frame arrives, not
   * when the button was pressed, and the gap between the two — the tens of
   * milliseconds the camera takes to present a frame — is dead air that should
   * not be in the file. `mp4-muxer` is stricter still: it rejects a track whose
   * first chunk has any timestamp other than zero, so a recording that carried
   * the press-to-frame gap failed at the muxer with a message about
   * `MediaStreamTrack` timestamps and lost the whole take.
   */
  private origin: number | null = null;
  /**
   * The tail of the frame queue. Every `addFrame` chains onto it and `finish`
   * awaits it.
   *
   * Without this the stop button is a race: the caller feeds frames from a
   * `requestVideoFrameCallback` without awaiting them, so pressing stop while
   * one is still in flight calls `flush()` and then `close()` on a
   * `VideoEncoder` that another task is mid-`encode` on. The failure is a
   * closed-codec exception thrown from inside the finish, which loses the whole
   * take — and it only happens on the timing where a frame and the button land
   * together, which is to say rarely and unreproducibly.
   */
  private queue: Promise<unknown> = Promise.resolve();
  readonly format: RecordFormat;

  private constructor(sink: Sink, format: RecordFormat) {
    this.sink = sink;
    this.format = format;
  }

  static async start(options: RecordOptions): Promise<Recorder> {
    // Even dimensions are an H.264 requirement, and a GIF is sized the same way
    // only so that a take exported both ways is the same picture.
    const locked: RecordOptions = {
      ...options,
      width: evenDimension(options.width),
      height: evenDimension(options.height),
    };
    const sink =
      options.format === "gif" ? new GifSink(locked) : await VideoSink.create(locked);
    return new Recorder(sink, options.format);
  }

  /** Frames written so far, for a progress read-out. */
  get frameCount(): number {
    return this.sink.written;
  }

  get seconds(): number {
    return this.lastTime;
  }

  /**
   * Returns false once the sink is full, which the caller should treat as "stop
   * now" rather than as an error — the frames already taken are still a file.
   */
  async addFrame(frame: HTMLCanvasElement, time: number): Promise<boolean> {
    if (this.stopped) return false;
    if (this.origin === null) this.origin = time;
    const at = time - this.origin;

    // Callers must not overlap their own `addFrame` calls — the camera pump
    // holds a busy flag and the offline export awaits each one — because the
    // frame arrives as a *canvas the caller keeps repainting*, and a frame that
    // sat in a queue would be read after the next render had overwritten it.
    // The chain here is not a second queue for those; it is what makes `finish`
    // wait for the one add that may still be in flight when stop is pressed.
    const queued = this.queue.then(async () => {
      if (this.stopped) return false;
      const room = await this.sink.add(frame, at);
      this.lastTime = at;
      if (!room) this.hitLimit = true;
      return room;
    });
    // The chain must not break on a rejection, or every later frame — and the
    // finish — inherits it.
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  async finish(): Promise<RecordResult> {
    this.stopped = true;
    // Whatever was already in flight lands before the encoder is flushed and
    // closed.
    await this.queue;
    const { blob, container, frames } = await this.sink.finish();
    return {
      blob,
      container,
      frames,
      duration: this.lastTime,
      gifFps: this.sink.gifFps,
      approximated: this.sink.approximated,
      hitLimit: this.hitLimit,
    };
  }
}
