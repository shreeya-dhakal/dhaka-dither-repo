/**
 * Demux with mp4box, decode with WebCodecs.
 *
 * The audio track is never decoded. It is pulled out as encoded samples and
 * carried straight to the muxer, because Phase 1 owes the user their sound back
 * unchanged — and because Phase 2's analysis then sits on top of an audio path
 * that already works rather than replacing one that never did.
 */

// mp4box 2.x is a rewrite with named exports; the `MP4Box.createFile()` /
// `Movie` surface belongs to 0.5.x and does not exist here.
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from "mp4box";

export interface AudioTrack {
  /** Encoded samples, untouched — this is what pass-through means. */
  samples: Sample[];
  codec: string;
  sampleRate: number;
  channels: number;
  /** Ticks per second for this track's timestamps. */
  timescale: number;
  /** `esds`/`mp4a` decoder-specific config, required by the muxer. */
  description: Uint8Array | null;
}

export interface SourceVideo {
  /**
   * The track header's dimensions. These are what the container *claims*, and
   * they disagree with the bitstream on any file carrying a rotation matrix.
   * Nothing that has to match a decoded frame may use them — see `exportVideo`,
   * which sizes the encoder from the first frame instead.
   */
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  duration: number;
  codec: string;
  audio: AudioTrack | null;
  /**
   * The clockwise rotation the container asks players to apply. Phone
   * recordings are landscape bitstreams that carry their portrait orientation
   * here, so an export that drops it comes back on its side.
   */
  rotation: 0 | 90 | 180 | 270;
}

/**
 * The tkhd matrix read as a plain right-angle rotation.
 *
 * Values are 16.16 fixed point. Only the four right angles are recognised: an
 * arbitrary affine matrix is not something a re-encode can honour, and guessing
 * at one would tilt the picture rather than leave it alone.
 */
function rotationOf(matrix: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!matrix || matrix.length < 5) return 0;
  const unit = 65536;
  const a = Math.round((matrix[0] ?? 0) / unit);
  const b = Math.round((matrix[1] ?? 0) / unit);
  const c = Math.round((matrix[3] ?? 0) / unit);
  const d = Math.round((matrix[4] ?? 0) / unit);
  if (a === 0 && b === 1 && c === -1 && d === 0) return 90;
  if (a === -1 && b === 0 && c === 0 && d === -1) return 180;
  if (a === 0 && b === -1 && c === 1 && d === 0) return 270;
  return 0;
}

/**
 * `avcC` and friends live in the sample entry's own box. Without handing this
 * to `VideoDecoder` the stream will not open at all, and the error it gives
 * back says nothing useful about why.
 */
const CONFIG_BOXES = ["avcC", "hvcC", "vpcC", "av1C", "esds"] as const;

interface WritableBox {
  write(s: DataStream): void;
}

/**
 * Finds a codec config box anywhere under a sample entry.
 *
 * Not just the entry's own named fields: a QuickTime-flavoured `mp4a` puts its
 * `esds` inside a `wave` wrapper, and plenty of real recordings are written that
 * way. Looking only one level deep found nothing for those files, the audio then
 * reached the muxer with no decoder config, and the export died at finalize with
 * a null-property error out of the muxer's internals — long after the point
 * where anything could explain what was wrong.
 *
 * Depth is bounded because these structures are shallow by construction and a
 * malformed file must not be able to spin this forever.
 */
function findConfigBox(node: unknown, depth = 0): WritableBox | null {
  if (depth > 4 || typeof node !== "object" || node === null) return null;
  const fields = node as Record<string, unknown>;
  for (const name of CONFIG_BOXES) {
    const box = fields[name];
    if (box && typeof (box as WritableBox).write === "function") return box as WritableBox;
  }
  for (const value of Object.values(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findConfigBox(item, depth + 1);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findConfigBox(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function codecDescription(file: ISOFile, trackId: number): Uint8Array | null {
  const track = file.getTrackById(trackId);
  for (const entry of track?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = findConfigBox(entry);
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    // The first eight bytes are the box header, which the codec config is not.
    return new Uint8Array(stream.buffer, 8);
  }
  return null;
}

/**
 * Reads the whole file into mp4box and returns what the pipeline needs to know
 * before it starts. Video samples are handed back through `onFrame` during
 * `decodeFrames`, not buffered here — a 1080p clip decoded up front would be
 * gigabytes of `VideoFrame`.
 */
export async function inspect(file: File): Promise<{ source: SourceVideo; mp4: ISOFile }> {
  // `keepMdatData` defaults to false, which discards every sample payload —
  // extraction then produces no callbacks at all rather than an error, so the
  // caller simply waits forever. Pass-through needs the bytes.
  const mp4 = createFile(true);
  const buffer = MP4BoxBuffer.fromArrayBuffer(await file.arrayBuffer(), 0);

  const info = await new Promise<Movie>((resolve, reject) => {
    mp4.onError = (_module: string, message: string) =>
      reject(new Error(`could not read the video: ${message}`));
    mp4.onReady = resolve;
    mp4.appendBuffer(buffer);
    mp4.flush();
  });

  const video = info.videoTracks[0];
  if (!video) throw new Error("this file has no video track");

  const audioInfo = info.audioTracks[0];
  let audio: AudioTrack | null = null;
  if (audioInfo) {
    const samples = await new Promise<Sample[]>((resolve) => {
      const collected: Sample[] = [];
      mp4.onSamples = (_id: number, _user: unknown, chunk: Sample[]) => {
        collected.push(...chunk);
        if (collected.length >= audioInfo.nb_samples) resolve(collected);
      };
      mp4.setExtractionOptions(audioInfo.id, undefined, { nbSamples: audioInfo.nb_samples });
      mp4.start();
    });
    audio = {
      samples,
      codec: audioInfo.codec,
      sampleRate: audioInfo.audio?.sample_rate ?? 48000,
      channels: audioInfo.audio?.channel_count ?? 2,
      timescale: audioInfo.timescale,
      description: codecDescription(mp4, audioInfo.id),
    };
    mp4.stop();
    mp4.flush();
  }

  const duration = info.duration / info.timescale;
  return {
    source: {
      // Rounded: mp4box reports these from a 16.16 fixed-point field and they
      // are not always whole numbers.
      width: Math.round(video.track_width),
      height: Math.round(video.track_height),
      frameCount: video.nb_samples,
      fps: duration > 0 ? video.nb_samples / duration : 30,
      duration,
      codec: video.codec,
      audio,
      rotation: rotationOf(video.matrix),
    },
    mp4,
  };
}

/** Whether WebCodecs will take this stream at all. */
export async function canDecode(source: SourceVideo): Promise<boolean> {
  const support = await VideoDecoder.isConfigSupported({ codec: source.codec }).catch(() => null);
  return support?.supported === true;
}

/**
 * The fallback path, for streams WebCodecs refuses.
 *
 * HEVC is the case that matters: Chrome plays `hvc1` in a `<video>` element
 * through the platform decoder but will not open 10-bit HEVC in `VideoDecoder`,
 * and iPhones record exactly that.
 *
 * Frames are reached by **playing**, not by seeking. Seeking looked better —
 * it visits every frame exactly once instead of dropping whatever the renderer
 * cannot keep up with — but on real 10-bit HEVC the element raises a decode
 * error on the seek while playing the same file perfectly. A path that is
 * exact and fails is worth less than one that works.
 *
 * The drop problem is handled instead by pausing around the work: the element
 * is stopped while each frame is processed and restarted afterwards, so no
 * frame presents unobserved. Timestamps come from `mediaTime` rather than a
 * frame counter, so even a frame that does slip past leaves the output timed
 * correctly rather than shortened.
 */
export async function decodeFramesViaElement(
  file: File,
  onFrame: (frame: HTMLVideoElement, index: number, mediaTime: number) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  // Always a fresh element, never the preview.
  //
  // Reusing the preview meant rewinding it, and rewinding means seeking — the
  // one operation this codec refuses. A new element begins at zero on its own,
  // so the export never seeks at all. It also cannot inherit the preview's
  // `loop`, which is what made an earlier export run forever.
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  const objectUrl = URL.createObjectURL(file);
  element.src = objectUrl;

  /**
   * `MediaError` distinguishes "this codec is not supported at all" (code 4)
   * from "decoding failed partway" (code 3), and those want different fixes.
   * Reporting the bare fact of an error tells nobody anything.
   */
  const describe = () => {
    const error = element.error;
    if (!error) return "the element reported an error with no detail";
    const kind =
      {
        1: "loading was aborted",
        2: "a network error",
        3: "the data could not be decoded",
        4: "this codec or file is not supported",
      }[error.code] ?? `code ${error.code}`;
    const detail = error.message ? ` — ${error.message}` : "";
    return `${kind}${detail} (readyState ${element.readyState}, networkState ${element.networkState})`;
  };

  const withCallback = element as HTMLVideoElement & {
    requestVideoFrameCallback?: (
      cb: (now: number, meta: { mediaTime: number }) => void,
    ) => number;
  };
  if (!withCallback.requestVideoFrameCallback) {
    throw new Error("this browser can neither decode the stream nor step through it");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      element.addEventListener("loadedmetadata", () => resolve(), { once: true });
      element.addEventListener("error", () => reject(new Error(describe())), { once: true });
    });

    // No `currentTime = 0` here on purpose: a new element is already there, and
    // the assignment would be a seek.
    let index = 0;
    let lastTime = -1;

    await new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error(describe()));
      element.addEventListener("error", onError, { once: true });

      const done = () => {
        element.removeEventListener("error", onError);
        resolve();
      };
      element.addEventListener("ended", done, { once: true });

      const step = (_now: number, meta: { mediaTime: number }) => {
        void (async () => {
          if (signal?.aborted) {
            done();
            return;
          }
          // Belt and braces: if the clock ever runs backwards the source has
          // wrapped, and everything after this point would be a second pass.
          if (meta.mediaTime < lastTime) {
            done();
            return;
          }
          // Stop the clock while the frame is processed, so nothing presents
          // unobserved, then start it again to fetch the next one.
          element.pause();
          try {
            if (meta.mediaTime > lastTime) {
              lastTime = meta.mediaTime;
              await onFrame(element, index++, meta.mediaTime);
            }
          } catch (error) {
            element.removeEventListener("error", onError);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (element.ended) {
            done();
            return;
          }
          withCallback.requestVideoFrameCallback!(step);
          void element.play().catch((error: unknown) => {
            // A rejected `play()` is **not** the end of the clip.
            //
            // This used to call `done()`, which resolves — so the export
            // finished normally with only the frames gathered so far and wrote
            // a file cut off at the moment playback stopped, with nothing on
            // screen to say so. `play()` rejects under resource pressure, and
            // this path exists for codecs the platform already struggles with,
            // decoded while the preview is playing the same file. Ending early
            // is the one outcome that must never be silent.
            if (element.ended) {
              done();
              return;
            }
            element.removeEventListener("error", onError);
            const reason = error instanceof Error ? error.message : String(error);
            reject(
              new Error(
                `playback stopped after ${index} frames, at ${element.currentTime.toFixed(2)}s of ${element.duration.toFixed(2)}s: ${reason}`,
              ),
            );
          });
        })();
      };

      withCallback.requestVideoFrameCallback!(step);
      void element.play().catch(() => reject(new Error(describe())));
    });
  } finally {
    element.pause();
    // Revoke before blanking: reading `src` back after clearing it does not
    // return the object URL, so the original ordering leaked one per export.
    URL.revokeObjectURL(objectUrl);
    element.removeAttribute("src");
    element.load();
  }
}

/**
 * Decodes every video frame in order and hands each to `onFrame`, which must
 * `close()` it. Frames are pulled with backpressure rather than queued: a
 * decoder left to run ahead of a slow renderer will exhaust memory on a long
 * clip.
 */
export async function decodeFrames(
  mp4: ISOFile,
  source: SourceVideo,
  onFrame: (frame: VideoFrame, index: number, mediaTime?: number) => Promise<void> | void,
  signal?: AbortSignal,
): Promise<void> {
  // Already parsed by `inspect`, and onReady does not fire twice.
  const info = mp4.getInfo();
  const track = info.videoTracks[0];
  if (!track) throw new Error("this file has no video track");

  let index = 0;
  let pending: Promise<void> = Promise.resolve();
  let failure: Error | null = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      const current = index++;
      // The frame's own presentation time, carried through from the container's
      // `cts`. Not `index / fps`: that spaces every frame by the *average* rate,
      // which is right only for constant-frame-rate material. Phones record
      // variable frame rate as a matter of course, and an average then makes the
      // export a different length from the source — by an amount that depends on
      // the clip, so it reads as random.
      //
      // Absolute, never accumulated, so there is no drift to worry about: this
      // is the same guarantee `index / fps` was reaching for.
      const mediaTime = Number.isFinite(frame.timestamp) ? frame.timestamp / 1e6 : undefined;
      pending = pending.then(async () => {
        if (signal?.aborted) {
          frame.close();
          return;
        }
        await onFrame(frame, current, mediaTime);
      });
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });

  // `codedWidth`/`codedHeight` are deliberately omitted. They are optional
  // hints, and the track header disagrees with the bitstream whenever the file
  // carries a rotation matrix — a portrait phone clip reports 1080×1920 in the
  // header over a 1920×1080 stream. Handing the decoder those numbers is an
  // unsupported configuration, reported as a bare "Operation is not supported".
  // The decoder reads the real dimensions out of the stream.
  const config: VideoDecoderConfig = {
    codec: source.codec,
    description: codecDescription(mp4, track.id) ?? undefined,
  };
  // Probed before configuring so an unplayable codec is named rather than
  // surfacing as a bare "Operation is not supported".
  decoder.configure(config);

  const samples = await new Promise<Sample[]>((resolve) => {
    const collected: Sample[] = [];
    mp4.onSamples = (_id: number, _user: unknown, chunk: Sample[]) => {
      collected.push(...chunk);
      if (collected.length >= track.nb_samples) resolve(collected);
    };
    mp4.setExtractionOptions(track.id, undefined, { nbSamples: track.nb_samples });
    mp4.start();
  });

  for (const sample of samples) {
    if (signal?.aborted) break;
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: (sample.cts * 1e6) / sample.timescale,
        duration: (sample.duration * 1e6) / sample.timescale,
        data: sample.data!,
      }),
    );
    // Keep the decoder from running far ahead of the renderer.
    if (decoder.decodeQueueSize > 8) await pending;
  }

  await decoder.flush();
  await pending;
  decoder.close();
  if (failure) throw failure;
}
