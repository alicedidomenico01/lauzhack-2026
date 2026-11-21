// Camera: live preview, and a verdict recomputed from the actual frames.
// Starts by itself when permission is already granted, otherwise on first open
// of the section (a permission prompt cannot be avoided on first use).

import { permissionHelp } from "../ui/permission.js";

const SAMPLE_MS = 700;

export function mountCamera(root, { setStatus }) {
  root.innerHTML = `
    <div class="preview">
      <video playsinline muted></video>
      <span class="live-dot"></span>
      <div class="empty" data-empty>Waiting for the camera…</div>
    </div>
    <p class="verdict" data-verdict></p>
    <p class="hint" data-hint></p>
  `;

  const ui = {
    video: root.querySelector("video"),
    empty: root.querySelector("[data-empty]"),
    dot: root.querySelector(".live-dot"),
    verdict: root.querySelector("[data-verdict]"),
    hint: root.querySelector("[data-hint]"),
  };

  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const cctx = canvas.getContext("2d", { willReadFrequently: true });

  let stream = null;
  let timer = 0;
  let active = false;

  function analyse() {
    if (!stream || ui.video.readyState < 2) return;
    cctx.drawImage(ui.video, 0, 0, canvas.width, canvas.height);
    const { data } = cctx.getImageData(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;
    let total = 0;
    let centerSum = 0;
    let centerN = 0;
    let edgeSum = 0;
    let edgeN = 0;

    for (let p = 0; p < data.length; p += 4) {
      const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      total += lum;
      const i = p / 4;
      const x = i % w;
      const y = (i / w) | 0;
      if (x >= w * 0.3 && x < w * 0.7 && y >= h * 0.2 && y < h * 0.8) {
        centerSum += lum;
        centerN++;
      } else {
        edgeSum += lum;
        edgeN++;
      }
    }

    const mean = total / (data.length / 4);
    const center = centerN ? centerSum / centerN : mean;
    const edge = edgeN ? edgeSum / edgeN : mean;
    const ratio = edge > 1 ? center / edge : 1;

    if (mean < 45) {
      ui.verdict.className = "verdict bad";
      ui.verdict.textContent = `Too dark (${mean.toFixed(0)}/255). The room sees a silhouette.`;
      setStatus("camera", "bad", "too dark");
    } else if (ratio < 0.75) {
      ui.verdict.className = "verdict warn";
      ui.verdict.textContent = "Backlit: the light behind you is brighter than your face.";
      setStatus("camera", "warn", "backlit");
    } else {
      ui.verdict.className = "verdict ok";
      ui.verdict.textContent = `Looks fine: exposure ${mean.toFixed(0)}/255, face lit.`;
      setStatus("camera", "ok", "ok");
    }
  }

  return {
    async start() {
      if (active) return;
      active = true;
      setStatus("camera", "busy", "starting");

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 } },
        });
        ui.video.srcObject = stream;
        await ui.video.play();
        ui.empty.hidden = true;
        timer = setInterval(analyse, SAMPLE_MS);
        analyse();
      } catch (err) {
        active = false;
        ui.empty.hidden = false;
        ui.empty.textContent =
          err.name === "NotAllowedError"
            ? "Camera blocked. Use the button below to allow it."
            : `No camera: ${err.message}`;
        setStatus("camera", "bad", err.name === "NotAllowedError" ? "blocked" : "error");
        if (err.name === "NotAllowedError") permissionHelp(root, "camera");
      }
    },
    stop() {
      active = false;
      clearInterval(timer);
      timer = 0;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      ui.video.srcObject = null;
      ui.empty.hidden = false;
      ui.empty.textContent = "Camera off";
      setStatus("camera", "", "idle");
    },
    isActive: () => active,
  };
}
