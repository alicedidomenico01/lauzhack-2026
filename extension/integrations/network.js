// Network: one tiny probe every 500 ms, rendered as a single ring.
// The ring shows the browser's own throughput estimate; latency and jitter are
// ours, and live behind "Details".

import { createRing } from "../ui/ring.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const INTERVAL_MS = 500;
const WINDOW = 20;

const COLORS = { ok: "#35c88a", warn: "#e8b23c", bad: "#ef5f5f" };

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

export function mountNetwork(root, { setStatus }) {
  root.innerHTML = `
    <p class="verdict" data-verdict>Measuring…</p>
    <details class="more">
      <summary>Details</summary>
      <dl class="metrics">
        <div><dt>Latency</dt><dd data-rtt>—</dd></div>
        <div><dt>Jitter</dt><dd data-jitter>—</dd></div>
        <div><dt>Failures</dt><dd data-loss>—</dd></div>
        <div><dt>Connection</dt><dd data-type>—</dd></div>
      </dl>
      <p class="hint" data-note></p>
    </details>
  `;

  const ring = createRing();
  root.prepend(ring.el);

  const ui = {
    verdict: root.querySelector("[data-verdict]"),
    rtt: root.querySelector("[data-rtt]"),
    jitter: root.querySelector("[data-jitter]"),
    loss: root.querySelector("[data-loss]"),
    type: root.querySelector("[data-type]"),
    note: root.querySelector("[data-note]"),
  };

  const samples = [];
  let attempts = 0;
  let fails = 0;
  let timer = 0;
  let busy = false;
  let lastType = null;

  async function tick() {
    if (busy) return;
    busy = true;
    attempts++;

    const t0 = performance.now();
    try {
      await fetch(`${PROBE_URL}?n=${Math.random()}`, {
        mode: "no-cors",
        cache: "no-store",
      });
      samples.push(performance.now() - t0);
      if (samples.length > WINDOW) samples.shift();
    } catch {
      fails++;
    }

    busy = false;
    render();
  }

  function render() {
    const conn = navigator.connection || {};

    // The browser's own estimate, in Mb/s. It caps at 10, hence "10+".
    const downlink = typeof conn.downlink === "number" ? conn.downlink : null;
    const downlinkText =
      downlink === null ? "—" : downlink >= 10 ? "10+" : String(downlink);

    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);

    ui.rtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = conn.effectiveType || conn.type || "unknown";

    if (rtt === null) {
      ring.set(0, downlinkText, "Mb/s", COLORS.bad);
      ui.verdict.className = "verdict bad";
      ui.verdict.textContent = "No reply yet: offline or the probe is blocked.";
      setStatus("network", "bad", "offline");
      return;
    }

    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          100 - Math.max(0, rtt - 60) * 0.25 - jit * 0.35 - fails * 20
        )
      )
    );

    const level = score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
    const text =
      level === "ok"
        ? "Stable. Fine for a call."
        : level === "warn"
          ? "Usable but shaky. Audio will glitch."
          : "Unreliable. Expect dropouts.";

    ring.set(score, downlinkText, "Mb/s", COLORS[level]);
    ui.verdict.className = `verdict ${level}`;
    ui.verdict.textContent = text;
    setStatus("network", level, level === "ok" ? "ok" : "attention");

    // Detect a network switch (e.g. moving to a hotspot) and say so.
    const type = conn.type || conn.effectiveType || null;
    if (type && lastType && type !== lastType) {
      ui.note.textContent = `Network changed: ${lastType} → ${type}. Compare the numbers you saw before.`;
    } else if (!ui.note.textContent) {
      ui.note.textContent =
        "A browser cannot see other networks around you. Switching to your hotspot and watching this change is the only comparison available without a local helper.";
    }
    lastType = type || lastType;
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
    },
  };
}
