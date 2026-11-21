// Wiring only: this file knows about sections and modules, not about
// microphones, sockets or pixels. Each integration lives in integrations/.

import { initAccordion, paintDot, dotOf, mountOf } from "./ui/accordion.js";
import { mountNetwork } from "./integrations/network.js";
import { mountAudio } from "./integrations/audio.js";
import { mountCamera } from "./integrations/camera.js";
import { mountMemory } from "./integrations/memory.js";

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

// The dot element is resolved once per section, then handed to the integration.
const api = (key) => {
  const dot = dotOf(key);
  return { setStatus: (level, text) => paintDot(dot, level, text) };
};

let cameraWanted = false;

try {
  const network = mountNetwork(mountOf("network"), api("network"));
  const audio = mountAudio(mountOf("audio"), api("audio"));
  const camera = mountCamera(mountOf("camera"), api("camera"));
  const memory = mountMemory(mountOf("memory"), api("memory"));

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
