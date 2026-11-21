// Microphone: runs as soon as the panel opens. No buttons.
// The only action it can take on its own is trying the other input.

import { permissionHelp } from "../ui/permission.js";

const SPEECH_DB = -45;
const LISTEN_MS = 12000;
const QUIET_MS = 3000;

export function mountAudio(root, { setStatus }) {
  root.innerHTML = `
    <select data-device aria-label="Microphone"></select>
    <div class="meter"><div class="meter-fill" data-fill></div></div>
    <div class="meter-readout">
      <span data-level>—</span>
      <span class="state" data-state>idle</span>
    </div>
    <p class="verdict" data-verdict></p>
    <p class="hint" data-hint></p>
  `;

  const ui = {
    device: root.querySelector("[data-device]"),
    fill: root.querySelector("[data-fill]"),
    level: root.querySelector("[data-level]"),
    state: root.querySelector("[data-state]"),
    verdict: root.querySelector("[data-verdict]"),
    hint: root.querySelector("[data-hint]"),
  };

  let stream = null;
  let ctx = null;
  let analyser = null;
  let buf = null;
  let rafId = 0;
  let evalTimer = 0;
  let devices = [];
  let deviceId = null;
  let lastDb = null;
  let peak = -100;
  let heardAt = 0;
  let startedAt = 0;
  let autoTried = false;
  let active = false;

  function paint(db) {
    ui.fill.style.width = `${Math.min(100, Math.max(0, ((db + 70) / 60) * 100))}%`;
    ui.level.textContent = `${db.toFixed(0)} dBFS`;
    ui.state.textContent = db > SPEECH_DB ? "sound" : "silent";
    ui.state.classList.toggle("live", db > SPEECH_DB);
  }

  function readDb() {
    if (!analyser) return null;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return rms === 0 ? -100 : Math.max(-100, 20 * Math.log10(rms));
  }

  function labelFor(id) {
    return devices.find((d) => d.deviceId === id)?.label || "this input";
  }

  async function open(id) {
    closeStream();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id } } : true,
    });
    deviceId = id ?? null;

    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    buf = new Float32Array(analyser.fftSize);
    await ctx.resume().catch(() => {});

    const loop = () => {
      const db = readDb();
      if (db !== null) {
        lastDb = db;
        if (db > peak) peak = db;
        if (db > SPEECH_DB) heardAt = Date.now();
        paint(db);
      }
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function closeStream() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = null;
    ctx = null;
    analyser = null;
    lastDb = null;
  }

  function evaluate() {
    const now = Date.now();
    const recent = now - heardAt < QUIET_MS;

    if (recent) {
      ui.verdict.className = "verdict ok";
      ui.verdict.textContent = `Picking you up: peak ${peak.toFixed(0)} dBFS on ${labelFor(deviceId)}.`;
      setStatus("audio", "ok", "ok");
      return;
    }

    if (now - startedAt < LISTEN_MS) {
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Listening… say a few words.";
      setStatus("audio", "busy", "listening");
      return;
    }

    const other = devices.find((d) => d.deviceId !== deviceId);
    if (!autoTried && other) {
      autoTried = true;
      const failed = labelFor(deviceId);
      open(other.deviceId)
        .then(() => {
          ui.device.value = other.deviceId;
          startedAt = Date.now();
          ui.hint.textContent = `${failed} was silent, testing ${labelFor(other.deviceId)}. Meet still uses ${failed} — switch it in Meet's audio settings.`;
        })
        .catch(() => {});
      return;
    }

    ui.verdict.className = "verdict bad";
    ui.verdict.textContent = `No sound in ${LISTEN_MS / 1000} s on ${labelFor(deviceId)}. Muted, unplugged, or the wrong device.`;
    setStatus("audio", "bad", "no signal");
  }

  ui.device.addEventListener("change", async (e) => {
    await open(e.target.value);
    startedAt = Date.now();
    peak = -100;
    heardAt = 0;
  });

  return {
    async start() {
      if (active) return;
      active = true;
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());

        const all = await navigator.mediaDevices.enumerateDevices();
        devices = all.filter((d) => d.kind === "audioinput");
        ui.device.innerHTML = "";
        for (const d of devices) {
          const opt = document.createElement("option");
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
          ui.device.appendChild(opt);
        }

        const preferred =
          devices.find((d) => d.deviceId === "default") ?? devices[0];
        if (!preferred) throw new Error("No microphone found");

        ui.device.value = preferred.deviceId;
        await open(preferred.deviceId);
        startedAt = Date.now();
        peak = -100;
        heardAt = 0;
        autoTried = false;
        evalTimer = setInterval(evaluate, 300);
      } catch (err) {
        active = false;
        setStatus("audio", "bad", "blocked");
        ui.verdict.className = "verdict bad";
        ui.verdict.textContent =
          err.name === "NotAllowedError"
            ? "Microphone blocked."
            : `Could not open a microphone: ${err.message}`;
        if (err.name === "NotAllowedError") permissionHelp(root, "microphone");
      }
    },
    stop() {
      active = false;
      clearInterval(evalTimer);
      evalTimer = 0;
      closeStream();
    },
  };
}
