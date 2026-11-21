const INTERVAL_MS = 1000;
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

export function mountMemory(root, { setStatus }) {
  root.innerHTML = `
    <dl class="metrics">
      <div><dt>CPU usage</dt><dd data-cpu>—</dd></div>
      <div><dt>Available memory</dt><dd data-mem>—</dd></div>
    </dl>
    <p class="verdict" data-verdict>Measuring…</p>
  `;

  const cpuValue = root.querySelector("[data-cpu]");
  const memoryValue = root.querySelector("[data-mem]");
  const verdict = root.querySelector("[data-verdict]");
  let previousCpu = null;
  let memoryHistory = [];
  let timer = 0;
  let generation = 0;

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
    const cpu = cpuLoad(previousCpu, processors);
    previousCpu = processors;
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

    timer = setTimeout(() => cycle(run), INTERVAL_MS);
  }

  return {
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
