// Wiring only: this file knows about sections and modules, not about
// microphones, sockets or pixels. Each integration lives in integrations/.

import { initAccordion, setStatus, mountOf } from "./ui/accordion.js";
import { mountNetwork } from "./integrations/network.js";
import { mountAudio } from "./integrations/audio.js";
import { mountCamera } from "./integrations/camera.js";
import { mountMemory } from "./integrations/memory.js";

const api = (key) => ({
  setStatus: (level, text) => setStatus(key, level, text),
});

const network = mountNetwork(mountOf("network"), api("network"));
const audio = mountAudio(mountOf("audio"), api("audio"));
const camera = mountCamera(mountOf("camera"), api("camera"));
const memory = mountMemory(mountOf("memory"), api("memory"));

let cameraWanted = false;

initAccordion((key, open) => {
  if (key !== "camera") return;
  cameraWanted = open;
  if (open) camera.start();
  else camera.stop();
});

async function boot() {
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
}

boot();

// Stop everything when the panel is not visible, so the mic and camera LEDs
// are honest and we do not poll a hidden page.
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
