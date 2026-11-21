// Setup Check — all logic runs here, inside the side panel.
// No backend, no storage, no analytics. Every number shown is measured live.

const $ = (id) => document.getElementById(id);
const SPEECH_DB = -45; // dBFS considered "sound"
const PASS_FRAMES = 4; // 4 x 100 ms, so a single click cannot pass
const CHECK_MS = 3000;
const SAMPLE_MS = 100;

/* ------------------------------------------------------------------ */
/* accordion                                                          */
/* ------------------------------------------------------------------ */

document.querySelectorAll(".row-head").forEach((head) => {
  head.addEventListener("click", () => {
    const row = head.closest(".row");
    const open = row.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
  });
});

function setStatus(key, level, text) {
  const pill = document.querySelector(`.row[data-key="${key}"] [data-status]`);
  if (!pill) return;
  pill.className = `row-status${level ? ` ${level}` : ""}`;
  pill.textContent = text;
}

function setVerdict(id, level, text) {
  const el = $(id);
  el.className = `verdict${level ? ` ${level}` : ""}`;
  el.textContent = text;
}

document.querySelectorAll("[data-run]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.run;
    if (kind === "network") measureNetwork(btn);
    if (kind === "audio") runAudioCheck(btn);
    if (kind === "camera") checkCamera(btn);
    if (kind === "memory") checkMachine(btn);
  });
});

async function withButton(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* network                                                            */
/* ------------------------------------------------------------------ */

// A 204 from Google's captive-portal endpoint: tiny body, anycast, no CORS
// needed because we only measure the round trip, not the payload.
const PROBE_URL = "https://www.gstatic.com/generate_204";
const PROBES = 6;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function jitter(xs) {
  if (xs.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return sum / (xs.length - 1);
}

async function measureNetwork(btn) {
  setStatus("network", "busy", "measuring");
  setVerdict("net-verdict", "", "");
  $("net-hint").textContent = "";

  await withButton(btn, async () => {
    const times = [];
    let fails = 0;

    for (let i = 0; i < PROBES; i++) {
      const t0 = performance.now();
      try {
        await fetch(`${PROBE_URL}?n=${Math.random()}`, {
          mode: "no-cors",
          cache: "no-store",
        });
        times.push(performance.now() - t0);
      } catch {
        fails++;
      }
    }

    // The first request pays DNS + TCP + TLS, so it is not a fair sample.
    const samples = times.slice(1);
    if (samples.length < 2) {
      $("net-rtt").textContent = "—";
      $("net-jitter").textContent = "—";
      $("net-loss").textContent = `${fails}/${PROBES}`;
      setStatus("network", "bad", "offline");
      setVerdict(
        "net-verdict",
        "bad",
        "No reply from the probe. You are offline or something is blocking it."
      );
      return;
    }

    const rtt = median(samples);
    const jit = jitter(samples);
    const conn = navigator.connection || {};

    $("net-rtt").textContent = `${rtt.toFixed(0)} ms`;
    $("net-jitter").textContent = `${jit.toFixed(0)} ms`;
    $("net-loss").textContent = `${fails}/${PROBES}`;
    $("net-type").textContent =
      [conn.effectiveType, conn.downlink ? `~${conn.downlink} Mb/s` : null]
        .filter(Boolean)
        .join(" · ") || "unknown";

    let level = "ok";
    let text = `Stable: ${rtt.toFixed(0)} ms round trip. Fine for a call.`;
    if (rtt > 300 || fails > 0) {
      level = "bad";
      text = `Unreliable: ${rtt.toFixed(0)} ms with ${fails} lost probe(s). Expect dropouts.`;
    } else if (rtt > 120 || jit > 60) {
      level = "warn";
      text = `Usable but shaky: ${rtt.toFixed(0)} ms, ${jit.toFixed(
        0
      )} ms jitter. Audio will glitch.`;
    }

    setStatus("network", level, level === "ok" ? "ok" : "attention");
    setVerdict("net-verdict", level, text);
    $("net-hint").textContent =
      "A browser cannot see nearby Wi-Fi networks or their signal strength — " +
      "that needs a local helper. Run this once per network to compare them.";
  });
}

/* ------------------------------------------------------------------ */
/* audio                                                              */
/* ------------------------------------------------------------------ */

let audioStream = null;
let audioCtx = null;
let analyser = null;
let timeBuf = null;
let rafId = 0;
let audioDevices = [];
let currentDeviceId = null;
let checkingAudio = false;

async function openInput(deviceId) {
  stopInput();
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  currentDeviceId = deviceId ?? null;

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(audioStream).connect(analyser);
  timeBuf = new Float32Array(analyser.fftSize);

  await audioCtx.resume().catch(() => {});
  startMeter();
}

function stopInput() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  audioStream = null;
  audioCtx = null;
  analyser = null;
  timeBuf = null;
  paintMeter(0, null);
}

function readDb() {
  if (!analyser) return null;
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
  const rms = Math.sqrt(sum / timeBuf.length);
  return rms === 0 ? -100 : Math.max(-100, 20 * Math.log10(rms));
}

function startMeter() {
  const loop = () => {
    const db = readDb();
    if (db !== null) paintMeter(Math.min(100, Math.max(0, ((db + 70) / 60) * 100)), db);
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

function paintMeter(pct, db) {
  $("meter-fill").style.width = `${pct}%`;
  $("mic-level").textContent = db === null ? "—" : `${db.toFixed(0)} dBFS`;
  const state = $("mic-state");
  if (db === null) {
    state.textContent = "idle";
    state.classList.remove("live");
  } else if (db > SPEECH_DB) {
    state.textContent = "sound";
    state.classList.add("live");
  } else {
    state.textContent = "silent";
    state.classList.remove("live");
  }
}

function labelFor(deviceId) {
  return audioDevices.find((d) => d.deviceId === deviceId)?.label || "this input";
}

async function refreshAudioDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  audioDevices = all.filter((d) => d.kind === "audioinput");

  const select = $("audio-device");
  select.innerHTML = "";
  for (const d of audioDevices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
    select.appendChild(opt);
  }
  if (currentDeviceId) select.value = currentDeviceId;
}

async function captureFor(ms) {
  let peak = -100;
  let frames = 0;
  const timer = setInterval(() => {
    const db = readDb();
    if (db === null) return;
    if (db > peak) peak = db;
    if (db > SPEECH_DB) frames++;
  }, SAMPLE_MS);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(timer);
  return { peak, frames };
}

async function runAudioCheck(btn, allowRetry = true) {
  if (checkingAudio || !analyser) return;
  checkingAudio = true;
  setStatus("audio", "busy", "listening");
  setVerdict("mic-verdict", "", "");
  $("mic-hint").textContent = "";

  await withButton(btn, async () => {
    const { peak, frames } = await captureFor(CHECK_MS);
    const passed = frames >= PASS_FRAMES;

    if (passed) {
      setStatus("audio", "ok", "ok");
      setVerdict(
        "mic-verdict",
        "ok",
        `Picking you up: peak ${peak.toFixed(0)} dBFS on ${labelFor(currentDeviceId)}.`
      );
      return;
    }

    const other = audioDevices.find((d) => d.deviceId !== currentDeviceId);

    if (allowRetry && other) {
      // The one action we can really take: try the other input ourselves.
      const failedLabel = labelFor(currentDeviceId);
      await openInput(other.deviceId);
      $("audio-device").value = other.deviceId;
      checkingAudio = false;
      await runAudioCheck(btn, false);
      $("mic-hint").textContent =
        `${failedLabel} produced no sound. If the test above passed, ` +
        `switch Meet to ${labelFor(currentDeviceId)} (⋮ → Settings → Audio) — ` +
        "Meet does not follow this panel.";
      return;
    }

    setStatus("audio", "bad", "no signal");
    setVerdict(
      "mic-verdict",
      "bad",
      `No sound at all on ${labelFor(currentDeviceId)} in 3 s. It is muted at system level, unplugged, or the wrong device.`
    );
    $("mic-hint").textContent = other
      ? "Both inputs were silent. Check the hardware mute switch."
      : "Only one input exists. Plug in a headset to compare.";
  });

  checkingAudio = false;
}

$("audio-device").addEventListener("change", async (e) => {
  await openInput(e.target.value);
  setVerdict("mic-verdict", "", "");
});

/* ------------------------------------------------------------------ */
/* camera                                                             */
/* ------------------------------------------------------------------ */

async function checkCamera(btn) {
  setStatus("camera", "busy", "checking");
  setVerdict("cam-verdict", "", "");
  $("cam-hint").textContent = "";

  await withButton(btn, async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } },
      });
    } catch (err) {
      setStatus("camera", "bad", err.name === "NotAllowedError" ? "blocked" : "error");
      setVerdict(
        "cam-verdict",
        "bad",
        err.name === "NotAllowedError"
          ? "Camera permission is blocked. Allow it and reload."
          : `No camera available: ${err.message}`
      );
      return;
    }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;

    try {
      await video.play();
      // Let auto-exposure settle before we sample.
      await new Promise((r) => setTimeout(r, 400));

      const canvas = $("cam-preview");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let total = 0;
      let centerSum = 0;
      let centerN = 0;
      let edgeSum = 0;
      let edgeN = 0;

      const w = canvas.width;
      const h = canvas.height;
      const cx0 = w * 0.3;
      const cx1 = w * 0.7;
      const cy0 = h * 0.2;
      const cy1 = h * 0.8;

      for (let p = 0; p < data.length; p += 4) {
        const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
        total += lum;
        const idx = p / 4;
        const x = idx % w;
        const y = (idx / w) | 0;
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
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

      let level = "ok";
      let text = `Looks fine: ${settings.width}×${settings.height}, exposure ${mean.toFixed(0)}/255.`;

      if (mean < 45) {
        level = "bad";
        text = `Too dark (${mean.toFixed(0)}/255). The other side sees a silhouette.`;
      } else if (ratio < 0.75) {
        level = "warn";
        text = "Backlit: the light behind you is brighter than your face.";
      }

      setStatus("camera", level, level === "ok" ? "ok" : "attention");
      setVerdict("cam-verdict", level, text);
      $("cam-hint").textContent =
        "Fixes are a light in front of you or a window behind you closed — " +
        "we can only point at it, not change your room.";
    } catch (err) {
      setStatus("camera", "bad", "error");
      setVerdict("cam-verdict", "bad", `Camera opened but produced no frame: ${err.message}`);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  });
}

/* ------------------------------------------------------------------ */
/* memory / machine                                                   */
/* ------------------------------------------------------------------ */

async function measureLag(ms) {
  const drifts = [];
  let last = performance.now();
  const end = last + ms;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const now = performance.now();
    drifts.push(Math.max(0, now - last - 100));
    last = now;
  }
  return drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;
}

async function checkMachine(btn) {
  setStatus("memory", "busy", "checking");
  setVerdict("mem-verdict", "", "");
  $("mem-hint").textContent = "";

  await withButton(btn, async () => {
    const ram = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency;

    $("mem-ram").textContent = ram ? `~${ram} GB` : "hidden";
    $("mem-cores").textContent = cores ? String(cores) : "—";

    const lag = await measureLag(1200);
    $("mem-lag").textContent = `${lag.toFixed(0)} ms/s`;

    let level = "ok";
    let text = "The browser is responsive; nothing is starving the main thread.";
    if (lag > 80) {
      level = "bad";
      text = "The machine is struggling right now — expect frozen calls and laggy typing.";
    } else if (lag > 30) {
      level = "warn";
      text = "Mild stutter. Something is competing for the CPU.";
    }

    setStatus("memory", level, level === "ok" ? "ok" : "attention");
    setVerdict("mem-verdict", level, text);
    $("mem-hint").textContent =
      "A browser cannot read system memory. Real pressure needs a local helper " +
      "(native messaging → vm_stat). Until then, UI lag is our proxy.";
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

document.addEventListener("click", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
});

window.addEventListener("unload", stopInput);

(async function init() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    await refreshAudioDevices();

    const preferred = audioDevices.find((d) => d.deviceId === "default") ?? audioDevices[0];
    if (preferred) {
      $("audio-device").value = preferred.deviceId;
      await openInput(preferred.deviceId);
      setStatus("audio", "", "ready");
    }
  } catch (err) {
    setStatus("audio", "bad", "blocked");
    setVerdict(
      "mic-verdict",
      "bad",
      err.name === "NotAllowedError"
        ? "Microphone blocked. Allow it for this extension and reload."
        : `Could not open a microphone: ${err.message}`
    );
  }

  setStatus("network", "", "not run");
  setStatus("camera", "", "not run");
  setStatus("memory", "", "not run");
})();
