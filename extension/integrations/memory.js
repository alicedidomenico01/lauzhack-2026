import { helper, sleep } from "../lib/central.js";

const INTERVAL_MS = 1000;
const CPU_HIGH = 90;
const TOP_REFRESH_MS = 5000;
// Demo: the runaway process a simulated damage blames.
const SIMULATED_CULPRIT = { name: "Docker Desktop", cpu: 182, simulated: true };
const CPU_SMOOTHING = 0.35;
const CRITICAL_FREE_PERCENT = 10;
const WARNING_FREE_PERCENT = 20;
const HISTORY_SIZE = 6;
const GIB = 1024 ** 3;

export function cpuLoad(previous, current) {
  if (!previous || !current || !current.length || previous.length !== current.length) return null;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < current.length; i++) {
    const elapsed = current[i].usage.total - previous[i].usage.total;
    const idleElapsed = current[i].usage.idle - previous[i].usage.idle;
    if (!Number.isFinite(elapsed) || !Number.isFinite(idleElapsed) ||
        elapsed < 0 || idleElapsed < 0 || idleElapsed > elapsed) return null;
    total += elapsed;
    idle += idleElapsed;
  }
  return total > 0 ? (1 - idle / total) * 100 : null;
}

export function mountMemory(root, api) {
  const { setStatus, remedy } = api;
  root.innerHTML = `
    <dl class="metrics">
      <div><dt>CPU usage</dt><dd data-cpu>-</dd></div>
      <div><dt>Available memory</dt><dd data-mem>-</dd></div>
    </dl>
    <p class="verdict" data-verdict>Measuring…</p>
  `;

  const cpuValue = root.querySelector("[data-cpu]");
  const memoryValue = root.querySelector("[data-mem]");
  const verdict = root.querySelector("[data-verdict]");
  let previousCpu = null;
  let smoothedCpu = null;
  let memoryHistory = [];
  let timer = 0;
  let generation = 0;
  let damaged = false;
  let top = null; // { name, cpu } from the helper, when installed
  let topAt = 0;
  let lastCpu = null;
  let lastFree = null;

  function report(level, text) {
    verdict.className = `verdict ${level}`;
    verdict.textContent = text;
    setStatus(level, text);
  }

  async function cycle(run) {
    const [cpuInfo, memoryInfo] = await Promise.allSettled([
      Promise.resolve().then(() => chrome.system.cpu.getInfo()),
      Promise.resolve().then(() => chrome.system.memory.getInfo()),
    ]);
    if (run !== generation) return;

    const processors = cpuInfo.value?.processors;
    const instantCpu = cpuLoad(previousCpu, processors);
    previousCpu = processors;
    // One-second windows swing hard on a multi-core machine; smooth the display.
    smoothedCpu = instantCpu === null
      ? null
      : smoothedCpu === null
        ? instantCpu
        : smoothedCpu * (1 - CPU_SMOOTHING) + instantCpu * CPU_SMOOTHING;
    // Demo damage: a runaway process pins the CPU (no smoothing, so it shows at once).
    if (damaged) smoothedCpu = 95 + Math.random() * 4;
    const cpu = smoothedCpu;
    const { availableCapacity, capacity } = memoryInfo.value ?? {};
    const free = capacity > 0 && availableCapacity >= 0 && availableCapacity <= capacity
      ? availableCapacity / capacity * 100
      : null;

    cpuValue.textContent = cpu === null
      ? (processors ? "Sampling…" : "Unavailable")
      : `${cpu.toFixed(0)}%`;
    memoryValue.textContent = free === null
      ? "Unavailable"
      : `${(availableCapacity / GIB).toFixed(1)} GiB (${free.toFixed(0)}%)`;

    if (free === null) memoryHistory = [];
    else memoryHistory = [...memoryHistory, free].slice(-HISTORY_SIZE);
    const dropping = memoryHistory.length === HISTORY_SIZE &&
      free < WARNING_FREE_PERCENT && memoryHistory[0] - free >= 5;

    if (free !== null && free < CRITICAL_FREE_PERCENT) report("bad", "Very little memory available.");
    else if (cpu !== null && cpu >= 90) report("bad", "CPU usage is high.");
    else if (dropping) report("warn", "Available memory is low and falling.");
    else if (free !== null && free < WARNING_FREE_PERCENT) report("warn", "Available memory is low.");
    else if (cpu !== null && cpu >= 75) report("warn", "CPU is busy.");
    else if (!processors || free === null) report("warn", "System readings are incomplete.");
    else if (cpu === null) report("busy", "Measuring CPU usage…");
    else report("ok", "CPU and available memory look normal.");

    lastCpu = cpu;
    lastFree = free;
    sync(cpu, free);
    if (!damaged && Date.now() - topAt > TOP_REFRESH_MS) {
      topAt = Date.now();
      helper({ cmd: "stats" }, 4000).then((r) => {
        if (r?.top) top = { name: r.top, cpu: r.top_cpu };
      });
    }

    timer = setTimeout(() => cycle(run), INTERVAL_MS);
  }

  // ---------- remote actions ----------

  function sync(cpu, free) {
    const active = [];
    if (free !== null && free < CRITICAL_FREE_PERCENT) active.push("lowmem");
    if (cpu !== null && cpu >= CPU_HIGH) active.push("cpu");
    for (const key of ["cpu", "lowmem"]) {
      if (active.includes(key)) remedy.raise(issue(key));
      else remedy.clear(key);
    }
  }

  const culprit = () => (damaged ? SIMULATED_CULPRIT : top);

  function diagnostics() {
    const app = culprit();
    return {
      cpuPercent: lastCpu === null ? null : Math.round(lastCpu),
      availableMemoryPercent: lastFree === null ? null : Math.round(lastFree),
      availableMemory: memoryValue.textContent,
      cores: navigator.hardwareConcurrency ?? null,
      topProcess: app ? `${app.name} (${app.cpu}% of one core)` : "unknown (no helper)",
      simulatedDamage: damaged,
    };
  }

  function issue(key) {
    const app = culprit();
    return {
      key,
      severity: "bad",
      simulated: damaged,
      diagnostics,
      title: key === "cpu" ? `CPU overloaded${app ? ` by ${app.name}` : ""}` : "Memory almost full",
      action: {
        title: app ? `Quit ${app.name}` : "Quit the app using the most resources",
        detail: (p) => `It can be reopened at any time${p.execution === "real" ? "" : " (simulated)"}.`,
        async run(p) {
          if (damaged) {
            damaged = false;
            api.damageChanged?.(false);
          }
          if (p.execution === "real" && app && !app.simulated) {
            const res = await helper({ cmd: "quit_app", name: app.name }, 8000);
            if (res?.ok) return { ok: true, simulated: false, detail: `${app.name} quit` };
            return { ok: false, detail: res?.reason || `Could not quit ${app.name} remotely.` };
          }
          await sleep(800);
          return { ok: true, simulated: true, detail: `${app ? app.name : "the app"} quit` };
        },
        verify: () =>
          remedy.waitFor(
            () => (key === "cpu" ? lastCpu !== null && lastCpu < 75 : lastFree !== null && lastFree >= CRITICAL_FREE_PERCENT),
            8000
          ),
      },
    };
  }

  return {
    setDamage(on) {
      damaged = !!on;
    },
    start() {
      if (generation % 2 !== 0) return;
      previousCpu = null;
      memoryHistory = [];
      report("busy", "Measuring…");
      cycle(++generation);
    },
    stop() {
      if (generation % 2 === 0) return;
      generation++;
      clearTimeout(timer);
    },
  };
}
