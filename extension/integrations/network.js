// Network: latency probes every 500 ms, real throughput every 12 s.
// The ring shows measured download speed, not an estimate.

import { createRing } from "../ui/ring.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down";
const SPEED_BYTES = 500000;
const PROBE_MS = 500;
const SPEED_MS = 12000;
const WINDOW = 20;

// 2 Mb/s fills the ring. Below WARN the connection is red and we offer a switch.
const SPEED_MAX = 2;
const SPEED_OK = 1.5;
const SPEED_WARN = 0.6;

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

function connectionName() {
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
    <p class="switch-help" data-switch-help hidden>
      Chrome cannot change your Wi-Fi. Open the Wi-Fi menu, pick the other
      network, and come back — the difference appears next to the ring.
    </p>

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
        <div><dt>Failures</dt><dd data-loss>—</dd></div>
        <div><dt>Connection</dt><dd data-type>—</dd></div>
      </dl>
    </details>
  `;

  const ring = createRing();
  root.querySelector(".ring-holder").appendChild(ring.el);

  const ui = {
    verdict: root.querySelector("[data-verdict]"),
    conn: root.querySelector("[data-conn]"),
    switchBtn: root.querySelector("[data-switch]"),
    switchHelp: root.querySelector("[data-switch-help]"),
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
  let speed = null;
  let baseline = null;
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
      // In demo mode we hold the request open so latency and jitter look real.
      if (demo) await new Promise((r) => setTimeout(r, 280 + Math.random() * 200));
      samples.push(performance.now() - t0);
      if (samples.length > WINDOW) samples.shift();
    } catch {
      fails++;
    }

    probing = false;
    render();
  }

  async function measureSpeed() {
    if (demo) {
      speed = 0.28 + Math.random() * 0.2;
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
      if (secs > 0 && buf.byteLength > 0) {
        speed = (buf.byteLength * 8) / secs / 1e6;
        render();
      }
    } catch {
      /* keep the last value rather than showing a wrong one */
    }
  }

  function render() {
    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);

    ui.rtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = connectionName();
    ui.conn.textContent = connectionName();

    if (speed === null) {
      ring.set(0, "—", "Mb/s", COLORS.bad);
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Measuring download speed…";
      setStatus("network", "busy", "measuring");
      return;
    }

    const { value, unit } = formatSpeed(speed);
    const fill = Math.min(100, (speed / SPEED_MAX) * 100);
    const level = speed >= SPEED_OK ? "ok" : speed >= SPEED_WARN ? "warn" : "bad";

    ring.set(fill, value, unit, COLORS[level]);

    ui.verdict.className = `verdict ${level}`;
    ui.verdict.textContent =
      level === "ok"
        ? "Stable. Fine for a call."
        : level === "warn"
          ? "Slow. Your video will drop frames."
          : "Poor. Calls will break up.";

    setStatus("network", level, level === "ok" ? "ok" : "attention");

    ui.switchBtn.hidden = level !== "bad";

    // Live comparison against the speed we had when the user was told to switch.
    if (baseline !== null && baseline > 0) {
      const delta = ((speed - baseline) / baseline) * 100;
      if (Math.abs(delta) >= 5) {
        ui.badge.hidden = false;
        ui.badge.textContent = `${delta > 0 ? "+" : ""}${delta.toFixed(0)}% speed`;
        ui.badge.className = `ring-badge ${delta > 0 ? "up" : "down"}`;
      }
    }
  }

  ui.demo.addEventListener("click", () => {
    demo = !demo;
    ui.demo.classList.toggle("on", demo);
    ui.demo.title = demo
      ? "Demo mode: simulated bad connection. Click to stop."
      : "Simulate a shaky connection (demo)";
    // Drop history so the change is visible immediately.
    samples = [];
    attempts = 0;
    fails = 0;
    speed = null;
    render();
    measureSpeed();
    probe();
  });

  ui.switchBtn.addEventListener("click", () => {
    baseline = speed;
    ui.switchHelp.hidden = false;
    ui.switchBtn.hidden = true;
  });

  return {
    start() {
      if (probeTimer) return;

      // Fresh state every time the panel comes back.
      samples = [];
      attempts = 0;
      fails = 0;
      speed = null;
      baseline = null;
      demo = false;
      ui.demo.classList.remove("on");
      ui.badge.hidden = true;
      ui.switchHelp.hidden = true;
      ui.switchBtn.hidden = true;

      probe();
      probeTimer = setInterval(probe, PROBE_MS);

      // Two measurements: the first pays the TLS handshake.
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
