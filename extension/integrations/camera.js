// Camera: live preview, a face-aware verdict, and an overlay that shows the
// problem on the picture itself.
//
// Frames come from the camera track (MediaStreamTrackProcessor), so the frame
// rate and the analysis stay honest when the section is collapsed. Twice a
// second one frame is analysed: brightness in linear light (so ratios are real
// light ratios, in photographic stops), and a local face detector says where
// the face is, so lighting is judged on the face instead of the middle of the
// frame. Four checks, shown as chips; the headline names the most urgent one:
//   Image    live, not black, not frozen, not a still picture
//   Light    face exposure, backlight, side light
//   Framing  face found, size, height, centring
//   Smooth   frame rate

import { permissionHelp } from "../ui/permission.js";
import { distinctDevices, fillSelect, explainMediaError } from "../lib/media.js";
import { loadFaceDetector, faceDetectorState, findFace } from "../lib/face.js";

const SAMPLE_MS = 500;
const AW = 320; // analysis width; the height follows the camera's aspect ratio
const FROZEN_MS = 2500; // no new frame for this long = frozen
const STILL_MS = 3000; // identical frames for this long = a still picture
const FPS_WINDOW_MS = 2000;
const FPS_CHOPPY = 15;
const NO_FACE_MS = 1500; // time-based, so a slow computer judges as fast as a quick one

// Light, in stops (one stop = twice the light). An ordinary white wall sits
// 1–1.5 stops above a face; a window behind you is 3–5.
const BACKLIT_STOPS = 2;
const BACKLIT_FACE_MAX = 150; // a face this bright is fine whatever is behind it
const SIDE_STOPS = 1.2;
// Face brightness on the 0–255 scale photo editors use.
const FACE_DARK = 70;
const FACE_BRIGHT = 225;
// Face box width as a share of the frame width, and where its centre sits.
const FACE_SMALL = 0.11;
const FACE_LARGE = 0.5;
const FACE_LOW = 0.62;
const FACE_SIDE = 0.22; // distance of the centre from the middle

const LIN = Float32Array.from({ length: 256 }, (_, v) => Math.pow(v / 255, 2.2));
const stopsBetween = (a, b) => Math.log2(Math.max(a, 1e-4) / Math.max(b, 1e-4));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (x) => `${Math.round(x * 100)}%`;
const RANK = { unknown: 0, ok: 1, warn: 2, bad: 3 };

export function mountCamera(root, { setStatus }) {
  root.innerHTML = `
    <select data-device aria-label="Camera" hidden></select>
    <div class="preview">
      <video playsinline muted></video>
      <canvas class="overlay" aria-hidden="true"></canvas>
      <span class="live-dot"></span>
      <div class="empty" data-empty>Waiting for the camera…</div>
    </div>
    <div class="checks">
      <span class="check" data-check="image"><i></i>Image</span>
      <span class="check" data-check="light"><i></i>Light</span>
      <span class="check" data-check="framing"><i></i>Framing</span>
      <span class="check" data-check="smooth"><i></i>Smooth</span>
    </div>
    <p class="verdict" data-verdict></p>
    <p class="tip" data-tip></p>
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
        <div><dt>Face</dt><dd data-face>—</dd></div>
        <div><dt>Face light</dt><dd data-light>—</dd></div>
        <div><dt>Backlight</dt><dd data-back>—</dd></div>
        <div><dt>Side light</dt><dd data-side>—</dd></div>
      </dl>
    </details>
  `;

  const $ = (s) => root.querySelector(s);
  const ui = {
    device: $("[data-device]"),
    preview: $(".preview"),
    video: $("video"),
    overlay: $("canvas.overlay"),
    empty: $("[data-empty]"),
    checks: Object.fromEntries([...root.querySelectorAll("[data-check]")].map((el) => [el.dataset.check, el])),
    verdict: $("[data-verdict]"),
    tip: $("[data-tip]"),
    hint: $("[data-hint]"),
    res: $("[data-res]"),
    fps: $("[data-fps]"),
    face: $("[data-face]"),
    light: $("[data-light]"),
    back: $("[data-back]"),
    side: $("[data-side]"),
  };

  const canvas = document.createElement("canvas");
  canvas.width = AW;
  canvas.height = 180;
  const cctx = canvas.getContext("2d", { willReadFrequently: true });
  const octx = ui.overlay.getContext("2d");
  const mask = document.createElement("canvas");
  const mctx = mask.getContext("2d");
  const zebra = document.createElement("canvas");
  const zctx = zebra.getContext("2d");

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

  let frameTimes = []; // capture timestamps (ms) of recent frames
  let lastFrameAt = 0; // wall clock of the last frame received
  let lastSampleAt = 0;
  let busy = false;
  let frameSize = null;
  let prevLum = null;
  let stillSince = 0; // when frames stopped changing (0 = they change)
  let noFaceSince = 0; // when the face was last lost (0 = we see one)
  let last = null; // latest analysis
  let muted = false;
  let ended = false;

  // Light smoothing so the headline does not flicker between two states.
  let recent = [];
  let shown = null;

  const nameOf = (id) => devices.find((d) => d.deviceId === id)?.name || "this camera";

  // ---------- analysis ----------

  function grab(source, w, h) {
    const ah = Math.max(2, Math.round((AW * h) / w / 2) * 2);
    if (canvas.height !== ah) {
      canvas.height = ah;
      prevLum = null;
    }
    cctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (!frameSize || frameSize.w !== w || frameSize.h !== h) {
      frameSize = { w, h };
      // Same shape as the camera, so object-fit: cover never crops and the
      // overlay lines up with the picture.
      ui.preview.style.aspectRatio = `${w} / ${h}`;
    }
  }

  async function analyse(seq) {
    busy = true;
    try {
      const W = canvas.width;
      const H = canvas.height;
      const { data } = cctx.getImageData(0, 0, W, H);
      const n = W * H;
      const lum = new Uint8Array(n);

      let total = 0;
      let sq = 0;
      let blown = 0;
      let cSum = 0;
      let cN = 0;
      let eSum = 0;
      let eN = 0;
      for (let i = 0; i < n; i++) {
        const p = i * 4;
        const l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) | 0;
        lum[i] = l;
        total += l;
        sq += l * l;
        if (l > 250) blown++;
        const x = i % W;
        const y = (i / W) | 0;
        if (x >= W * 0.3 && x < W * 0.7 && y >= H * 0.2 && y < H * 0.8) {
          cSum += LIN[l];
          cN++;
        } else {
          eSum += LIN[l];
          eN++;
        }
      }
      const mean = total / n;

      // Real sensors always have noise, so two live frames are never identical.
      if (prevLum && prevLum.length === n) {
        let d = 0;
        for (let i = 0; i < n; i++) d += Math.abs(lum[i] - prevLum[i]);
        if (d / n >= 0.05) stillSince = 0;
        else if (!stillSince) stillSince = performance.now();
      }
      prevLum = lum;

      let face;
      try {
        face = await findFace(canvas);
      } catch {
        face = undefined;
      }
      if (seq !== openSeq) return;

      if (face) noFaceSince = 0;
      else if (face === null && !noFaceSince) noFaceSince = performance.now();

      const out = {
        W,
        H,
        lum,
        mean,
        sd: Math.sqrt(Math.max(0, sq / n - mean * mean)),
        blown: blown / n,
        centreStops: stopsBetween(cN ? cSum / cN : 1, eN ? eSum / eN : 1),
        face: face || null,
        detector: faceDetectorState(),
      };
      if (face) Object.assign(out, faceLight(lum, W, H, face));
      last = out;
    } finally {
      busy = false;
    }
  }

  // Lighting measured on the face itself. The detector's box includes hair and
  // some background, so the skin is the inner part of it.
  function faceLight(lum, W, H, f) {
    const x0 = Math.round(clamp(f.x + f.w * 0.18, 0, 1) * W);
    const x1 = Math.round(clamp(f.x + f.w * 0.82, 0, 1) * W);
    const y0 = Math.round(clamp(f.y + f.h * 0.2, 0, 1) * H);
    const y1 = Math.round(clamp(f.y + f.h * 0.95, 0, 1) * H);
    const mid = (x0 + x1) >> 1;

    let left = 0;
    let right = 0;
    let sumL = 0;
    let sumR = 0;
    let nL = 0;
    let nR = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const l = lum[y * W + x];
        if (x < mid) {
          left += LIN[l];
          sumL += l;
          nL++;
        } else {
          right += LIN[l];
          sumR += l;
          nR++;
        }
      }
    }
    if (!nL || !nR) return { faceLum: null, backStops: null, sideStops: null };
    // Judge exposure on the lit side: a shadow on one half is its own problem
    // (side light), not a reason to call the whole face dark or backlit.
    const litLeft = left / nL >= right / nR;
    const litLin = litLeft ? left / nL : right / nR;

    // Background = around and above the head, not the body below it.
    const bx0 = (f.x - f.w * 0.3) * W;
    const bx1 = (f.x + f.w * 1.3) * W;
    const by0 = (f.y - f.h * 0.3) * H;
    const by1 = Math.min(H, (f.y + f.h) * H);
    let bg = 0;
    let nB = 0;
    for (let y = 0; y < by1; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= bx0 && x < bx1 && y >= by0) continue;
        bg += LIN[lum[y * W + x]];
        nB++;
      }
    }

    return {
      faceLum: litLeft ? sumL / nL : sumR / nR,
      backStops: nB > W * 4 ? stopsBetween(bg / nB, litLin) : null,
      sideStops: Math.abs(stopsBetween(left / nL, right / nR)),
    };
  }

  // ---------- assessment ----------

  function frameStats() {
    const counting = !fallbackTimer;
    if (!counting || performance.now() - openedAt < FPS_WINDOW_MS || frameTimes.length < 2) {
      return { fps: null, gap: null };
    }
    const newest = frameTimes[frameTimes.length - 1];
    frameTimes = frameTimes.filter((t) => newest - t < FPS_WINDOW_MS);
    let gap = 0;
    for (let i = 1; i < frameTimes.length; i++) gap = Math.max(gap, frameTimes[i] - frameTimes[i - 1]);
    return { fps: frameTimes.length / (FPS_WINDOW_MS / 1000), gap };
  }

  // Every problem found, most urgent first. Each one also colours its chip.
  function assess() {
    const now = performance.now();
    const { fps, gap } = frameStats();
    const checks = { image: "unknown", light: "unknown", framing: "unknown", smooth: "unknown" };
    const found = [];
    const add = (check, level, key, title, tip, extra = {}) => {
      found.push({ check, level, key, title, tip, ...extra });
      if (RANK[level] > RANK[checks[check]]) checks[check] = level;
    };
    const done = () => ({ checks, found, fps, gap });

    if (ended) add("image", "bad", "ended", "Camera disconnected", `${nameOf(deviceId)} was unplugged, or another app took it.`, { urgent: true });
    else if (muted) add("image", "bad", "muted", "Camera paused by the system", "Another app took it, or the lid is closed.", { urgent: true });
    else if (!fallbackTimer && now - openedAt > FROZEN_MS && now - (lastFrameAt || openedAt) > FROZEN_MS)
      add("image", "bad", "frozen", "Frozen", "No new frame for over 2 s. Close other apps using the camera, or unplug and replug it.");
    if (found.length) return done();

    if (!last) return { ...done(), starting: true };

    const { mean, sd, blown, face, faceLum, backStops, sideStops, centreStops, detector } = last;
    if (mean < 12 && sd < 6) {
      add("image", "bad", "black", "Black image", "The privacy shutter is closed, the lens is covered, or the camera is disabled.");
      return done();
    }
    if (stillSince && now - stillSince >= STILL_MS) {
      add("image", "warn", "still", "A still picture, not live video", "Probably a virtual camera showing a placeholder. Pick your real webcam above.");
    } else checks.image = "ok";

    // Light: on the face when we have one, on the whole frame otherwise.
    checks.light = "ok";
    if (face && faceLum !== null) {
      const factor = (s) => `${Math.round(Math.pow(2, s))}×`;
      const behind = backStops !== null ? backStops : 0;
      // Name the cause when there is one: "too dark" and "backlit" need different fixes.
      if (faceLum < FACE_DARK && behind >= 1.5)
        add("light", "bad", "backlit", "Backlit: your face is in the dark", `Your face is at ${faceLum.toFixed(0)}/255 and the background is ${behind.toFixed(1)} stops (${factor(behind)}) brighter. Face the window, or close the blind behind you.`);
      else if (faceLum < FACE_DARK)
        add("light", "bad", "dark", "Your face is too dark", `Face at ${faceLum.toFixed(0)}/255. Put a lamp or the window in front of you, not behind.`);
      else if (behind >= BACKLIT_STOPS && faceLum < BACKLIT_FACE_MAX)
        add("light", "warn", "backlit", "Backlit", `The background is ${behind.toFixed(1)} stops (${factor(behind)}) brighter than your face. Face the window, or close the blind behind you.`);
      if (faceLum > FACE_BRIGHT)
        add("light", "warn", "bright", "Washed out", "Too much direct light on your face. Close a blind or move out of the sun.");
      if (sideStops !== null && sideStops >= SIDE_STOPS)
        add("light", "warn", "side", "Half your face is in shadow", `One side is ${sideStops.toFixed(1)} stops (${factor(sideStops)}) darker. Turn so the light comes from in front of you.`);
    } else {
      if (mean < 45) add("light", "bad", "dark", "Too dark", `The picture averages ${mean.toFixed(0)}/255. Turn on a light in front of you.`);
      else if (centreStops < -1.2) add("light", "warn", "backlit", "Probably backlit", "The edges are much brighter than the middle. Face the window instead.");
      else if (blown > 0.25 || mean > 215) add("light", "warn", "bright", "Washed out", "Too much direct light. Close a blind or move away from the window.");
    }

    // Framing needs the detector.
    if (detector === "ready") {
      checks.framing = "ok";
      if (!face && noFaceSince && now - noFaceSince >= NO_FACE_MS) {
        add("framing", "warn", "noface", "Can't see your face", "Sit in front of the camera, or check that it points at you.");
      } else if (face) {
        const cx = face.x + face.w / 2;
        const cy = face.y + face.h / 2;
        if (face.w < FACE_SMALL)
          add("framing", "warn", "far", "Far from the camera", `Your face fills ${pct(face.w)} of the width; about 20–35% looks natural. Move closer.`, { guide: true });
        else if (face.w > FACE_LARGE)
          add("framing", "warn", "close", "Very close to the camera", "Move back a little so your head and shoulders fit.", { guide: true });
        if (face.y < 0.005)
          add("framing", "warn", "cut", "Head cut off at the top", "Tilt the screen forward a little.", { guide: true });
        else if (cy > FACE_LOW)
          add("framing", "warn", "low", "Sitting low in the picture", "Tilt the screen back or raise the laptop: your eyes belong about a third from the top.", { guide: true });
        if (Math.abs(cx - 0.5) > FACE_SIDE)
          add("framing", "warn", "aside", "Off to the side", "Move to the middle of the picture.", { guide: true });
      }
    }

    if (fps !== null) {
      checks.smooth = "ok";
      if (fps < FPS_CHOPPY)
        add("smooth", "warn", "choppy", "Choppy video", `${fps.toFixed(0)} fps. Usually low light (the camera slows down to gather it) or a busy computer.`);
    }

    return done();
  }

  // ---------- rendering ----------

  function render(r) {
    for (const [k, el] of Object.entries(ui.checks)) el.dataset.level = r.checks[k];

    if (r.starting) {
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Starting the camera…";
      ui.tip.textContent = "";
      setStatus("busy", "starting");
      return;
    }

    const top = r.found[0];
    if (top) {
      ui.verdict.className = `verdict ${top.level}`;
      ui.verdict.textContent = top.title;
      const also = r.found.slice(1).map((f) => f.title.toLowerCase());
      ui.tip.textContent = top.tip + (also.length ? ` Also: ${also.join(", ")}.` : "");
      setStatus(top.level, top.key);
    } else {
      ui.verdict.className = "verdict ok";
      ui.verdict.textContent = "Looks good";
      const framed = r.checks.framing === "ok" ? "well lit and framed" : "well lit";
      ui.tip.textContent = `Face ${framed}${r.fps ? `, ${r.fps.toFixed(0)} fps` : ""}.`;
      setStatus("ok", "ok");
    }
  }

  function renderDetails(r) {
    if (frameSize) ui.res.textContent = `${frameSize.w}×${frameSize.h}`;
    ui.fps.textContent = r.fps === null ? "—" : `${r.fps.toFixed(0)} fps · gap ${Math.round(r.gap)} ms`;
    if (!last) return;
    const { face, detector, faceLum, backStops, sideStops } = last;
    ui.face.textContent =
      detector === "loading" || detector === "idle"
        ? "loading detector…"
        : detector === "unavailable"
          ? "detector unavailable"
          : face
            ? `${pct(face.w)} wide, ${pct(face.y + face.h / 2)} down`
            : "not found";
    ui.light.textContent = face && faceLum !== null ? `${faceLum.toFixed(0)}/255 (lit side)` : "—";
    ui.back.textContent =
      face && backStops !== null
        ? Math.abs(backStops) < 0.5
          ? "even"
          : `${backStops > 0 ? "+" : ""}${backStops.toFixed(1)} stops`
        : "—";
    ui.side.textContent = face && sideStops !== null ? `${sideStops.toFixed(1)} stops` : "—";
  }

  // Drawn in camera coordinates; the canvas is mirrored by CSS like the video.
  function drawOverlay(r) {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(ui.overlay.clientWidth * dpr);
    const ch = Math.round(ui.overlay.clientHeight * dpr);
    if (!cw || !ch) return;
    if (ui.overlay.width !== cw || ui.overlay.height !== ch) {
      ui.overlay.width = cw;
      ui.overlay.height = ch;
    }
    octx.clearRect(0, 0, cw, ch);
    if (!last || r.checks.image === "bad") return;

    const lightIssue = r.found.find((f) => f.check === "light");

    // Zebra stripes on blown-out areas, as on a pro camera: shows *where* the
    // problem light is, so the fix (that window, that lamp) is obvious. Only
    // when light is the problem: a bright wall behind a well-lit face is fine.
    if (lightIssue?.key === "backlit" || lightIssue?.key === "bright") {
      const { W, H, lum } = last;
      if (mask.width !== W || mask.height !== H) {
        mask.width = W;
        mask.height = H;
      }
      const img = mctx.createImageData(W, H);
      for (let i = 0; i < lum.length; i++) if (lum[i] > 245) img.data[i * 4 + 3] = 255;
      mctx.putImageData(img, 0, 0);

      zebra.width = cw;
      zebra.height = ch;
      zctx.imageSmoothingEnabled = true;
      zctx.drawImage(mask, 0, 0, cw, ch);
      zctx.globalCompositeOperation = "source-in";
      const step = 10 * dpr;
      zctx.strokeStyle = "rgba(255, 196, 60, 0.85)";
      zctx.lineWidth = 3 * dpr;
      zctx.beginPath();
      for (let x = -ch; x < cw; x += step) {
        zctx.moveTo(x, ch);
        zctx.lineTo(x + ch, 0);
      }
      zctx.stroke();
      zctx.globalCompositeOperation = "source-over";
      octx.drawImage(zebra, 0, 0);
    }

    const face = last.face;
    const framingIssue = r.found.find((f) => f.check === "framing" && f.guide);

    // Where the face should go, only when it is not there.
    if (framingIssue) {
      const aspect = cw / ch;
      const gw = 0.26 * cw;
      const gh = Math.min(0.62, 0.26 * aspect * 1.15) * ch;
      const gx = 0.5 * cw - gw / 2;
      const gy = 0.42 * ch - gh / 2;
      octx.setLineDash([6 * dpr, 6 * dpr]);
      octx.lineWidth = 1.5 * dpr;
      octx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      octx.beginPath();
      octx.roundRect(gx, gy, gw, gh, 14 * dpr);
      octx.stroke();
      octx.setLineDash([]);
    }

    if (face) {
      const issue = framingIssue || lightIssue;
      octx.strokeStyle = issue ? (issue.level === "bad" ? "#ef5f5f" : "#e8b23c") : "#35c88a";
      octx.lineWidth = 2.5 * dpr;
      octx.lineCap = "round";
      const x = face.x * cw;
      const y = face.y * ch;
      const w = face.w * cw;
      const h = face.h * ch;
      const c = Math.min(w, h) * 0.22;
      octx.beginPath();
      for (const [px, py, dx, dy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ]) {
        octx.moveTo(px, py + dy * c);
        octx.lineTo(px, py);
        octx.lineTo(px + dx * c, py);
      }
      octx.stroke();
    }
  }

  function evaluate() {
    const r = assess();
    renderDetails(r);
    drawOverlay(r); // live, not smoothed: it follows you as you move

    const key = r.starting ? "starting" : r.found[0]?.key ?? "ok";
    recent.push(key);
    if (recent.length > 3) recent.shift();
    const agreed = recent.filter((k) => k === key).length >= 2;
    if (!(r.found[0]?.urgent || agreed || shown === null || shown === "starting")) return;
    shown = key;
    render(r);
  }

  // ---------- frames ----------

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
        // Capture time, not arrival time: a busy panel must not look like a bad camera.
        frameTimes.push(frame.timestamp / 1000);
        if (frameTimes.length > 240) frameTimes.splice(0, frameTimes.length - 240);
        if (!busy && now - lastSampleAt >= SAMPLE_MS) {
          lastSampleAt = now;
          grab(frame, frame.displayWidth, frame.displayHeight);
          frame.close();
          analyse(seq);
        } else {
          frame.close();
        }
      }
    } catch {
      /* reader cancelled on stop or device switch */
    }
  }

  // Older Chrome without MediaStreamTrackProcessor: sample the <video>.
  function readVideo(seq) {
    fallbackTimer = setInterval(() => {
      if (busy || ui.video.readyState < 2) return;
      grab(ui.video, ui.video.videoWidth, ui.video.videoHeight);
      analyse(seq);
    }, SAMPLE_MS);
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
    octx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
  }

  async function open(id) {
    closeStream();
    const seq = openSeq;
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        // Ask for 720p: what Meet sends, and it shows what the camera can really do.
        width: { ideal: 1280 },
        height: { ideal: 720 },
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
    lastSampleAt = 0;
    busy = false;
    frameSize = null;
    prevLum = null;
    stillSince = 0;
    noFaceSince = 0;
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
    else readVideo(seq);

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
        ui.verdict.textContent = "No camera";
        ui.tip.textContent = `${lostName} was disconnected and no other camera is available.`;
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
    ui.tip.textContent = e.hint;
    for (const el of Object.values(ui.checks)) el.dataset.level = "unknown";
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
      ui.tip.textContent = "";
      loadFaceDetector(); // in the background; framing waits for it
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
