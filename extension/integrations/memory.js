// Machine: device class, event-loop lag, and a rising-trend alert.
//
// A browser cannot read CPU or system memory. Lag is what we can honestly
// measure, and it is the thing the user actually feels.

import { showAction } from "../ui/action-banner.js";

const WINDOW_MS = 600;
const INTERVAL_MS = 2000;
const HISTORY = 8;

async function measureLag(ms) {
  const drifts = [];
  let last = performance.now();
  const end = last + ms;

  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const now = performance.now();
    drifts.push(Math.max(0, now - last - 100));
    last = now;
  }

  return drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;
}

export function mountMemory(root, { setStatus }) {
  root.innerHTML = `
    <div class="metrics">
      <div><dt>Device RAM</dt><dd data-ram>—</dd></div>
      <div><dt>Cores</dt><dd data-cores>—</dd></div>
      <div><dt>UI lag</dt><dd data-lag>—</dd></div>
      <div><dt>Trend</dt><dd data-trend>—</dd></div>
    </div>
    <p class="verdict" data-verdict>Measuring…</p>
    <p class="hint">CPU and system memory are invisible to a browser. Lag is the proxy; a local helper (vm_stat, top) would give the real numbers.</p>
  `;

  const ui = {
    ram: root.querySelector("[data-ram]"),
    cores: root.querySelector("[data-cores]"),
    lag: root.querySelector("[data-lag]"),
    trend: root.querySelector("[data-trend]"),
    verdict: root.querySelector("[data-verdict]"),
  };

  ui.ram.textContent = navigator.deviceMemory ? `~${navigator.deviceMemory} GB` : "hidden";
  ui.cores.textContent = navigator.hardwareConcurrency || "—";

  const history = [];
  let timer = 0;
  let running = false;
  let actionShown = false;

  async function cycle() {
    if (running) return;
    running = true;

    const lag = await measureLag(WINDOW_MS);
    running = false;

    history.push(lag);
    if (history.length > HISTORY) history.shift();

    const first = history[0];
    const last = history[history.length - 1];
    const delta = last - first;

    ui.lag.textContent = `${lag.toFixed(0)} ms/s`;
    ui.trend.textContent =
      history.length < 3 ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)} ms`;

    const rising = history.length >= 4 && delta > 25 && last > 40;

    if (last > 80) {
      ui.verdict.className = "verdict bad";
      ui.verdict.textContent = "Struggling right now: calls freeze, typing lags.";
      setStatus("memory", "bad", "struggling");
    } else if (last > 30 || rising) {
      ui.verdict.className = "verdict warn";
      ui.verdict.textContent = rising
        ? "Getting worse: something is climbing in the background."
        : "Mild stutter. Something is competing for the CPU.";
      setStatus("memory", "warn", rising ? "rising" : "attention");
    } else {
      ui.verdict.className = "verdict ok";
      ui.verdict.textContent = "Responsive. Nothing is starving the machine.";
      setStatus("memory", "ok", "ok");
    }

    // The action flow: announce, give 3 s to cancel, then "apply".
    if ((last > 80 || rising) && !actionShown) {
      actionShown = true;
      setStatus("memory", "busy", "acting");
      showAction({
        title: "Fixing remotely…",
        detail:
          "Simulated remote action: restart the process starving this machine. Cancel within 3 s.",
        seconds: 3,
        onApply: () => {
          ui.verdict.className = "verdict ok";
          ui.verdict.textContent =
            "Action applied (simulated). A Nexthink remote action would do this for real.";
          setStatus("memory", "ok", "fixed");
          setTimeout(() => {
            actionShown = false;
          }, 20000);
        },
        onCancel: () => {
          ui.verdict.className = "verdict warn";
          ui.verdict.textContent = "Cancelled. Nothing was applied.";
          setStatus("memory", "warn", "cancelled");
          setTimeout(() => {
            actionShown = false;
          }, 10000);
        },
      });
    }
  }

  return {
    start() {
      if (timer) return;
      cycle();
      timer = setInterval(cycle, INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
    },
  };
}
