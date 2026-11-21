// Machine: real CPU and memory from the native helper, with event-loop lag as a
// fallback when the helper is not installed.

import { showAction } from "../ui/action-banner.js";

const HOST = "com.setupcheck.host";
const INTERVAL_MS = 2000;
const WINDOW_MS = 600;
const HISTORY = 6;

async function nativeStats() {
  try {
    return await chrome.runtime.sendNativeMessage(HOST, { cmd: "stats" });
  } catch {
    return null;
  }
}

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
      <div><dt>CPU</dt><dd data-cpu>—</dd></div>
      <div><dt>Memory free</dt><dd data-mem>—</dd></div>
      <div><dt>Top process</dt><dd data-top>—</dd></div>
      <div><dt>UI lag</dt><dd data-lag>—</dd></div>
    </div>
    <p class="verdict" data-verdict>Measuring…</p>
  `;

  const ui = {
    cpu: root.querySelector("[data-cpu]"),
    mem: root.querySelector("[data-mem]"),
    top: root.querySelector("[data-top]"),
    lag: root.querySelector("[data-lag]"),
    verdict: root.querySelector("[data-verdict]"),
  };

  const history = [];
  let timer = 0;
  let running = false;
  let actionShown = false;
  let topName = null;

  async function cycle() {
    if (running) return;
    running = true;

    const stats = await nativeStats();
    const lag = await measureLag(WINDOW_MS);
    running = false;

    history.push(lag);
    if (history.length > HISTORY) history.shift();

    const first = history[0];
    const last = history[history.length - 1];
    const rising = history.length >= 4 && last - first > 25 && last > 40;

    ui.lag.textContent = `${lag.toFixed(0)} ms/s`;

    let level;
    let text;

    if (stats && typeof stats.cpu_percent === "number") {
      const cpu = stats.cpu_percent;
      const memFree = stats.memory_free_percent;
      topName = stats.top || null;

      ui.cpu.textContent = `${cpu.toFixed(0)}%`;
      ui.mem.textContent = memFree === null ? "—" : `${memFree}%`;
      ui.top.textContent = stats.top
        ? `${stats.top} ${stats.top_cpu ?? ""}%`.trim()
        : "—";

      const memLow = typeof memFree === "number" && memFree < 12;
      level = cpu > 85 || memLow ? "bad" : cpu > 60 || rising ? "warn" : "ok";
      text =
        level === "bad"
          ? memLow
            ? "Memory is nearly full. Everything will start swapping."
            : "CPU is saturated. Calls freeze, typing lags."
          : level === "warn"
            ? rising
              ? "Load is climbing in the background."
              : "Busy, but still usable."
            : "Nothing is starving the machine.";
    } else {
      // No helper: lag is all we have, and we say so by leaving the fields empty.
      ui.cpu.textContent = "—";
      ui.mem.textContent = "—";
      ui.top.textContent = "helper off";
      level = last > 80 ? "bad" : last > 30 || rising ? "warn" : "ok";
      text =
        level === "bad"
          ? "The browser is blocked. Something is starving the machine."
          : level === "warn"
            ? "Mild stutter. Something is competing for the CPU."
            : "Responsive. Nothing is starving the machine.";
    }

    ui.verdict.className = `verdict ${level}`;
    ui.verdict.textContent = text;
    setStatus("memory", level, level === "ok" ? "ok" : "attention");

    if (level === "bad" && !actionShown) {
      actionShown = true;
      setStatus("memory", "busy", "acting");
      showAction({
        title: "Fixing remotely…",
        detail: topName
          ? `Simulated remote action: restart ${topName}. Cancel within 3 s.`
          : "Simulated remote action: restart the busiest process. Cancel within 3 s.",
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
