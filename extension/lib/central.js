// The link to IT: who this device is, the outbox of incidents, the action
// policies IT has set, and the native helper (for actions a browser cannot do).
//
// Nothing here blocks a check. If the central server is down, incidents wait
// in an outbox (kept across panel restarts) and policies fall back to the
// last ones received, then to the defaults below.

export const CENTRAL_URL = "http://localhost:8787";
const HOST = "com.setupcheck.host";
const POLICY_TTL_MS = 10000;
const FLUSH_MS = 4000;
const OUTBOX_MAX = 300;

// Same as central/server.py DEFAULT_POLICIES (only what the device needs),
// used until the server has answered once.
const DEFAULT_POLICIES = {
  "network.slow": { mode: "auto", seconds: 3, execution: "simulated", params: { targetNetwork: "eduroam" } },
  "audio.dead": { mode: "auto", seconds: 3, execution: "real", params: { inputVolume: 75 } },
  "audio.wrongdefault": { mode: "auto", seconds: 3, execution: "real", params: {} },
  "audio.quiet": { mode: "ask", seconds: 3, execution: "real", params: { step: 20 } },
  "audio.clipping": { mode: "ask", seconds: 3, execution: "real", params: { step: 20 } },
  "camera.frozen": { mode: "auto", seconds: 3, execution: "real", params: {} },
  "camera.black": { mode: "off", seconds: 3, execution: "simulated", params: {} },
  "memory.cpu": { mode: "auto", seconds: 3, execution: "simulated", params: {} },
  "memory.lowmem": { mode: "ask", seconds: 3, execution: "simulated", params: {} },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () =>
  globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;

// chrome.storage in the extension; localStorage when the page is opened as a
// plain file for testing; memory as a last resort.
const memory = {};
const store = {
  async get(key) {
    try {
      if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key];
    } catch {}
    try {
      const v = localStorage.getItem(`setupcheck:${key}`);
      return v === null ? undefined : JSON.parse(v);
    } catch {
      return memory[key];
    }
  },
  async set(key, value) {
    try {
      if (globalThis.chrome?.storage?.local) return await chrome.storage.local.set({ [key]: value });
    } catch {}
    try {
      localStorage.setItem(`setupcheck:${key}`, JSON.stringify(value));
    } catch {
      memory[key] = value;
    }
  },
};

// ---------------------------------------------------------------- helper

let helperMissing = false;

// One request to the native helper. Resolves to null when it is not installed
// or does not answer: callers then simulate or skip, never fail.
export async function helper(message, timeoutMs = 5000) {
  if (helperMissing || !globalThis.chrome?.runtime?.sendNativeMessage) return null;
  try {
    const res = await Promise.race([
      chrome.runtime.sendNativeMessage(HOST, message),
      sleep(timeoutMs).then(() => null),
    ]);
    return res && !res.error ? res : null;
  } catch (err) {
    if (/not found|forbidden/i.test(String(err?.message))) helperMissing = true;
    return null;
  }
}

export const helperAvailable = () => !helperMissing && !!globalThis.chrome?.runtime?.sendNativeMessage;

// ---------------------------------------------------------------- device

let devicePromise = null;

export function device() {
  devicePromise ??= (async () => {
    let id = await store.get("deviceId");
    if (!id) {
      id = uid();
      await store.set("deviceId", id);
    }
    const who = await helper({ cmd: "whoami" }, 3000);
    const ua = navigator.userAgentData;
    const platform = ua?.platform || navigator.platform || "This";
    const chromeBrand = ua?.brands?.find((b) => /Chrom/.test(b.brand));
    return {
      id,
      name: who?.name || `${platform} laptop ${id.slice(0, 4)}`,
      os: who?.os || platform,
      browser: chromeBrand ? `${chromeBrand.brand} ${chromeBrand.version}` : "Chrome",
      extension: globalThis.chrome?.runtime?.getManifest?.().version ?? "dev",
    };
  })();
  return devicePromise;
}

// ---------------------------------------------------------------- outbox

let outbox = [];
let outboxLoaded = false;
let flushing = false;
let online = null;
const listeners = new Set();

const state = () => ({ online, queued: outbox.length, url: CENTRAL_URL });
const emit = () => listeners.forEach((fn) => fn(state()));

export function onCentralState(fn) {
  listeners.add(fn);
  fn(state());
  return () => listeners.delete(fn);
}

function setOnline(v) {
  if (online !== v) {
    online = v;
    emit();
  }
}

async function loadOutbox() {
  if (outboxLoaded) return;
  outboxLoaded = true;
  const saved = (await store.get("outbox")) || [];
  outbox = [...saved, ...outbox];
}

// Queue a request for the central server. Order is kept: an incident is
// always created before it is updated.
export async function send(method, path, body) {
  await loadOutbox();
  outbox.push({ method, path, body });
  if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
  await store.set("outbox", outbox);
  emit();
  flush();
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    await loadOutbox();
    while (outbox.length) {
      const m = outbox[0];
      const res = await fetch(CENTRAL_URL + m.path, {
        method: m.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(m.body),
        signal: AbortSignal.timeout(3000),
      });
      // A 4xx will never succeed (bad or orphaned message): drop it, keep going.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      outbox.shift();
      await store.set("outbox", outbox);
      setOnline(true);
      emit();
    }
  } catch {
    setOnline(false);
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------- policies

let policies = null;
let policiesAt = 0;
let policyRequest = null;

async function refreshPolicies() {
  policiesAt = Date.now();
  try {
    const res = await fetch(`${CENTRAL_URL}/api/policies`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    policies = Object.fromEntries(data.policies.map((p) => [p.id, p]));
    await store.set("policies", policies);
    setOnline(true);
  } catch {
    setOnline(false);
    policies ??= (await store.get("policies")) || null;
  }
}

export async function policyFor(id) {
  if (Date.now() - policiesAt > POLICY_TTL_MS) {
    policyRequest ??= refreshPolicies().finally(() => (policyRequest = null));
    await policyRequest;
  }
  const base = DEFAULT_POLICIES[id] || { mode: "off", seconds: 3, execution: "simulated", params: {} };
  const remote = policies?.[id] || {};
  return { ...base, ...remote, params: { ...base.params, ...(remote.params || {}) } };
}

// Keep policies fresh and the outbox moving while the panel is open.
setInterval(() => {
  if (outbox.length) flush();
  if (Date.now() - policiesAt > POLICY_TTL_MS) refreshPolicies();
}, FLUSH_MS);
refreshPolicies();
