// Network: latency probes every 500 ms, real download speed every 12 s.
// The speed is smoothed: a single 1 MB transfer is noisy by nature.

import { createRing } from "../ui/ring.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down";
const SPEED_BYTES = 1000000;
const PROBE_MS = 500;
const SPEED_MS = 12000;
const WINDOW = 20;

// The ring fills on a square-root scale up to 25 Mb/s, so a fast link looks
// full but a 1 Mb/s link still moves visibly instead of sitting at 0%.
const SPEED_MAX = 25;
const SPEED_OK = 8;
const SPEED_WARN = 2;

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

function formatSpeed(mbps) {
  if (mbps >= 1) return { value: mbps.toFixed(1), unit: "Mb/s" };
  return { value: String(Math.round(mbps * 1000)), unit: "kb/s" };
}

function connectionSignature() {
  const c = navigator.connection || {};
  return [c.type, c.effectiveType].filter(Boolean).join("·") || "unknown";
}

function connectionLabel() {
  const c = navigator.connection || {};
  const parts = [];
  if (c.type) parts.push(c.type.charAt(0).toUpperCase() + c.type.slice(1));
  if (c.effectiveType) {
    parts.push(
      c.effectiveType === "slow-2g" ? "2G slow" : c.effectiveType.toUpperCase()
    );
  }
  return parts.join(" · ") || "unknown";
}

export function mountNetwork(root, { setStatus }) {
  root.innerHTML = `
    <div class="net">
      <div class="ring-top">
        <div class="ring-holder"></div>
        <button class="ring-demo" type="button" title="Simulate a shaky connection (demo)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 12h4l2.5-7 3.5 14 2.5-7H22" />
          </svg>
        </button>
        <span class="ring-badge" hidden></span>
      </div>

      <p class="verdict" data-verdict>Measuring…</p>
      <p class="conn-name" data-conn>—</p>

      <button class="switch-btn" data-switch hidden>Switch Network</button>

      <details class="more">
        <summary>
          <span class="sum-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </span>
          <span>Details</span>
        </summary>
        <dl class="metrics">
          <div><dt>Latency</dt><dd data-rtt>—</dd></div>
          <div><dt>Jitter</dt><dd data-jitter>—</dd></div>
          <div><dt>Lost probes</dt><dd data-loss>—</dd></div>
          <div><dt>Connection</dt><dd data-type>—</dd></div>
        </dl>
      </details>
    </div>
  `;

  const ring = createRing();
  root.querySelector(".ring-holder").appendChild(ring.el);

  const ui = {
    verdict: root.querySelector("[data-verdict]"),
    conn: root.querySelector("[data-conn]"),
    switchBtn: root.querySelector("[data-switch]"),
    badge: root.querySelector(".ring-badge"),
    demo: root.querySelector(".ring-demo"),
    rtt: root.querySelector("[data-rtt]"),
    jitter: root.querySelector("[data-jitter]"),
    loss: root.querySelector("[data-loss]"),
    type: root.querySelector("[data-type]"),
  };

  let samples = [];
  let attempts = 0;
  let fails = 0;
  let consecutiveFails = 0;
  let speed = null;
  let baseline = null;
  let switchSignature = null;
  let demo = false;
  let probeTimer = 0;
  let speedTimer = 0;
  let probing = false;

  async function probe() {
    if (probing) return;
    probing = true;
    attempts++;

    const t0 = performance.now();
    try {
      await fetch(`${PROBE_URL}?n=${Math.random()}`, {
        mode: "no-cors",
        cache: "no-store",
      });
      // Demo mode holds the request open so latency looks genuinely bad.
      if (demo) await new Promise((r) => setTimeout(r, 280 + Math.random() * 200));
      samples.push(performance.now() - t0);
      if (samples.length > WINDOW) samples.shift();
      consecutiveFails = 0;
    } catch {
      fails++;
      consecutiveFails++;
      if (consecutiveFails >= 3) speed = 0; // offline: stop showing a stale number
    }

    probing = false;
    render();
  }

  async function measureSpeed() {
    if (demo) {
      // Deliberately below the red threshold.
      speed = 0.9 + Math.random() * 0.4;
      render();
      return;
    }

    if (consecutiveFails >= 3) {
      speed = 0;
      render();
      return;
    }

    try {
      const t0 = performance.now();
      const res = await fetch(
        `${SPEED_URL}?bytes=${SPEED_BYTES}&n=${Math.random()}`,
        { cache: "no-store" }
      );
      const buf = await res.arrayBuffer();
      const secs = (performance.now() - t0) / 1000;
      if (secs <= 0 || buf.byteLength === 0) return;

      const raw = (buf.byteLength * 8) / secs / 1e6;
      // Smooth: one transfer is noisy, two in a row are believable.
      speed = speed === null || speed === 0 ? raw : speed * 0.55 + raw * 0.45;
      render();
    } catch {
      /* keep the last value; the probe loop decides when we are offline */
    }
  }

  function render() {
    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);

    ui.rtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = connectionLabel();
    ui.conn.textContent = connectionLabel();

    if (speed === null) {
      ring.set(0, "—", "Mb/s", COLORS.bad);
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Measuring download speed…";
      setStatus("network", "busy", "measuring");
      return;
    }

    const { value, unit } = formatSpeed(speed);
    const fill = Math.sqrt(Math.min(speed / SPEED_MAX, 1)) * 100;
    const level = speed >= SPEED_OK ? "ok" : speed >= SPEED_WARN ? "warn" : "bad";

    ring.set(fill, value, unit, COLORS[level]);

    ui.verdict.className = `verdict ${level}`;
    ui.verdict.textContent =
      speed === 0
        ? "No connection."
        : level === "ok"
          ? "Stable. Fine for a call."
          : level === "warn"
            ? "Slow. Your video will drop frames."
            : "Poor. Calls will break up.";

    setStatus("network", level, level === "ok" ? "ok" : "attention");

    // The switch button is only useful while the link is red, and it must
    // disappear as soon as the network itself changed.
    const signature = connectionSignature();
    if (switchSignature !== null && signature !== switchSignature) {
      switchSignature = null;
      baseline = null;
      ui.badge.hidden = true;
    }
    ui.switchBtn.hidden = level !== "bad" || switchSignature !== null;

    if (baseline !== null && baseline > 0) {
      const gain = speed - baseline;
      if (Math.abs(gain) >= 0.3) {
        ui.badge.hidden = false;
        ui.badge.textContent = `${gain > 0 ? "+" : ""}${gain.toFixed(1)} Mb/s`;
        ui.badge.title = `${gain > 0 ? "+" : ""}${(
          (gain / baseline) *
          100
        ).toFixed(0)}% versus before`;
        ui.badge.className = `ring-badge ${gain > 0 ? "up" : "down"}`;
      }
    }
  }

  ui.demo.addEventListener("click", () => {
    demo = !demo;
    ui.demo.classList.toggle("on", demo);
    ui.demo.title = demo
      ? "Demo mode: simulated bad connection. Click to stop."
      : "Simulate a shaky connection (demo)";

    // Full reset so nothing from the demo survives.
    samples = [];
    attempts = 0;
    fails = 0;
    consecutiveFails = 0;
    speed = null;
    baseline = null;
    switchSignature = null;
    ui.badge.hidden = true;

    render();
    measureSpeed();
    probe();
  });

  ui.switchBtn.addEventListener("click", () => {
    baseline = speed;
    switchSignature = connectionSignature();
    ui.switchBtn.hidden = true;
  });

  return {
    start() {
      if (probeTimer) return;

      samples = [];
      attempts = 0;
      fails = 0;
      consecutiveFails = 0;
      speed = null;
      baseline = null;
      switchSignature = null;
      demo = false;
      ui.demo.classList.remove("on");
      ui.badge.hidden = true;
      ui.switchBtn.hidden = true;

      probe();
      probeTimer = setInterval(probe, PROBE_MS);

      // Two transfers: the first pays for the TLS handshake.
      measureSpeed().then(measureSpeed);
      speedTimer = setInterval(measureSpeed, SPEED_MS);
    },
    stop() {
      clearInterval(probeTimer);
      clearInterval(speedTimer);
      probeTimer = 0;
      speedTimer = 0;
    },
  };
}
