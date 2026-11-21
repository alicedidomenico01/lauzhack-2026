// All the logic of this demo lives here: sampling the microphone, turning the
// samples into a verdict, and (partly) acting on it.
//
// Nothing leaves this panel. There is no backend, no analytics, no storage.

const el = (id) => document.getElementById(id);

const SPEECH_DB = -45; // dBFS: above this we consider it "sound"
const PASS_FRAMES = 4; // 4 x 100 ms of sound, so a single click does not pass
const CHECK_MS = 3000;
const SAMPLE_MS = 100;

let stream = null;
let ctx = null;
let analyser = null;
let timeBuf = null;
let rafId = 0;
let devices = [];
let currentId = null;
let checking = false;

/* ---------- audio plumbing ---------- */

async function openInput(deviceId) {
  stopInput();

  const constraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  currentId = deviceId ?? null;

  ctx = new AudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  timeBuf = new Float32Array(analyser.fftSize);

  await ctx.resume().catch(() => {});
  startMeter();
}

function stopInput() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close().catch(() => {});
  stream = null;
  ctx = null;
  analyser = null;
  timeBuf = null;
  setMeter(0, null);
}

function readDb() {
  if (!analyser) return null;
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
  const rms = Math.sqrt(sum / timeBuf.length);
  if (rms === 0) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

function startMeter() {
  const loop = () => {
    const db = readDb();
    if (db !== null) {
      // -70..-10 dBFS mapped to 0..100% of the bar
      const pct = Math.min(100, Math.max(0, ((db + 70) / 60) * 100));
      setMeter(pct, db);
    }
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

function setMeter(pct, db) {
  el("meterFill").style.width = `${pct}%`;
  el("level").textContent = db === null ? "—" : `${db.toFixed(0)} dBFS`;
  const state = el("state");
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

/* ---------- device list ---------- */

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  devices = all.filter((d) => d.kind === "audioinput");

  const select = el("device");
  select.innerHTML = "";
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 6)})`;
    select.appendChild(opt);
  }

  if (currentId) select.value = currentId;

  el("deviceNote").textContent =
    devices.length > 1
      ? `${devices.length} inputs found. A dead one is usually a dead one — switch and retest.`
      : "Only one input found. Plug in a headset to make the demo interesting.";
}

/* ---------- the check ---------- */

function labelFor(deviceId) {
  const d = devices.find((x) => x.deviceId === deviceId);
  return d?.label || "this microphone";
}

async function runCheck() {
  if (checking || !analyser) return;
  checking = true;
  el("check").disabled = true;
  el("result").hidden = true;

  let peak = -100;
  let frames = 0;

  const timer = setInterval(() => {
    const db = readDb();
    if (db === null) return;
    if (db > peak) peak = db;
    if (db > SPEECH_DB) frames++;
  }, SAMPLE_MS);

  await new Promise((r) => setTimeout(r, CHECK_MS));
  clearInterval(timer);

  checking = false;
  el("check").disabled = false;

  const passed = frames >= PASS_FRAMES;
  showResult(passed, peak);
}

function showResult(passed, peak) {
  const result = el("result");
  const title = el("resultTitle");
  const body = el("resultBody");
  const retry = el("retry");

  result.hidden = false;
  result.classList.toggle("ok", passed);
  result.classList.toggle("bad", !passed);

  if (passed) {
    title.textContent = "Your microphone works";
    body.textContent = `Peak ${peak.toFixed(0)} dBFS on ${labelFor(
      currentId
    )}. Nothing to fix — go join the call.`;
    retry.hidden = true;
    return;
  }

  title.textContent = "No sound detected";
  body.textContent = `We heard nothing on ${labelFor(
    currentId
  )} for 3 seconds. If you spoke, this input is dead, muted at system level, or the wrong device.`;

  // The one action we can actually take: try another input ourselves.
  const other = devices.find((d) => d.deviceId !== currentId);
  if (other) {
    retry.hidden = false;
    retry.textContent = `Test ${other.label || "another input"} instead`;
    retry.onclick = async () => {
      await openInput(other.deviceId);
      el("device").value = other.deviceId;
      await runCheck();
      el("resultBody").textContent +=
        " If this one works, pick it in Meet (⋮ → Settings → Audio).";
    };
  } else {
    retry.hidden = true;
  }
}

/* ---------- wiring ---------- */

el("device").addEventListener("change", async (e) => {
  await openInput(e.target.value);
  el("result").hidden = true;
});

el("check").addEventListener("click", runCheck);

// Chrome can start the AudioContext suspended until the page is interacted with.
document.addEventListener("click", () => {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
});

window.addEventListener("unload", stopInput);

(async function init() {
  try {
    // One request so device labels become readable, then release it.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());

    await refreshDevices();
    const preferred =
      devices.find((d) => d.deviceId === "default") ?? devices[0];
    if (preferred) {
      el("device").value = preferred.deviceId;
      await openInput(preferred.deviceId);
    }
  } catch (err) {
    el("deviceNote").textContent =
      err.name === "NotAllowedError"
        ? "Microphone blocked. Allow it for this extension and reload."
        : `Could not open a microphone: ${err.message}`;
    el("check").disabled = true;
  }
})();
