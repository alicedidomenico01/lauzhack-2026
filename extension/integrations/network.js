import { createRing } from "../ui/ring.js";

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
          <div><dt>Chrome quality estimate</dt><dd data-type>—</dd></div>
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
  let speedUnavailable = false;
  let ssid = null;
  let speedEpoch = 0;
  let ssidPending = false;
  let switchConfirmed = false;
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

  async function refreshSsid() {
    if (ssidPending) return;
    ssidPending = true;
    let next = null;
    try {
      const res = await chrome.runtime.sendNativeMessage(HOST, { cmd: "wifi" });
      if (typeof res?.ssid === "string" && !/^<redacted>$/i.test(res.ssid.trim())) {
        next = res.ssid.trim() || null;
      }
    } catch {
      next = null;
    } finally {
      ssidPending = false;
    }
    if (!probeTimer) return;
    ssid = next;
    if (switchSignature && ssid && ssid !== switchSignature) finishSwitch();
    render();
  }

  function finishSwitch() {
    switchConfirmed = true;
    switchSignature = null;
    speedEpoch++;
    speedUnavailable = false;
    speed = null;
    consecutiveFails = 0;
    render();
    measureSpeed();
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
        signal: AbortSignal.timeout(2000),
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
    const epoch = speedEpoch;
    const bytes = payloadBytes();
    try {
      const t0 = performance.now();
      const res = await fetch(`${SPEED_URL}?bytes=${bytes}&n=${Math.random()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const secs = (performance.now() - t0) / 1000;
      if (epoch !== speedEpoch || consecutiveFails >= 3) return;
      if (secs <= 0 || buf.byteLength !== bytes) throw new Error("Unexpected test payload");
      const raw = (buf.byteLength * 8) / secs / 1e6;
      speed = speed === null || speed === 0 ? raw : speed * 0.6 + raw * 0.4;
      speedUnavailable = false;
    } catch {
      if (epoch === speedEpoch && consecutiveFails < 3) {
        speed = null;
        speedUnavailable = true;
      }
    } finally {
      measuring = false;
      if (epoch === speedEpoch) render();
    }
  }

  function render() {
    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);
    const label = demo ? "Demo mode · simulated connection" : ssid || "Wi-Fi name unavailable";
    const value0 = speed;

    ui.rtt.textContent = rtt === null ? "—" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = chromeLabel();
    ui.conn.textContent = label;

    if (value0 === null) {
      ring.set(0, "—", "Mb/s", COLORS.bad);
      const text = speedUnavailable ? "Speed test unavailable. Retrying…" : "Measuring download speed…";
      ui.verdict.className = speedUnavailable ? "verdict warn" : "verdict";
      ui.verdict.textContent = text;
      setStatus(speedUnavailable ? "warn" : "busy", text);
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
          ? "Download speed looks good."
          : level === "warn"
            ? "Low download speed."
            : "Very low download speed.";

    setStatus(level, level === "ok" ? "ok" : "attention");

    ui.switchBtn.hidden = demo || switchConfirmed || (level !== "bad" && baseline === null);
    ui.switchBtn.textContent = baseline === null ? "Switch Network" : "Retest after switching Wi-Fi";
    ui.badge.hidden = true;

    if (switchConfirmed && baseline !== null && baseline > 0 && speed > 0) {
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
    speedUnavailable = false;
    baseline = null;
    switchSignature = null;
    switchConfirmed = false;
    speedEpoch++;
    ui.switchBtn.hidden = true;
    ui.badge.hidden = true;

    render();
    measureSpeed();
    probe();
  });

  ui.switchBtn.addEventListener("click", () => {
    if (baseline !== null) {
      finishSwitch();
      return;
    }
    baseline = speed;
    switchSignature = ssid;
    render();
  });

  return {
    start() {
      if (probeTimer) return;

      samples = [];
      attempts = 0;
      fails = 0;
      consecutiveFails = 0;
      speed = null;
      speedUnavailable = false;
      baseline = null;
      switchSignature = null;
      switchConfirmed = false;
      speedEpoch++;
      ssid = null;
      demo = false;
      ui.demo.classList.remove("on");
      ui.badge.hidden = true;
      ui.switchBtn.hidden = true;

      probe();
      probeTimer = setInterval(probe, PROBE_MS);

      refreshSsid();
      ssidTimer = setInterval(refreshSsid, SSID_MS);

      render();
      measureSpeed();
      speedTimer = setInterval(measureSpeed, SPEED_MS);
    },
    stop() {
      speedEpoch++;
      clearInterval(probeTimer);
      clearInterval(speedTimer);
      clearInterval(ssidTimer);
      probeTimer = 0;
      speedTimer = 0;
      ssidTimer = 0;
    },
  };
}
