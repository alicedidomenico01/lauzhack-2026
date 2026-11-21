// Network: latency probes every 500 ms, download speed every 1 s.
//
// Speed is measured for real, with a payload sized so each transfer lasts about
// 200 ms: at 40 Mb/s that is 1 MB, at 2 Mb/s about 50 KB. Measuring every 500 ms
// would spend most of the bandwidth measuring it.
//
// The SSID comes from the native helper. When the helper is missing we fall back
// to demo-data.js so the switch flow still works on stage.

import { createRing } from "../ui/ring.js";
import {
  DEMO_NETWORKS,
  DEMO_SPEED_BOOST,
  nextDemoNetwork,
} from "./demo-data.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down";
const HOST = "com.setupcheck.host";
const PROBE_MS = 500;
const SPEED_MS = 1000;
const SSID_MS = 5000;
const WINDOW = 20;

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
          <div><dt>Interface</dt><dd data-type>—</dd></div>
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
  let ssid = null;
  let ssidFromHelper = false;
  let speedScale = 1;
  let baseline = null;
  let switchSignature = null;
  let demo = false;
  let probeTimer = 0;
  let speedTimer = 0;
  let ssidTimer = 0;
  let probing = false;
  let measuring = false;

  function chromeLabel() {
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

  function shownSpeed() {
    return speed === null ? null : speed * speedScale;
  }

  function signature() {
    if (ssid) return `ssid:${ssid}`;
    const c = navigator.connection || {};
    return `net:${c.type || "?"}:${c.effectiveType || "?"}`;
  }

  async function refreshSsid() {
    try {
      const res = await chrome.runtime.sendNativeMessage(HOST, { cmd: "wifi" });
      if (res?.ssid) {
        ssid = res.ssid;
        ssidFromHelper = true;
        render();
        return;
      }
    } catch {
      /* helper not installed */
    }

    if (!ssidFromHelper) {
      ssid = ssid ?? DEMO_NETWORKS[0];
      render();
    }
  }

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
      if (demo) await new Promise((r) => setTimeout(r, 280 + Math.random() * 200));
      samples.push(performance.now() - t0);
      if (samples.length > WINDOW) samples.shift();
      consecutiveFails = 0;
    } catch {
      fails++;
      consecutiveFails++;
      if (consecutiveFails >= 3) speed = 0;
    }

    probing = false;
    render();
  }

  function payloadBytes() {
    const mbps = speed && speed > 0.2 ? speed : 2;
    const bytes = Math.round(((mbps * 1e6) / 8) * 0.2);
    return Math.min(2000000, Math.max(40000, bytes));
  }

  async function measureSpeed() {
    if (measuring) return;

    if (demo) {
      speed = 0.9 + Math.random() * 0.4;
      render();
      return;
    }

    if (consecutiveFails >= 3) {
      speed = 0;
      render();
      return;
    }

    measuring = true;
    const bytes = payloadBytes();
    try {
      const t0 = performance.now();
      const res = await fetch(`${SPEED_URL}?bytes=${bytes}&n=${Math.random()}`, {
        cache: "no-store",
      });
      const buf = await res.arrayBuffer();
      const secs = (performance.now() - t0) / 1000;
      if (secs > 0 && buf.byteLength > 0) {
        const raw = (buf.byteLength * 8) / secs / 1e6;
        speed = speed === null || speed === 0 ? raw : speed * 0.6 + raw * 0.4;
      }
    } catch {
      /* keep the last value; the probe loop decides when we are offline */
    }
    measuring = false;
    render();
  }

  function render() {
    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);
    const label = ssid || chromeLabel();
    const value0 = shownSpeed();

    ui.rtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = chromeLabel();
    ui.conn.textContent = label;

    if (value0 === null) {
      ring.set(0, "—", "Mb/s", COLORS.bad);
      ui.verdict.className = "verdict";
      ui.verdict.textContent = "Measuring download speed…";
      setStatus("network", "busy", "measuring");
      return;
    }

    const { value, unit } = formatSpeed(value0);
    const fill = Math.sqrt(Math.min(value0 / SPEED_MAX, 1)) * 100;
    const level = value0 >= SPEED_OK ? "ok" : value0 >= SPEED_WARN ? "warn" : "bad";

    ring.set(fill, value, unit, COLORS[level]);

    ui.verdict.className = `verdict ${level}`;
    ui.verdict.textContent =
      value0 === 0
        ? "No connection."
        : level === "ok"
          ? "Stable. Fine for a call."
          : level === "warn"
            ? "Slow. Your video will drop frames."
            : "Poor. Calls will break up.";

    setStatus("network", level, level === "ok" ? "ok" : "attention");

    const sig = signature();
    if (switchSignature !== null && sig !== switchSignature) {
      switchSignature = null; // the network changed: the button has done its job
    }
    ui.switchBtn.hidden = level !== "bad" || switchSignature !== null;

    if (baseline !== null && baseline > 0) {
      const gain = value0 - baseline;
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

    samples = [];
    attempts = 0;
    fails = 0;
    consecutiveFails = 0;
    speed = null;
    baseline = null;
    switchSignature = null;
    speedScale = 1;
    ui.badge.hidden = true;

    render();
    measureSpeed();
    probe();
  });

  ui.switchBtn.addEventListener("click", () => {
    baseline = shownSpeed();
    switchSignature = signature();
    ui.switchBtn.hidden = true;

    // No helper: pretend the user moved to the hotspot, so the flow is visible.
    if (!ssidFromHelper) {
      setTimeout(() => {
        ssid = nextDemoNetwork(ssid);
        speedScale = DEMO_SPEED_BOOST;
        render();
      }, 3500);
    }
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
      speedScale = 1;
      demo = false;
      ui.demo.classList.remove("on");
      ui.badge.hidden = true;
      ui.switchBtn.hidden = true;

      probe();
      probeTimer = setInterval(probe, PROBE_MS);

      refreshSsid();
      ssidTimer = setInterval(refreshSsid, SSID_MS);

      measureSpeed().then(measureSpeed);
      speedTimer = setInterval(measureSpeed, SPEED_MS);
    },
    stop() {
      clearInterval(probeTimer);
      clearInterval(speedTimer);
      clearInterval(ssidTimer);
      probeTimer = 0;
      speedTimer = 0;
      ssidTimer = 0;
    },
  };
}
