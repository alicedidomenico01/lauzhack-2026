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
  every 12 s (1 MB from a CORS-enabled endpoint, smoothed across samples). The
  ring is centred, shows the speed inside it, and fills on a square-root scale
  up to 25 Mb/s; colours: **≥8 Mb/s green**, **≥2 amber**, below that red. The
  connection type sits under the verdict. When red, **Switch Network** appears:
  Chrome cannot switch Wi-Fi, so you change it in the OS and the button
  disappears as soon as the connection signature changes, leaving a live
  **±Mb/s** badge against the speed you had before. The small icon top-right of
  the ring toggles a **demo mode** that fakes a shaky connection (and resets
  everything when turned off). Everything else lives behind **Details**.

  The SSID (e.g. `freewifi-epfl`) is **not** available to a browser — it needs
  the native helper described below.
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

## Wi-Fi name (SSID) — needs the local helper

A browser cannot read the SSID; `navigator.connection` only gives `wifi` and
`4G`. The SSID lives in the OS, so the panel asks a small native process:

```bash
cd extension/native
./install.sh <extension-id>     # id is on chrome://extensions
```

That writes
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.setupcheck.host.json`
and points it at `host.py` (stdlib only, no dependencies). Reload the extension;
the panel then shows `freewifi-epfl` instead of `Wi-Fi · 4G`, refreshed every 5 s.

`host.py` tries `networksetup -getairportnetwork`, then
`system_profiler SPAirPortDataType -json`. macOS may return `<redacted>` unless
Location Services is allowed for the terminal that launched Chrome — that is an
OS rule, not a bug in the helper. Without the helper the panel silently falls
back to the connection type, so nothing breaks.



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
