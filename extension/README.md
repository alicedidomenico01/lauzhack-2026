# Setup Check — Chrome extension

A side panel with four collapsible checks that answer: **what will break in this
meeting?** Each check measures something real on the machine. No backend, no
storage, nothing uploaded.

## There is nothing to deploy

Load the folder **unpacked**; Chrome runs it from disk. No build, no store.

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Pin it, click the icon → the side panel opens

After pulling changes: ↻ **Reload** on the extension card, then reopen the panel.

A teammate with a fresh clone does the same three clicks. Publishing to the
Chrome Web Store ($5 + days of review) is the only thing resembling deployment,
and it is not worth it here.

## The four sections

| Section | Real input | Verdict | What we cannot do |
|---|---|---|---|
| **Network** | 6 timed requests to a 204 endpoint: median RTT, jitter, failures, plus `navigator.connection` type/downlink | stable / shaky / unreliable | A browser **cannot enumerate nearby Wi-Fi networks or their signal**. Comparing "my hotspot is stronger" needs a native helper (see below) |
| **Microphone** | `getUserMedia` + AudioContext, 100 ms RMS sampling, 3 s test | picks you up / silent | We cannot change the device Meet is using — the panel says so |
| **Camera** | one frame → mean luminance + centre/edge ratio | fine / too dark / backlit | We cannot change your room lighting |
| **Memory** | `navigator.deviceMemory`, `hardwareConcurrency`, event-loop lag | responsive / stutter / struggling | A browser **cannot read system memory**. Real pressure needs a native helper |

Every check also has a small **action** where one honestly exists: the mic check
switches to the other input and retests by itself, and tells you to pick it in
Meet. The rest report and point.

## Where things run

| File | Role |
|---|---|
| `manifest.json` | MV3. Permissions: `sidePanel` + host access to `gstatic.com` for the probe |
| `background.js` | opens the panel on icon click. No audio: a service worker cannot hold a mic stream |
| `sidepanel.html/.css/.js` | the UI, all detectors, all decisions |

## Feasibility notes (the honest version)

- **"Your hotspot is stronger than this Wi-Fi"** — not collectable from a
  browser. Chrome exposes no Wi-Fi scanning API. Two options later: (a) run the
  network check once per network and compare the stored results, or (b) a
  **native messaging host** — a tiny local binary that runs
  `system_profiler SPAirPortDataType` / `wdutil` and returns interface type,
  current SSID and link quality. That is a real Nexthink-shaped piece of work,
  and it is also the only way to get **real memory** (`vm_stat`) and real CPU.
- **Meet's own mic state** — readable from the DOM once we add a content script
  on `meet.google.com`. That is the fragile step; it comes after these four
  checks work.
- **Remote action** — a Nexthink-style fix (restart an audio service, switch the
  OS default input) needs the same native host. Until then we simulate the
  *process*, never the result: we say what we would do, we do not claim we did it.

## Next

1. Verify all four on a real laptop with a headset (dead input → retest → pass).
2. Content script: show the panel only on Meet tabs, read mute state.
3. Native helper: interface type, SSID, `vm_stat`, default audio device — the
   bridge from "detect" to "act".
