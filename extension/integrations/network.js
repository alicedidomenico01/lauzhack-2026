import { createRing } from "../ui/ring.js";
import { helper, sleep } from "../lib/central.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down";
const HOST = "com.setupcheck.host";
const PROBE_MS = 500;
const SPEED_MS = 2000;
const SSID_MS = 5000;
const WINDOW = 20;

// Shown when the helper cannot report the Wi-Fi name. The panel is not claiming
// this is the network you are on; it is the label we use on stage.
const FALLBACK_SSID = "freewifi-epfl";

const SPEED_TARGET_S = 0.15; // aim for a transfer that lasts ~150 ms
const SPEED_MAX_BYTES = 500000;
const SPEED_MIN_BYTES = 30000;
const SPEED_TIMEOUT_MS = 6000;
const SPEED_FAILS_BEFORE_UNAVAILABLE = 3;

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

export function mountNetwork(root, api) {
  const { setStatus, remedy } = api;
  root.innerHTML = `
    <div class="net">
      <div class="ring-top">
        <div class="ring-holder"></div>
      </div>

      <p class="verdict" data-verdict>Measuring…</p>
      <p class="conn-name" data-conn>-</p>
      <p class="net-note" data-note></p>


      <details class="more">
        <summary>
          <span class="sum-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </span>
          <span>Details</span>
        </summary>
        <dl class="metrics">
          <div><dt>Latency</dt><dd data-rtt>-</dd></div>
          <div><dt>Jitter</dt><dd data-jitter>-</dd></div>
          <div><dt>Lost probes</dt><dd data-loss>-</dd></div>
          <div><dt>Chrome quality estimate</dt><dd data-type>-</dd></div>
        </dl>
      </details>
    </div>
  `;

  const ring = createRing();
  root.querySelector(".ring-holder").appendChild(ring.el);

  const ui = {
    verdict: root.querySelector("[data-verdict]"),
    conn: root.querySelector("[data-conn]"),
    note: root.querySelector("[data-note]"),
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
  let speedFails = 0;
  let ssid = null;
  let speedEpoch = 0;
  let ssidPending = false;
  let demo = false; // the damage: a simulated shaky connection
  let switched = null; // { to, from, before, at, simulated } after a network switch
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
    render();
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
    const bytes = Math.round(((mbps * 1e6) / 8) * SPEED_TARGET_S);
    return Math.min(SPEED_MAX_BYTES, Math.max(SPEED_MIN_BYTES, bytes));
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
        signal: AbortSignal.timeout(SPEED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const secs = (performance.now() - t0) / 1000;
      if (epoch !== speedEpoch) return;
      // Measure what actually arrived: a CDN may cap or compress the body, and
      // an exact size check used to turn that into a fake outage.
      if (secs <= 0 || buf.byteLength < 1024) {
        throw new Error(`test payload too small (${buf.byteLength} B)`);
      }
      const raw = (buf.byteLength * 8) / secs / 1e6;
      speed = speed === null || speed === 0 ? raw : speed * 0.6 + raw * 0.4;
      speedFails = 0;
      speedUnavailable = false;
    } catch (err) {
      if (epoch !== speedEpoch) return;
      speedFails++;
      // One slow sample is not an outage: keep the last reading on screen.
      if (speedFails >= SPEED_FAILS_BEFORE_UNAVAILABLE) {
        speed = null;
        speedUnavailable = true;
      }
      console.warn(`[setup-check] speed test ${speedFails}:`, err?.message || err);
    } finally {
      measuring = false;
      if (epoch === speedEpoch) render();
    }
  }

  function render() {
    const rtt = samples.length ? median(samples) : null;
    const jit = jitter(samples);
    const recentSwitch = switched && Date.now() - switched.at < 60000;
    const label = recentSwitch
      ? `${switched.to}${switched.simulated ? " · simulated switch" : ""}`
      : demo
        ? "Demo mode · simulated connection"
        : ssid || FALLBACK_SSID;
    const value0 = speed;

    ui.rtt.textContent = rtt === null ? "-" : `${rtt.toFixed(0)} ms`;
    ui.jitter.textContent = `${jit.toFixed(0)} ms`;
    ui.loss.textContent = `${fails}/${attempts}`;
    ui.type.textContent = chromeLabel();
    ui.conn.textContent = label;

    if (value0 === null) {
      ring.set(0, "-", "Mb/s", COLORS.bad);
      const text = speedUnavailable
        ? "Speed test unavailable. Retrying…"
        : "Measuring download speed…";
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

    // After a switch, show what it bought: the speed before and now.
    if (recentSwitch && switched.before !== null && !measuringAfterSwitch()) {
      const d = value0 - switched.before;
      ui.note.textContent = `${formatSpeed(switched.before).value} ${formatSpeed(switched.before).unit} on ${switched.from} → ${value} ${unit} now (${d >= 0 ? "+" : ""}${d.toFixed(1)} Mb/s)`;
    } else if (!recentSwitch) {
      ui.note.textContent = "";
    }

    if (level === "bad") remedy.raise(issue());
    else remedy.clear("slow");
  }

  // The first sample after a switch still carries the old network's average.
  const measuringAfterSwitch = () => switched && Date.now() - switched.at < 1500;

  function resetMeasurements() {
    samples = [];
    attempts = 0;
    fails = 0;
    consecutiveFails = 0;
    speed = null;
    speedUnavailable = false;
    speedFails = 0;
    speedEpoch++;
  }

  function setDemo(on) {
    demo = !!on;
    if (demo) switched = null;
    resetMeasurements();
    render();
    measureSpeed();
    probe();
  }

  // ---------- remote action ----------

  function diagnostics() {
    const rtt = samples.length ? median(samples) : null;
    return {
      speedMbps: speed === null ? null : Number(speed.toFixed(2)),
      latencyMs: rtt === null ? null : Math.round(rtt),
      jitterMs: Math.round(jitter(samples)),
      lostProbes: `${fails}/${attempts}`,
      chromeEstimate: chromeLabel(),
      ssid: ssid ?? "unknown (no helper)",
      simulatedDamage: demo,
    };
  }

  function issue() {
    const from = ssid || FALLBACK_SSID;
    const shown = speed ? formatSpeed(speed) : null;
    return {
      key: "slow",
      severity: "bad",
      simulated: demo,
      suggestOnly: true,
      diagnostics,
      title: !speed ? "No connection" : `Very slow connection (${shown.value} ${shown.unit})`,
      suggestion: () =>
        "This connection is too slow for a call. Switching to another network would probably fix it. Do it from the Wi-Fi menu.",
      action: {
        title: "Switch to a better Wi-Fi network",
        detail: () => `Moves this laptop from ${from} to another network.`,
        async run(p) {
          const to = p.params.targetNetwork || "";
          const before = speed;
          let real = false;
          if (p.execution === "real" && !demo) {
            const res = await helper({ cmd: "wifi_join", ssid: to }, 25000);
            if (!res?.ok) return { ok: false, detail: res?.reason || `Could not join ${to} remotely (no helper).` };
            real = true;
          } else {
            await sleep(1200); // the time a real switch takes, roughly
          }
          if (demo) api.damageChanged?.(false);
          demo = false;
          resetMeasurements();
          switched = { to, from, before, at: Date.now(), simulated: !real };
          render();
          measureSpeed();
          probe();
          return { ok: true, simulated: !real, detail: `switched from ${from} to ${to}` };
        },
        verify: () => remedy.waitFor(() => speed !== null && speed >= SPEED_WARN, 9000),
      },
    };
  }

  return {
    setDamage: setDemo,
    start() {
      if (probeTimer) return;

      samples = [];
      attempts = 0;
      fails = 0;
      consecutiveFails = 0;
      speed = null;
      speedUnavailable = false;
      speedFails = 0;
      speedEpoch++;
      ssid = null;

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
