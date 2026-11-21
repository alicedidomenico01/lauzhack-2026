// Wiring only: this file knows about sections and modules, not about
// microphones, sockets or pixels. Each integration lives in integrations/.

import { initAccordion, paintDot, dotOf, mountOf } from "./ui/accordion.js";
import { mountNetwork } from "./integrations/network.js";
import { mountAudio } from "./integrations/audio.js";
import { mountCamera } from "./integrations/camera.js";
import { mountMemory } from "./integrations/memory.js";
import { createRemedy } from "./lib/remedy.js";
import { onCentralState, CENTRAL_URL } from "./lib/central.js";
import { addDamageToggle } from "./ui/damage.js";

const LABELS = { network: "Network", audio: "Microphone", camera: "Camera", memory: "CPU & memory" };
// What the demo damage button breaks in each section.
const DAMAGE = {
  network: "a slow network",
  audio: "a dead microphone",
  camera: "a frozen camera",
  memory: "a CPU overload",
};

// Any runtime error becomes visible in the footer instead of dying silently.
const footer = document.querySelector("footer p");

function showError(message) {
  if (!footer) return;
  footer.textContent = `Error: ${message}`;
  footer.style.color = "#ef5f5f";
  console.error("[setup-check]", message);
}

window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) =>
  showError(String(e.reason?.message ?? e.reason))
);

// What each integration gets: its status dot, its remote-action engine, and
// damageChanged(), set below, to flip the demo button back when a fix clears it.
const api = (key) => {
  const dot = dotOf(key);
  return {
    setStatus: (level, text) => paintDot(dot, level, text),
    remedy: createRemedy(key, LABELS[key]),
    damageChanged: null,
  };
};

const rowOf = (key) => document.querySelector(`.row[data-key="${key}"]`);

function openRow(key) {
  const row = rowOf(key);
  if (row && !row.classList.contains("open")) row.querySelector(".row-head").click();
}

// Header link to the IT dashboard, with the state of the connection to it.
function initItLink() {
  const link = document.querySelector("[data-it]");
  if (!link) return;
  const text = link.querySelector("span");
  link.href = CENTRAL_URL;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url: CENTRAL_URL });
    else window.open(CENTRAL_URL, "_blank");
  });
  onCentralState(({ online, queued }) => {
    link.className = `it-link${online === true ? " online" : online === false ? " offline" : ""}`;
    text.textContent =
      online === true ? "Reporting to IT" : online === false ? `IT offline${queued ? ` · ${queued} queued` : ""}` : "IT";
    link.title = online === false ? `Cannot reach ${CENTRAL_URL}. Incidents are kept and sent later.` : `Open the IT dashboard (${CENTRAL_URL})`;
  });
}

let cameraWanted = false;

try {
  const apis = { network: api("network"), audio: api("audio"), camera: api("camera"), memory: api("memory") };
  const network = mountNetwork(mountOf("network"), apis.network);
  const audio = mountAudio(mountOf("audio"), apis.audio);
  const camera = mountCamera(mountOf("camera"), apis.camera);
  const memory = mountMemory(mountOf("memory"), apis.memory);
  const modules = { network, audio, camera, memory };

  for (const [key, mod] of Object.entries(modules)) {
    const toggle = addDamageToggle(rowOf(key), {
      label: DAMAGE[key],
      onChange: (on) => {
        mod.setDamage(on);
        if (on) openRow(key); // show what breaks (and starts the camera if needed)
      },
    });
    apis[key].damageChanged = (on) => toggle.set(on);
  }

  initItLink();

  initAccordion((key, open) => {
    if (key !== "camera") return;
    cameraWanted = open;
    if (open) camera.start();
    else camera.stop();
  });

  const boot = async () => {
    network.start();
    audio.start();
    memory.start();

    // Only open the camera unasked when permission already exists: a permission
    // prompt the moment the panel opens would be hostile.
    try {
      const perm = await navigator.permissions.query({ name: "camera" });
      if (perm.state === "granted") {
        cameraWanted = true;
        camera.start();
      }
    } catch {
      /* Permissions API unavailable: the section handles it on first open. */
    }
  };

  boot();

  // Stop everything when the panel is hidden: the mic and camera LEDs must be
  // honest, and a hidden page should not poll.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      network.stop();
      audio.stop();
      memory.stop();
      if (camera.isActive()) camera.stop();
      return;
    }

    network.start();
    audio.start();
    memory.start();
    if (cameraWanted) camera.start();
  });
} catch (err) {
  showError(err.message);
}
