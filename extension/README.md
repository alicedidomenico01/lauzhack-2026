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

- **Network** samples 3 probes every 5 s and animates the ring. No click.
- **Microphone** opens on panel start, shows a live meter, and decides by
  itself: sound within the last 3 s = ok, 12 s of silence = it switches to the
  other input once and reports which one works.
- **Camera** starts on its own **only if camera permission already exists**;
  otherwise it starts when you first open the section (first use always needs a
  prompt). Live preview, verdict recomputed every 700 ms.
- **Memory** reports device RAM, cores and event-loop lag every 2.5 s.
- Everything stops when the panel is hidden, so the mic and camera LEDs are
  honest.

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
