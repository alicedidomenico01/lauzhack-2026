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

- **Network** attempts a latency probe every 500 ms and measures download
  throughput from Cloudflare every second when no test is already in flight.
  This measures the current Internet path to a test server, not Wi-Fi signal
  strength or Meet call quality. **Switch Network** saves the current reading;
  switch in the OS, then use **Retest after switching Wi-Fi**. If the helper
  reports a changed Wi-Fi name, the retest starts automatically. The badge
  compares actual readings. The demo toggle is explicitly labeled and never
  feeds the live comparison. Without a reported SSID, the panel shows
  **Wi-Fi name unavailable**.
- **Microphone** opens on panel start, shows a live meter, and decides by
  itself: sound within the last 3 s = ok, 12 s of silence = it switches to the
  other input once and reports which one works.
- **Camera** starts on its own **only if camera permission already exists**;
  otherwise it starts when you first open the section (first use always needs a
  prompt). Live preview, verdict recomputed every 700 ms.
- **Memory** uses Chrome's `system.cpu` and `system.memory` extension APIs.
  It shows system-wide CPU utilization (after two samples) and available
  memory without a native helper. It warns on high load or low available
  memory. These APIs do not identify individual processes.
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
and points it at `host.py` (Python 3, no external packages). Reload the
extension. It asks the helper for the Wi-Fi name every 5 s.

`host.py` tries `networksetup -getairportnetwork`, then
`system_profiler SPAirPortDataType -json`. Whether macOS returns a Wi-Fi name
depends on the OS version, connection, and location privacy settings. If no
real name comes back, the extension does not substitute one.



## What each check can and cannot see

| Section | Real input | Cannot |
|---|---|---|
| Network | RTT, jitter, failures, `navigator.connection` | **Other networks around you.** No browser API enumerates Wi-Fi or binds a request to another interface — a worker thread does not help, it is a permission boundary, not a concurrency one |
| Microphone | `getUserMedia` + AudioContext RMS | Change the device Meet uses |
| Camera | one frame every 700 ms → luminance, centre/edge ratio | Change your lighting |
| Memory | System-wide CPU usage and available memory via Chrome extension APIs | Per-process attribution and OS-level fixes |

The honest fix for the two "cannot" rows is a **native messaging host** — a
small local binary that runs `networkQuality -c` (built into macOS), CoreWLAN
scans, `vm_stat` and audio-device switching. That is also the bridge from
"detect" to "act".

## Next

1. Verify all four on a real laptop with a headset.
2. Content script on `meet.google.com`: show the panel only there, read mute state.
3. Native helper: `networkQuality`, SSID + interface, `vm_stat`, default input.
