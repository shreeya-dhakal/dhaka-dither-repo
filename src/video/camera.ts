/**
 * The camera, opened only when the user says so.
 *
 * The app's promise is that nothing leaves the machine, and a camera is the
 * one feature where that promise needs *demonstrating* rather than stating. So
 * the shape here is deliberate: nothing in this module runs on load, nothing
 * probes the hardware to populate a menu, and `open` — the only function that
 * can raise the browser's permission prompt — is reachable from exactly one
 * button that says what it is about to do.
 *
 * `status` exists to make that button honest. It reports what the browser
 * already knows *without asking for anything*, so the interface can say "this
 * will ask for permission" or "permission was refused, here is how to undo
 * that" instead of finding out by triggering a prompt.
 */

/** What the browser will do if `open` is called, as far as it can be known in advance. */
export type CameraStatus =
  /** No camera API at all — an old browser, or a context where it is not exposed. */
  | "unsupported"
  /** The API exists but the page is not a secure context, so it will always fail. */
  | "insecure"
  /** Permission is already granted: opening will not prompt. */
  | "granted"
  /** Permission was refused and the browser will not re-ask; the user must undo it in site settings. */
  | "denied"
  /** Opening will raise the browser's prompt. Also the answer when the browser will not say. */
  | "prompt";

export interface CameraFacing {
  /** `user` is the selfie camera, `environment` the rear one. Ignored when a device id is given. */
  facing?: "user" | "environment";
  /** A specific camera from `cameras()`. Wins over `facing`. */
  deviceId?: string;
  /** Asked for, never insisted on — a camera that cannot do it picks its own nearest size. */
  width?: number;
  height?: number;
}

export interface OpenCamera {
  stream: MediaStream;
  /** The size and device the camera actually gave, which is rarely exactly what was asked for. */
  settings: { width: number; height: number; frameRate: number; deviceId: string; label: string };
}

export interface CameraDevice {
  deviceId: string;
  /**
   * Empty until permission has been granted at least once. Browsers withhold
   * camera labels from an unpermissioned page because the list of attached
   * hardware is itself a fingerprint — so a device menu built before the
   * prompt would be a list of blanks, which is why one is not offered until after.
   */
  label: string;
}

function api(): MediaDevices | null {
  if (typeof navigator === "undefined") return null;
  return navigator.mediaDevices ?? null;
}

/**
 * What will happen on `open`, without asking for anything.
 *
 * The Permissions API is queried where it exists and its absence is not an
 * error — Safari has never shipped the `camera` descriptor, and the honest
 * answer there is "this will prompt", which is also the safe thing to tell the
 * user. A browser that throws on the query is treated the same way.
 */
export async function status(): Promise<CameraStatus> {
  const devices = api();
  if (!devices || typeof devices.getUserMedia !== "function") {
    // A secure-context failure looks identical to an unsupported browser from
    // here — `mediaDevices` is simply absent on an insecure origin — so the
    // context is checked first and gets its own answer. The two need different
    // sentences: one is "use another browser", the other "use https".
    if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
    return "unsupported";
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";

  try {
    const result = await navigator.permissions?.query({ name: "camera" as PermissionName });
    if (result?.state === "granted") return "granted";
    if (result?.state === "denied") return "denied";
  } catch {
    // Not supported here. "It will prompt" is both the truthful answer and the
    // one that leads to a working button.
  }
  return "prompt";
}

/**
 * The cameras attached, for a device menu.
 *
 * Only useful after permission — see `CameraDevice.label`. Calling it before
 * does not prompt and does not fail; it returns entries with blank labels, and
 * the caller is expected not to show a menu of those.
 */
export async function cameras(): Promise<CameraDevice[]> {
  const devices = api();
  if (!devices?.enumerateDevices) return [];
  try {
    const all = await devices.enumerateDevices();
    return all
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({ deviceId: device.deviceId, label: device.label }));
  } catch {
    return [];
  }
}

/**
 * `getUserMedia`'s failures, as sentences.
 *
 * Every one of these arrives as a `DOMException` whose `message` is a phrase
 * like "Permission denied" with no indication of what the user could do about
 * it, and whose `name` carries the actual information. Two of them —
 * `NotAllowedError` from a refused prompt and `NotAllowedError` from a
 * previously refused site — are genuinely indistinguishable, which is why the
 * wording below covers both.
 */
export function explain(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "camera permission was refused — allow it for this page in your browser's site settings, then try again";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no camera is attached to this machine";
    case "NotReadableError":
    case "TrackStartError":
      return "the camera is attached but could not be started — another app or tab is probably using it";
    case "OverconstrainedError":
      return "this camera cannot produce the requested size";
    case "AbortError":
      return "the camera stopped before it started";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Opens the camera. **This is the call that prompts** — nothing else in the
 * module does, and nothing should call it except a control the user pressed.
 *
 * Audio is not requested, and that is a decision rather than an omission: the
 * recorder writes picture only, so asking for a microphone would raise a second
 * permission for a track that gets thrown away.
 */
export async function open(options: CameraFacing = {}): Promise<OpenCamera> {
  const devices = api();
  if (!devices?.getUserMedia) {
    throw new Error(
      typeof window !== "undefined" && window.isSecureContext === false
        ? "the camera is only available over https or on localhost"
        : "this browser does not expose a camera API",
    );
  }

  const video: MediaTrackConstraints = {};
  if (options.deviceId) video.deviceId = { exact: options.deviceId };
  else if (options.facing) video.facingMode = options.facing;
  // `ideal`, never `exact`: a webcam that cannot do 1280×720 should hand back
  // whatever it can rather than raise `OverconstrainedError`. The size that
  // actually arrived is read back off the track below and is the only one the
  // rest of the app uses.
  if (options.width) video.width = { ideal: options.width };
  if (options.height) video.height = { ideal: options.height };

  const stream = await devices.getUserMedia({ video: Object.keys(video).length ? video : true });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stop(stream);
    throw new Error("the camera opened but produced no video track");
  }

  const settings = track.getSettings();
  return {
    stream,
    settings: {
      width: settings.width ?? 0,
      height: settings.height ?? 0,
      frameRate: settings.frameRate ?? 30,
      deviceId: settings.deviceId ?? "",
      label: track.label,
    },
  };
}

/**
 * Every track stopped, which is what turns the hardware light off.
 *
 * Clearing the element's `srcObject` alone does not: the stream keeps its
 * tracks live, the camera stays on, and the user is left looking at an
 * indicator for a camera nobody is reading. Stopping the tracks is the only
 * thing that releases it.
 */
export function stop(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
