# Setup Check — Chrome extension

A side panel with four collapsible checks that answer: **what will break in this
meeting?** Everything runs live and locally. No backend, no storage, no upload.

## There is nothing to deploy

Load the folder **unpacked**; Chrome runs it from disk. No build, no store.

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Pin it, click the icon → the side panel opens

After pulling changes: ↻ **Reload** on the extension card, then reopen the panel.

## Layout

```
extension/
  manifest.json          MV3. Permissions: sidePanel + gstatic.com for the probe
  background.js          opens the panel on icon click (no audio here)
  sidepanel.html         the four section shells
  styles/sidepanel.css
  app.js                 wiring only: mounts modules, starts/stops them
  ui/
    accordion.js         open/close + status pill
    ring.js              circular gauge
  integrations/
    network.js           continuous RTT/jitter/failure sampling
    audio.js             live mic meter + automatic verdict
    camera.js            live preview + exposure/backlight analysis
    memory.js            device class + event-loop lag
```

Each integration exports `mountX(root, { setStatus })` and returns
`{ start(), stop() }`. It builds its own DOM, so adding a fifth check means one
new file and one line in `app.js`.

## Behaviour

- **Network** probes latency every 500 ms and measures real download speed
  every 12 s (500 KB from a CORS-enabled endpoint). The ring is centred, shows
  the speed inside it, and fills at **2 Mb/s**; colour thresholds are
  1.5 Mb/s (green) and 0.6 Mb/s (amber, below that red). Under the verdict sits
  the connection type ("Wi-Fi · 4G"). When red, a **Switch Network** button
  appears: Chrome cannot switch Wi-Fi, so it tells you to use the OS menu and
  then shows a live **±% speed** badge against the speed you had before
  switching. The small icon top-right of the ring toggles a **demo mode** that
  fakes a shaky connection. Everything else lives behind **Details**.
- **Microphone** opens on panel start, shows a live meter, and decides by
  itself: sound within the last 3 s = ok, 12 s of silence = it switches to the
  other input once and reports which one works.
- **Camera** starts on its own **only if camera permission already exists**;
  otherwise it starts when you first open the section (first use always needs a
  prompt). Live preview, verdict recomputed every 700 ms.
- **Memory** reports device RAM, cores, event-loop lag and the lag trend. If lag
  is high or climbing, a **"Fixing remotely…"** banner appears with a 3 s
  countdown and a Cancel button — the announce-then-act pattern, simulated.
- Everything stops when the panel is hidden, so the mic and camera LEDs are
  honest.

## Camera or microphone will not open

Chrome **cannot show a camera/microphone prompt inside a side panel**, so the
first grant has to happen in a tab:

1. In the failing section, click **Open in a tab to allow** (same page, normal
   tab) — the prompt appears there.
2. Grant it, close the tab, press ↻ **Reload** in `chrome://extensions`.
3. If the prompt never appears at all: macOS → System Settings → Privacy &
   Security → **Camera / Microphone** → enable **Google Chrome**.
4. If it is blocked, not missing: `chrome://settings/content/camera` and
   `/microphone` → check the extension is not in "Not allowed".

Once granted for the extension origin, the side panel inherits it.


## What each check can and cannot see

| Section | Real input | Cannot |
|---|---|---|
| Network | RTT, jitter, failures, `navigator.connection` | **Other networks around you.** No browser API enumerates Wi-Fi or binds a request to another interface — a worker thread does not help, it is a permission boundary, not a concurrency one |
| Microphone | `getUserMedia` + AudioContext RMS | Change the device Meet uses |
| Camera | one frame every 700 ms → luminance, centre/edge ratio | Change your lighting |
| Memory | `deviceMemory`, cores, event-loop lag | Read system memory |

The honest fix for the two "cannot" rows is a **native messaging host** — a
small local binary that runs `networkQuality -c` (built into macOS), CoreWLAN
scans, `vm_stat` and audio-device switching. That is also the bridge from
"detect" to "act".

## Next

1. Verify all four on a real laptop with a headset.
2. Content script on `meet.google.com`: show the panel only there, read mute state.
3. Native helper: `networkQuality`, SSID + interface, `vm_stat`, default input.
