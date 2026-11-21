// Camera: live preview, and a verdict recomputed from the actual frames.
// Starts by itself when permission is already granted, otherwise on first open
// of the section (a permission prompt cannot be avoided on first use).
//
// Frames are read from the camera track itself, not from the <video>, so the
// frame rate and the analysis stay honest when the section is collapsed.
// What it can tell apart:
//   black image (shutter closed, lens covered)   frozen (no new frames)
//   a still picture (virtual camera)             too dark / washed out / backlit
//   choppy (low frame rate)                      fine

import { permissionHelp } from "../ui/permission.js";
import { distinctDevices, fillSelect, explainMediaError } from "../lib/media.js";

const SAMPLE_MS = 700;
const FROZEN_MS = 2500; // no new frame for this long = frozen
const STILL_SAMPLES = 5; // identical analysed frames in a row = a still picture
const FPS_WINDOW_MS = 2000;
const FPS_CHOPPY = 15;

export function mountCamera(root, { setStatus }) {
  root.innerHTML = `
    <select data-device aria-label="Camera" hidden></select>
    <div class="preview">
      <video playsinline muted></video>
      <span class="live-dot"></span>
      <div class="empty" data-empty>Waiting for the camera…</div>
    </div>
    <p class="verdict" data-verdict></p>
    <p class="hint" data-hint></p>
    <details class="more">
      <summary>
        <span class="sum-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </span>
        <span>Details</span>
      </summary>
      <dl class="metrics">
        <div><dt>Resolution</dt><dd data-res>—</dd></div>
        <div><dt>Frame rate</dt><dd data-fps>—</dd></div>
        <div><dt>Brightness</dt><dd data-light>—</dd></div>
        <div><dt>Face vs. background</dt><dd data-ratio>—</dd></div>
      </dl>
    </details>
  `;

  const ui = {
    device: root.querySelector("[data-device]"),
    video: root.querySelector("video"),
    empty: root.querySelector("[data-empty]"),
    verdict: root.querySelector("[data-verdict]"),
    hint: root.querySelector("[data-hint]"),
    res: root.querySelector("[data-res]"),
    fps: root.querySelector("[data-fps]"),
    light: root.querySelector("[data-light]"),
    ratio: root.querySelector("[data-ratio]"),
  };

  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const cctx = canvas.getContext("2d", { willReadFrequently: true });

  let active = false;
  let devices = [];
  let deviceId = null;

  let stream = null;
  let tap = null; // cloned track the frame reader consumes
  let reader = null;
  let fallbackTimer = 0;
  let evalTimer = 0;
  let openSeq = 0;
  let openedAt = 0;

  let frameTimes = [];
  let lastFrameAt = 0;
  let lastAnalysedAt = 0;
  let prevLum = null;
  let stillCount = 0;
  let last = null; // latest image measurements
  let muted = false;
  let ended = false;

  // Light smoothing so the verdict does not flicker between two states.
  let recent = [];
  let shown = null;

  const nameOf = (id) => devices.find((d) => d.deviceId === id)?.name || "this camera";

  function measure(source, w, h) {
    cctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const { data } = cctx.getImageData(0, 0, canvas.width, canvas.height);
    const W = canvas.width;
    const H = canvas.height;
    const n = W * H;
    const lum = new Float32Array(n);

    let total = 0;
    let sq = 0;
    let blown = 0;
    let centerSum = 0;
    let centerN = 0;
    let edgeSum = 0;
    let edgeN = 0;

    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const l = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      lum[i] = l;
      total += l;
      sq += l * l;
      if (l > 250) blown++;
      const x = i % W;
      const y = (i / W) | 0;
      if (x >= W * 0.3 && x < W * 0.7 && y >= H * 0.2 && y < H * 0.8) {
        centerSum += l;
        centerN++;
      } else {
        edgeSum += l;
        edgeN++;
      }
    }

    const mean = total / n;
    const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    const center = centerN ? centerSum / centerN : mean;
    const edge = edgeN ? edgeSum / edgeN : mean;

    // Real sensors always have noise, so two live frames are never identical.
    let diff = null;
    if (prevLum) {
      let d = 0;
      for (let i = 0; i < n; i++) d += Math.abs(lum[i] - prevLum[i]);
      diff = d / n;
    }
    prevLum = lum;
    stillCount = diff !== null && diff < 0.05 ? stillCount + 1 : 0;

    last = {
      mean,
      sd,
      blown: blown / n,
      ratio: edge > 1 ? center / edge : 1,
      width: w,
      height: h,
    };
  }

  async function readTrack(track, seq) {
    tap = track.clone();
    // eslint-disable-next-line no-undef
    const processor = new MediaStreamTrackProcessor({ track: tap });
    reader = processor.readable.getReader();
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || seq !== openSeq) {
          frame?.close();
          break;
        }
        const now = performance.now();
        lastFrameAt = now;
        frameTimes.push(now);
        if (now - lastAnalysedAt >= SAMPLE_MS) {
          lastAnalysedAt = now;
          measure(frame, frame.displayWidth, frame.displayHeight);
        }
        frame.close();
      }
    } catch {
      /* reader cancelled on stop or device switch */
    }
  }

  // Older Chrome without MediaStreamTrackProcessor: sample the <video>.
  function readVideo() {
    fallbackTimer = setInterval(() => {
      if (ui.video.readyState < 2) return;
      measure(ui.video, ui.video.videoWidth, ui.video.videoHeight);
    }, SAMPLE_MS);
  }

  function classify() {
    const now = performance.now();
    frameTimes = frameTimes.filter((t) => now - t < FPS_WINDOW_MS);
    const counting = !fallbackTimer;
    const fps = counting && now - openedAt > FPS_WINDOW_MS ? frameTimes.length / (FPS_WINDOW_MS / 1000) : null;
    const name = nameOf(deviceId);

    if (ended) return { key: "ended", urgent: true, level: "bad", status: "disconnected", text: `${name} stopped: unplugged, or taken by another app.` };
    if (muted) return { key: "muted", urgent: true, level: "bad", status: "paused", text: "The system paused the camera: another app took it, or the lid is closed." };
    if (counting && now - openedAt > FROZEN_MS && now - (lastFrameAt || openedAt) > FROZEN_MS) {
      return { key: "frozen", level: "bad", status: "frozen", text: "No new frames: the camera is frozen. Close other apps using it, or unplug and replug it." };
    }
    if (!last) return { key: "starting", level: "", status: "busy", statusText: "starting", text: "Starting the camera…" };

    const { mean, sd, blown, ratio } = last;
    if (mean < 12 && sd < 6) {
      return { key: "black", level: "bad", status: "black", text: "Black image: the privacy shutter is closed, the lens is covered, or the camera is disabled." };
    }
    if (stillCount >= STILL_SAMPLES) {
      return { key: "still", level: "warn", status: "still image", text: "The picture never changes: this is a still image, not a live camera. Probably a virtual camera showing a placeholder." };
    }
    if (mean < 45) {
      return { key: "dark", level: "bad", status: "too dark", text: `Too dark (${mean.toFixed(0)}/255): people will see a silhouette. Turn on a light in front of you.` };
    }
    if (blown > 0.25 || mean > 215) {
      return { key: "bright", level: "warn", status: "washed out", text: "Washed out: too much direct light. Close a blind or move away from the window." };
    }
    if (ratio < 0.75) {
      return { key: "backlit", level: "warn", status: "backlit", text: "Backlit: the light behind you is brighter than your face. Face the window instead." };
    }
    if (fps !== null && fps < FPS_CHOPPY) {
      return { key: "choppy", level: "warn", status: "choppy", text: `Choppy: ${fps.toFixed(0)} fps. Usually low light (the camera slows down to gather it) or a busy computer.` };
    }
    return { key: "ok", level: "ok", status: "ok", text: `Looks good on ${name}.` };
  }

  function evaluate() {
    const now = performance.now();
    const fps = !fallbackTimer && now - openedAt > FPS_WINDOW_MS ? frameTimes.length / (FPS_WINDOW_MS / 1000) : null;
    if (last) {
      ui.res.textContent = last.width ? `${last.width}×${last.height}` : "—";
      ui.light.textContent = `${last.mean.toFixed(0)}/255`;
      ui.ratio.textContent = last.ratio.toFixed(2);
    }
    ui.fps.textContent = fps === null ? "—" : `${fps.toFixed(0)} fps`;

    const r = classify();
    recent.push(r.key);
    if (recent.length > 3) recent.shift();
    const agreed = recent.filter((k) => k === r.key).length >= 2;
    if (!(r.urgent || agreed || shown === null || shown === "starting")) return;

    shown = r.key;
    ui.verdict.className = r.level ? `verdict ${r.level}` : "verdict";
    ui.verdict.textContent = r.text;
    setStatus(r.level || r.status, r.statusText || r.status);
  }

  function closeStream() {
    openSeq++;
    clearInterval(fallbackTimer);
    fallbackTimer = 0;
    reader?.cancel().catch(() => {});
    reader = null;
    tap?.stop();
    tap = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    ui.video.srcObject = null;
  }

  async function open(id) {
    closeStream();
    const seq = openSeq;
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        ...(id ? { deviceId: { exact: id } } : {}),
      },
    });
    if (seq !== openSeq || !active) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }

    stream = s;
    const track = stream.getVideoTracks()[0];
    deviceId = track.getSettings().deviceId || id;

    openedAt = performance.now();
    frameTimes = [];
    lastFrameAt = 0;
    lastAnalysedAt = 0;
    prevLum = null;
    stillCount = 0;
    last = null;
    muted = track.muted;
    ended = false;
    recent = [];
    shown = null;

    track.addEventListener("mute", () => (muted = true));
    track.addEventListener("unmute", () => (muted = false));
    track.addEventListener("ended", () => (ended = true));

    ui.video.srcObject = stream;
    await ui.video.play().catch(() => {});
    ui.empty.hidden = true;

    if ("MediaStreamTrackProcessor" in window) readTrack(track, seq);
    else readVideo();

    const dev = devices.find((d) => d.deviceId === deviceId);
    ui.hint.textContent = dev?.isVirtual
      ? `${dev.name} is a virtual camera: people see whatever it outputs, not your webcam.`
      : "";
  }

  async function refreshDevices() {
    devices = distinctDevices(await navigator.mediaDevices.enumerateDevices(), "videoinput");
    fillSelect(ui.device, devices);
    if (deviceId) ui.device.value = deviceId;
  }

  async function onDeviceChange() {
    if (!active) return;
    const before = devices;
    await refreshDevices();
    const added = devices.filter((d) => !before.some((b) => b.deviceId === d.deviceId));
    const lost = deviceId && !devices.some((d) => d.deviceId === deviceId);
    if (lost) {
      const lostName = before.find((d) => d.deviceId === deviceId)?.name || "The camera";
      if (!devices.length) {
        closeStream();
        ui.empty.hidden = false;
        ui.empty.textContent = "No camera connected.";
        ui.verdict.className = "verdict bad";
        ui.verdict.textContent = `${lostName} was disconnected and no other camera is available.`;
        setStatus("bad", "missing");
        return;
      }
      await useDevice(devices[0].deviceId);
      ui.hint.textContent = `${lostName} was disconnected. Now testing ${devices[0].name}.`;
    } else if (added.length) {
      ui.hint.textContent = `${added[0].name} connected. Pick it above to test it.`;
    }
  }

  async function useDevice(id) {
    try {
      await open(id);
      if (deviceId) ui.device.value = deviceId;
    } catch (err) {
      fail(err);
    }
  }

  function fail(err) {
    closeStream();
    const e = explainMediaError(err, "camera");
    ui.empty.hidden = false;
    ui.empty.textContent = e.text;
    ui.verdict.className = "verdict bad";
    ui.verdict.textContent = e.text;
    ui.hint.textContent = e.hint;
    setStatus("bad", e.status);
    if (e.permission) permissionHelp(root, "camera");
  }

  ui.device.addEventListener("change", (e) => useDevice(e.target.value));

  return {
    async start() {
      if (active) return;
      active = true;
      setStatus("busy", "starting");
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Starting the camera…";
      try {
        await open(null); // the system's default camera first
        await refreshDevices();
        const dev = devices.find((d) => d.deviceId === deviceId);
        if (dev?.isVirtual) {
          ui.hint.textContent = `${dev.name} is a virtual camera: people see whatever it outputs, not your webcam.`;
        }
        navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
        evalTimer = setInterval(evaluate, SAMPLE_MS);
      } catch (err) {
        active = false;
        fail(err);
      }
    },
    stop() {
      active = false;
      clearInterval(evalTimer);
      evalTimer = 0;
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      closeStream();
      ui.empty.hidden = false;
      ui.empty.textContent = "Camera off";
      setStatus("", "idle");
    },
    isActive: () => active,
  };
}
