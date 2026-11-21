// Microphone: runs as soon as the panel opens. No buttons.
//
// A level meter alone confuses four different situations. This check tells
// them apart, most of them without the user saying a word:
//   dead input   the device sends digital silence (muted, volume 0, broken)
//   live, idle   it hears the room, nobody has spoken yet: the mic works
//   voice, bad   too quiet, clipping, or a loud background
//   voice, ok
// The only thing it does on its own is test the other physical inputs when
// the current one is dead, and say which one works.

import { permissionHelp } from "../ui/permission.js";
import { distinctDevices, fillSelect, explainMediaError } from "../lib/media.js";
import { helper } from "../lib/central.js";

const DEAD_DB = -85; // a working mic never goes this low: room noise is above it
const DEAD_MS = 2000; // silence this long on one device = it is dead
const ALIVE_MS = 600; // signal for this long after opening = it is alive
const SPEECH_OVER_FLOOR = 10; // dB above the room to count as a voice...
const SPEECH_MIN_DB = -60;
const SPEECH_RUN = 6; // ...for ~100 ms in a row, so key clicks and bumps do not count
const QUIET_DB = -48; // voice peaks below this are hard to hear
const NOISY_DB = -45; // a background this loud is heard by everyone
const CLIP = 0.985;
const CLIP_FRAMES = 3; // clipped frames within the window before we warn
const NUDGE_MS = 6000;
const WINDOW_MS = 5000;

// Raw input on purpose. Echo cancellation, noise suppression and auto gain
// would hide exactly what we measure: a dead input would look "quiet" and a
// noisy room would look clean.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function percentile(xs, p) {
  if (!xs.length) return -100;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export function mountAudio(root, api) {
  const { setStatus, remedy } = api;
  root.innerHTML = `
    <select data-device aria-label="Microphone"></select>
    <div class="meter"><div class="meter-fill" data-fill></div></div>
    <div class="meter-readout">
      <span data-level>—</span>
      <span class="state" data-state>idle</span>
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
        <div><dt>Voice peak</dt><dd data-peak>—</dd></div>
        <div><dt>Room noise</dt><dd data-floor>—</dd></div>
        <div><dt>Clipping</dt><dd data-clip>—</dd></div>
        <div><dt>Input</dt><dd data-input>—</dd></div>
      </dl>
    </details>
  `;

  const ui = {
    device: root.querySelector("[data-device]"),
    fill: root.querySelector("[data-fill]"),
    level: root.querySelector("[data-level]"),
    state: root.querySelector("[data-state]"),
    verdict: root.querySelector("[data-verdict]"),
    hint: root.querySelector("[data-hint]"),
    peak: root.querySelector("[data-peak]"),
    floor: root.querySelector("[data-floor]"),
    clip: root.querySelector("[data-clip]"),
    input: root.querySelector("[data-input]"),
  };

  let active = false;
  let damaged = false; // demo: the input delivers digital silence, like a muted mic
  let allDead = false;
  let devices = [];
  let deviceId = null;
  let manual = false; // the user picked this device: never switch away from it

  // Per-stream state.
  let stream = null;
  let ctx = null;
  let analyser = null;
  let buf = null;
  let rafId = 0;
  let openSeq = 0;
  let openedAt = 0;
  let liveAt = 0;
  let heardAt = 0;
  let voicePeak = -100;
  let floor = -100;
  let frames = [];
  let muted = false;
  let ended = false;
  let floorReady = false;
  let run = 0; // consecutive frames above the voice threshold // no voice detection until we know the room level
  let openErr = null; // why the current device would not open, if it did not
  let switching = false;

  // Per-session state: which devices were tested and what we found.
  let results = new Map(); // deviceId -> "dead" | "alive"
  let scanFrom = null; // the device that was dead when the scan started
  let evalTimer = 0;

  const nameOf = (id, list = devices) => list.find((d) => d.deviceId === id)?.name || "this input";
  const defaultDevice = () => devices.find((d) => d.isDefault) ?? devices[0];

  function verdict(level, text, status, statusText) {
    ui.verdict.className = level ? `verdict ${level}` : "verdict";
    ui.verdict.textContent = text;
    setStatus(status ?? level, statusText);
  }

  function paint(db, isVoice) {
    ui.fill.style.width = `${Math.min(100, Math.max(0, ((db + 70) / 60) * 100))}%`;
    ui.level.textContent = `${db.toFixed(0)} dBFS`;
    ui.state.textContent = isVoice ? "voice" : db > DEAD_DB ? "room" : "nothing";
    ui.state.classList.toggle("live", isVoice);
  }

  function readFrame() {
    analyser.getFloatTimeDomainData(buf);
    if (damaged) buf.fill(0);
    let sum = 0;
    let clipped = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      sum += x * x;
      if (x >= CLIP || x <= -CLIP) clipped++;
    }
    const rms = Math.sqrt(sum / buf.length);
    return {
      db: rms === 0 ? -100 : Math.max(-100, 20 * Math.log10(rms)),
      clip: clipped >= 3,
    };
  }

  function resetStreamState() {
    openedAt = Date.now();
    liveAt = 0;
    heardAt = 0;
    voicePeak = -100;
    floor = -100;
    frames = [];
    muted = false;
    ended = false;
    floorReady = false;
    run = 0;
    openErr = null;
  }

  function closeStream() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    stream = null;
    ctx = null;
    analyser = null;
  }

  async function open(id) {
    const seq = ++openSeq;
    closeStream();
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { ...RAW, deviceId: { exact: id } },
    });
    // A newer open() started while this one was waiting: drop this stream.
    if (seq !== openSeq || !active) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }

    stream = s;
    deviceId = id;
    ui.device.value = id;
    resetStreamState();

    const track = stream.getAudioTracks()[0];
    track.addEventListener("mute", () => (muted = true));
    track.addEventListener("unmute", () => (muted = false));
    track.addEventListener("ended", () => (ended = true));
    const st = track.getSettings();
    ui.input.textContent = [
      st.sampleRate ? `${(st.sampleRate / 1000).toFixed(0)} kHz` : null,
      st.channelCount ? `${st.channelCount} ch` : null,
    ].filter(Boolean).join(" · ") || "—";

    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    buf = new Float32Array(analyser.fftSize);
    await ctx.resume().catch(() => {});

    const loop = () => {
      if (!analyser) return;
      const now = Date.now();
      const { db, clip } = readFrame();
      const threshold = Math.max(floor + SPEECH_OVER_FLOOR, SPEECH_MIN_DB);
      run = floorReady && db > threshold ? run + 1 : 0;
      const isVoice = run >= SPEECH_RUN;

      if (db > DEAD_DB) liveAt = now;
      if (isVoice) {
        heardAt = now;
        if (db > voicePeak) voicePeak = db;
      }
      frames.push({ t: now, db, clip, voice: isVoice });
      paint(db, isVoice);
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  // Switch the test to another device. `keepResults` keeps the scan history.
  async function switchTo(id, { hint = null, keepResults = false } = {}) {
    if (!keepResults) {
      results = new Map();
      scanFrom = null;
    }
    if (hint !== null) ui.hint.textContent = hint;
    switching = true;
    try {
      await open(id);
    } catch (err) {
      // This one would not even open: count it as dead and let evaluate() move on.
      closeStream();
      deviceId = id;
      ui.device.value = id;
      resetStreamState();
      openedAt = 0;
      openErr = err;
      results.set(id, "dead");
    } finally {
      switching = false;
    }
  }

  function evaluate() {
    if (switching) return; // a device is opening; judge it once it is open
    const now = Date.now();
    frames = frames.filter((f) => now - f.t < WINDOW_MS);

    // Room noise = the quiet moments. Speech has gaps, so a low percentile of
    // everything we heard finds the room even while someone talks.
    const quiet = frames.filter((f) => f.db > DEAD_DB).map((f) => f.db);
    floor = percentile(quiet, 0.15);
    if (quiet.length >= 20) floorReady = true;
    const clips = frames.filter((f) => f.clip).length;

    ui.peak.textContent = voicePeak > -100 ? `${voicePeak.toFixed(0)} dBFS` : "—";
    ui.floor.textContent = quiet.length ? `${floor.toFixed(0)} dBFS` : "—";
    ui.clip.textContent = clips ? `${clips} frames` : "none";

    const name = nameOf(deviceId);

    if (ended) {
      verdict("bad", `${name} stopped: unplugged, or taken by the system.`, "bad", "disconnected");
      return;
    }

    const age = now - openedAt;
    const isAlive = liveAt && now - liveAt < DEAD_MS && age > ALIVE_MS;
    const isDead = !openedAt || (age >= DEAD_MS && now - (liveAt || openedAt) >= DEAD_MS);

    if (isAlive && results.get(deviceId) !== "alive") results.set(deviceId, "alive");

    if (isDead) {
      results.set(deviceId, "dead");
      // A simulated damage silences every input: scanning them would prove nothing.
      if (!manual && !damaged) {
        if (scanFrom === null) scanFrom = deviceId;
        // Real devices before virtual ones (OBS, BlackHole...).
        const next = [...devices]
          .sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual))
          .find((d) => !results.has(d.deviceId));
        if (next) {
          verdict("", `${name} sends nothing. Testing ${next.name}…`, "busy", "testing");
          switchTo(next.deviceId, { keepResults: true });
          return;
        }
        // Everything tested and dead: go back to the default and keep watching,
        // so a fix (unmute, volume up) shows up live.
        const def = defaultDevice();
        if (def && deviceId !== def.deviceId) {
          switchTo(def.deviceId, { keepResults: true });
          return;
        }
      }

      if (openErr) {
        const e = explainMediaError(openErr, "microphone");
        verdict("bad", `${name}: ${e.text}`, "bad", e.status);
        ui.hint.textContent = e.hint;
        return;
      }

      const all = devices.length > 1 && devices.every((d) => results.get(d.deviceId) === "dead");
      allDead = all;
      verdict(
        "bad",
        all
          ? "No microphone delivers any signal, not even room noise. That points to the computer: input muted, input volume at 0, or a mute key."
          : `${name} sends digital silence, not even room noise.${muted ? " The system paused this input." : ""} It is muted, its input volume is at 0, or it is broken.`,
        "bad",
        "no signal"
      );
      if (!all && devices.length < 2) ui.hint.textContent = "";
      sync(["dead"]);
      return;
    }

    if (!isAlive) {
      verdict("", "Starting the microphone…", "busy", "starting");
      return;
    }

    // Alive. If we got here through a scan, say what we found.
    const sysDefault = defaultDevice();
    const wrongDefault =
      !!scanFrom && scanFrom !== deviceId && !!sysDefault && sysDefault.deviceId !== deviceId &&
      results.get(sysDefault.deviceId) === "dead";
    const keep = wrongDefault ? ["wrongdefault"] : [];
    if (scanFrom && scanFrom !== deviceId) {
      const def = sysDefault;
      ui.hint.textContent =
        `${nameOf(scanFrom)} sends nothing; ${name} works.` +
        (def && def.deviceId !== deviceId
          ? ` Meet uses the system default (${def.name}) unless you pick ${name} in its audio settings.`
          : "");
    }

    const heard = voicePeak > -100;
    if (!heard) {
      if (floor > NOISY_DB) {
        verdict("warn", `Mic works, but the room is loud (${floor.toFixed(0)} dBFS). Others will hear it.`, "warn", "noisy");
      } else if (age > NUDGE_MS) {
        verdict("", `Mic works: it hears the room. Say a few words to check your voice level.`, "busy", "say something");
      } else {
        verdict("", "Mic works. Listening for your voice…", "busy", "listening");
      }
      sync(keep);
      return;
    }

    if (clips >= CLIP_FRAMES) {
      verdict("warn", "Too loud: your voice is clipping and will sound distorted. Lower the input volume or move back.", "warn", "clipping");
      sync([...keep, "clipping"]);
    } else if (voicePeak < QUIET_DB) {
      verdict("warn", `Too quiet: your voice peaks at ${voicePeak.toFixed(0)} dBFS. Move closer or raise the input volume.`, "warn", "too quiet");
      sync([...keep, "quiet"]);
    } else if (floor > NOISY_DB) {
      verdict("warn", `Your voice comes through, but the room is loud (${floor.toFixed(0)} dBFS). Others will hear it.`, "warn", "noisy");
      sync(keep);
    } else {
      verdict("ok", `Picking you up clearly on ${name}.`, "ok", "ok");
      sync(keep);
    }
  }

  // ---------- remote actions ----------

  const ISSUE_KEYS = ["dead", "wrongdefault", "quiet", "clipping"];

  // Called on every decisive evaluation: raise what is wrong, clear the rest.
  function sync(activeKeys) {
    for (const key of ISSUE_KEYS) {
      if (activeKeys.includes(key)) remedy.raise(issue(key));
      else remedy.clear(key);
    }
  }

  function endDamage() {
    if (!damaged) return;
    damaged = false;
    api.damageChanged?.(false);
  }

  const micAlive = () => liveAt && Date.now() - liveAt < 600;

  async function diagnostics() {
    const st = await helper({ cmd: "audio_status" }, 2500);
    return {
      microphone: nameOf(deviceId),
      systemDefault: defaultDevice()?.name ?? null,
      pickedByHand: manual,
      inputs: devices.map((d) => `${d.name}: ${results.get(d.deviceId) || "untested"}${d.isVirtual ? " (virtual)" : ""}`),
      noiseFloorDb: floorReady ? Math.round(floor) : null,
      voicePeakDb: voicePeak > -100 ? Math.round(voicePeak) : null,
      clippedFrames: frames.filter((f) => f.clip).length,
      trackMutedBySystem: muted,
      inputVolume: st ? st.input_volume ?? null : "unknown (no helper)",
      input: ui.input.textContent,
      simulatedDamage: damaged,
    };
  }

  function volumeStep(sign) {
    return {
      title: sign > 0 ? "Raise the microphone input volume" : "Lower the microphone input volume",
      detail: (p) => `By ${p.params.step ?? 20} points${p.execution === "real" ? "" : " (simulated)"}.`,
      async run(p) {
        const delta = sign * (Number(p.params.step) || 20);
        const res = p.execution === "real" ? await helper({ cmd: "set_input_volume", delta }) : null;
        // Judge the voice again from scratch at the new level.
        voicePeak = -100;
        frames = [];
        if (res?.ok) return { ok: true, simulated: false, detail: `input volume ${res.before}% → ${res.input_volume}%` };
        return { ok: true, simulated: true, detail: `input volume ${delta > 0 ? "+" : ""}${delta} points` };
      },
      // Needs the employee to speak again: the check shows the new level live.
      verify: null,
    };
  }

  function issue(key) {
    const name = nameOf(deviceId);
    const base = { key, simulated: damaged, diagnostics };

    if (key === "dead") {
      return {
        ...base,
        severity: "bad",
        title: allDead ? "No microphone delivers any sound" : `${name} sends no sound`,
        action: {
          title: "Restore the microphone",
          detail: (p) =>
            `Sets the input volume to ${p.params.inputVolume ?? 75}%${p.execution === "real" ? " on this computer" : " (simulated)"}.`,
          async run(p) {
            const value = Number(p.params.inputVolume) || 75;
            const res = p.execution === "real" ? await helper({ cmd: "set_input_volume", value }) : null;
            endDamage(); // the simulated cause goes away; a real one only if the fix worked
            if (res?.ok) {
              return { ok: true, simulated: false, detail: `input volume ${res.before ?? "?"}% → ${res.input_volume}%` };
            }
            const why = p.execution === "real" ? " (no helper on this computer)" : "";
            return { ok: true, simulated: true, detail: `input volume set to ${value}%${why}` };
          },
          verify: () => remedy.waitFor(micAlive, 7000),
        },
      };
    }

    if (key === "wrongdefault") {
      const def = defaultDevice();
      return {
        ...base,
        severity: "bad",
        title: `${def?.name ?? "The system microphone"} sends no sound; ${name} works`,
        action: {
          title: `Make ${name} the system microphone`,
          detail: (p) => `So Meet and Teams use the microphone that works${p.execution === "real" ? "" : " (simulated)"}.`,
          async run(p) {
            const res = p.execution === "real" ? await helper({ cmd: "switch_input", name }) : null;
            if (res?.ok) return { ok: true, simulated: false, detail: `system microphone is now ${name}` };
            if (p.execution === "real") {
              return { ok: false, detail: res?.reason || "This computer cannot switch microphones remotely (no helper)." };
            }
            return { ok: true, simulated: true, detail: `system microphone set to ${name}` };
          },
          verify: () => remedy.waitFor(() => defaultDevice()?.deviceId === deviceId && micAlive(), 7000),
        },
      };
    }

    if (key === "quiet") return { ...base, severity: "warn", title: "Voice too quiet", action: volumeStep(+1) };
    return { ...base, severity: "warn", title: "Voice distorted (clipping)", action: volumeStep(-1) };
  }

  async function onDeviceChange() {
    if (!active) return;
    const before = devices;
    const prevDefault = before.find((d) => d.isDefault)?.deviceId;
    devices = distinctDevices(await navigator.mediaDevices.enumerateDevices(), "audioinput");
    fillSelect(ui.device, devices);

    const def = defaultDevice();
    if (!def) {
      closeStream();
      verdict("bad", "No microphone found. It was unplugged or disabled.", "bad", "missing");
      return;
    }

    const added = devices.filter((d) => !before.some((b) => b.deviceId === d.deviceId));
    const lost = !devices.some((d) => d.deviceId === deviceId);
    const defaultMoved = def.deviceId !== prevDefault;
    const news = added.length
      ? `${added[0].name} connected.`
      : lost
        ? `${nameOf(deviceId, before)} disconnected.`
        : "";

    // Follow the system default: that is the device Meet and Teams will use.
    if (lost || (!manual && defaultMoved)) {
      manual = false;
      await switchTo(def.deviceId, {
        hint: `${news} The system default is now ${def.name}; that is what Meet uses. Testing it.`.trim(),
      });
    } else if (news) {
      ui.hint.textContent = news;
    }
  }

  ui.device.addEventListener("change", async (e) => {
    manual = true;
    ui.hint.textContent = "";
    await switchTo(e.target.value);
  });

  return {
    setDamage(on) {
      damaged = !!on;
      if (damaged) scanFrom = null;
    },
    async start() {
      if (active) return;
      active = true;
      manual = false;
      ui.hint.textContent = "";
      verdict("", "Starting the microphone…", "busy", "starting");

      try {
        // Labels only appear after a grant, so ask once, then list devices.
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());

        devices = distinctDevices(await navigator.mediaDevices.enumerateDevices(), "audioinput");
        fillSelect(ui.device, devices);
        const def = defaultDevice();
        if (!def) throw Object.assign(new Error("No microphone found"), { name: "NotFoundError" });

        navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
        await switchTo(def.deviceId);
        evalTimer = setInterval(evaluate, 300);
      } catch (err) {
        active = false;
        const e = explainMediaError(err, "microphone");
        verdict("bad", e.text, "bad", e.status);
        ui.hint.textContent = e.hint;
        if (e.permission) permissionHelp(root, "microphone");
      }
    },
    stop() {
      active = false;
      openSeq++;
      clearInterval(evalTimer);
      evalTimer = 0;
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      closeStream();
    },
  };
}
