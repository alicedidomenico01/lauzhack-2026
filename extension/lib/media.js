// Shared by the microphone and camera checks: which devices really exist,
// and what a getUserMedia error actually means for the user.

const ALIAS = /^(default|communications)$/;
const ALIAS_PREFIX = /^(Default|Communications)\s*-\s*/;
const VIRTUAL = /virtual|obs|snap camera|manycam|xsplit|ndi|mmhmm|loopback|blackhole|soundflower|zoomaudio|teams audio/i;

// Chrome lists "default" (and "communications" on Windows) as extra entries
// that point at a real device. Two entries, one microphone. Testing "the other
// input" must mean another physical device, so we collapse them.
export function distinctDevices(devices, kind) {
  const list = devices.filter((d) => d.kind === kind);
  const alias = list.find((d) => d.deviceId === "default");
  const defaultName = alias ? alias.label.replace(ALIAS_PREFIX, "") : null;

  const out = [];
  for (const d of list) {
    if (ALIAS.test(d.deviceId)) continue;
    const name = d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${d.deviceId.slice(0, 6)}`;
    const isDefault =
      !!alias &&
      ((alias.groupId && alias.groupId === d.groupId) || defaultName === d.label);
    out.push({
      deviceId: d.deviceId,
      groupId: d.groupId,
      name,
      isDefault,
      isVirtual: VIRTUAL.test(d.label),
    });
  }

  // Put the system default first: it is what Meet and Teams use unless told otherwise.
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return out;
}

export function fillSelect(select, devices) {
  const current = select.value;
  select.innerHTML = "";
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent =
      d.name + (d.isDefault ? " (system default)" : "") + (d.isVirtual ? " (virtual)" : "");
    select.appendChild(opt);
  }
  if (devices.some((d) => d.deviceId === current)) select.value = current;
  select.hidden = devices.length < 2;
}

// Turns a getUserMedia failure into what is wrong and where to fix it.
// `permission` is true when the browser- or OS-level permission is the cause,
// so the caller can show the "open in a tab" help.
export function explainMediaError(err, kind) {
  const what = kind === "camera" ? "camera" : "microphone";
  const msg = String(err?.message || "");

  switch (err?.name) {
    case "NotAllowedError":
      if (/system/i.test(msg)) {
        return {
          status: "blocked",
          permission: true,
          text: `Your computer is blocking Chrome from the ${what}.`,
          hint: `macOS: System Settings → Privacy & Security → ${kind === "camera" ? "Camera" : "Microphone"} → turn on Google Chrome, then restart Chrome. Windows: Settings → Privacy → ${kind === "camera" ? "Camera" : "Microphone"} → allow desktop apps.`,
        };
      }
      return {
        status: "blocked",
        permission: true,
        text: `Chrome is blocking the ${what} for this check.`,
        hint: "",
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        status: "missing",
        permission: false,
        text: `No ${what} found. It is unplugged, disabled, or was just disconnected.`,
        hint: "Plug it back in or pick another device; the list updates by itself.",
      };
    case "NotReadableError":
    case "AbortError":
      return {
        status: "busy elsewhere",
        permission: false,
        text: `The ${what} exists but would not start.`,
        hint:
          kind === "camera"
            ? "Another app is probably holding it (Zoom, Teams, Photo Booth, a second Meet tab). Close it and try again."
            : "Another app may hold it exclusively, or the driver failed. Close other call apps and try again.",
      };
    default:
      return {
        status: "error",
        permission: false,
        text: `Could not open the ${what}: ${msg || err?.name || "unknown error"}.`,
        hint: "",
      };
  }
}
