// Webcam capture. Frames stay local until you send a message with the camera on —
// then that single frame rides along with the turn as an image block.

let stream: MediaStream | null = null;
let videoEl: HTMLVideoElement | null = null;

export const cameraSupported =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export async function startCamera(el: HTMLVideoElement): Promise<void> {
  // Re-entrant on purpose. The old `if (stream) return` bailed out BEFORE binding
  // `videoEl`, so any attempt that left a stream behind (see the catch in
  // App.toggleCamera) made every later attempt a silent no-op: the eye read
  // "live", captureFrame() returned null forever, and every message went out
  // with no frame attached.
  const live = stream?.getVideoTracks().some((t) => t.readyState === "live");
  if (!live) {
    stopCamera(); // clear any half-dead stream before asking for a new one
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  }
  el.srcObject = stream;
  el.muted = true;
  // Bound BEFORE awaiting play(): the eye already shows "on" by this point, so a
  // message sent in the meantime must still find the element. captureFrame()'s
  // videoWidth check covers the case where frames aren't flowing yet.
  videoEl = el;
  await el.play();
}

export function stopCamera(): void {
  stream?.getTracks().forEach((t) => t.stop());
  if (videoEl) videoEl.srcObject = null;
  stream = null;
  videoEl = null;
}

/** Grab the current frame as base64 JPEG, downscaled to keep tokens sane. */
export function captureFrame(maxWidth = 1024): { mediaType: string; data: string } | null {
  const el = videoEl;
  if (!el || !el.videoWidth) return null;
  const scale = Math.min(1, maxWidth / el.videoWidth);
  const w = Math.round(el.videoWidth * scale);
  const h = Math.round(el.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(el, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  const data = dataUrl.split(",")[1];
  return data ? { mediaType: "image/jpeg", data } : null;
}
