// Network: continuous round-trip sampling against a tiny 204 endpoint.
//
// What this measures: the current link only — latency, jitter, failures.
// What it cannot measure: other networks around you. No browser API can
// enumerate Wi-Fi networks or bind a request to another interface.

import { createRing } from "../ui/ring.js";

const PROBE_URL = "https://www.gstatic.com/generate_204";
const PROBES = 3;
const INTERVAL_MS = 5000;

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
    <div class="metrics">
      <div><dt>Jitter</dt><dd data-jitter>—</dd></div>
      <div><dt>Failures</dt><dd data-loss>—</dd></div>
      <div><dt>Connection</dt><dd data-type>—</dd></div>
      <div><dt>Updated</dt><dd data-age>—</dd></div>
    </div>
    <p class="verdict" data-verdict></p>
    <p class="hint">Live, every 5 s. A browser cannot see other networks around you — that needs a local helper.</p>
  `;

  const ring = createRing();
  root.prepend(ring.el);

  const el = {
    jitter: root.querySelector("[data-jitter]"),
    loss: root.querySelector("[data-loss]"),
    type: root.querySelector("[data-type]"),
    age: root.querySelector("[data-age]"),
    verdict: root.querySelector("[data-verdict]"),
  };

  let timer = null;
  let running = false;

  async function cycle() {
    if (running) return;
    running = true;

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

    const samples = times.slice(1);
    running = false;

    if (samples.length < 2) {
      el.jitter.textContent = "—";
      el.loss.textContent = `${fails}/${PROBES}`;
      ring.set(0, "—", "offline", COLORS.bad);
      el.verdict.className = "verdict bad";
      el.verdict.textContent = "No reply from the probe: you are offline or it is blocked.";
      setStatus("network", "bad", "offline");
      return;
    }

    const rtt = median(samples);
    const jit = jitter(samples);
    const conn = navigator.connection || {};

    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(100 - Math.max(0, rtt - 60) * 0.25 - jit * 0.35 - fails * 25)
      )
    );

    const level = score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
    const text =
      level === "ok"
        ? "Stable. Fine for a call."
        : level === "warn"
          ? "Usable but shaky. Audio will glitch."
          : "Unreliable. Expect dropouts.";

    el.jitter.textContent = `${jit.toFixed(0)} ms`;
    el.loss.textContent = `${fails}/${PROBES}`;
    el.type.textContent =
      [conn.effectiveType, conn.downlink ? `~${conn.downlink} Mb/s` : null]
        .filter(Boolean)
        .join(" · ") || "unknown";
    el.age.textContent = "just now";

    ring.set(score, `${rtt.toFixed(0)}`, "ms round trip", COLORS[level]);
    el.verdict.className = `verdict ${level}`;
    el.verdict.textContent = text;
    setStatus("network", level, level === "ok" ? "ok" : "attention");
  }

  return {
    start() {
      if (timer) return;
      cycle();
      timer = setInterval(cycle, INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
