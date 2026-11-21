# Setup Check · LauzHack 2026 (Nexthink challenge)

This tool catches what will break in your next call (for example, network, microphone, camera, CPU),
fixes it from IT with the employee's consent, checks that the fix worked, and
reports every incident with its diagnostics to a dashboard.

Note that for this challenge we rely on NexThink technology, which already allows to control remotely employee's devices. Therefore, some parts are deliberately not implemented since they should be filled with the real product integration.

Our project is made of two different parts:
| Part | What it is | Run it |
|---|---|---|
| `extension/` | Chrome side panel: the four checks, the alerts, the remote actions | `chrome://extensions` → Developer mode → Load unpacked → `extension/` |
| `central/` | The IT side: incident store, dashboard, action policies | `python3 central/server.py` → http://localhost:8787 |
| `extension/native/` | Optional macOS helper for the fixes a browser cannot do | `extension/native/install.sh <extension-id>` |

## The loop

Every failure, real or simulated, takes the same path (`extension/lib/remedy.js`):

1. **Sense**: a section measures something real on the device.
2. **Report**: an incident with diagnostics goes to the central server. If it is
   down, incidents wait in an outbox in `chrome.storage` and are sent when it is
   back; the panel header says `IT offline · N queued`.
3. **Propose**: the action and its mode come from IT's policy, fetched every 10 s
   (defaults are built in, so the panel works without a server).
4. **Act**: `real` runs on the device through the helper, `simulated` only goes
   through the motions. The incident records which one actually happened. Real or simulated depends if it can actually be run in-browser or if it's something that should be integrated later.
5. **Verify**: the check re-measures (sound is back, frames flow, speed is up,
   CPU is down). If it is still broken the incident is **escalated**, and the
   same fix is not retried for 45 s. 

## What the panel checks

Each section is a module in `extension/integrations/` that builds its own DOM and
exposes `{ start(), stop() }`. `extension/app.js` only wires them.

### Network

- A latency probe every 500 ms, and a real download from Cloudflare every second
  when no transfer is already running. The test payload is sized to last about
  200 ms at the current speed (40 KB to 2 MB), so measuring does not eat the
  bandwidth it measures.
- The ring fills on a square-root scale up to 25 Mb/s; green at 8 Mb/s, amber at
  2, red below. Details (latency, jitter, lost probes, Chrome's own estimate)
  sit behind the disclosure.
- A slow connection produces a **suggestion**, not an action: the banner has no
  buttons, because a browser cannot change networks. It closes itself when the
  speed recovers.

### Microphone

- Opens on panel start with raw audio: no echo cancellation, noise suppression
  or auto gain, because those would hide what we measure.
- **dead**: two seconds of digital silence, not even room noise. The check then
  tries every other *physical* input, real devices before virtual ones, and says
  which one works. If all are dead it blames the computer, not the microphone.
- **live**: it hears the room, so the microphone works; it asks for a few words.
- Once it hears a voice: **too quiet** (peak under -48 dBFS), **clipping**,
  **noisy room** (noise floor over -45 dBFS), or ok. A confirmed voice stays
  confirmed, so going quiet later does not flip it back to "no sound".
- Plugging in a headset changes the system default and the check follows it,
  because that is the device Meet uses. A device picked by hand is kept.

### Camera

- Frames come from the track itself (`MediaStreamTrackProcessor`), so the frame
  rate is real even when the section is collapsed. Two analyses per second.
- **Face detection, locally**: Tiny Face Detector (`vendor/face-api`, MIT, 1.5 MB
  with its model) on TensorFlow.js/WebGL. Fast pass at 224 px, a 416 px retry
  only when it misses. No image leaves the computer. If the model cannot load,
  the check falls back to frame-wide light and leaves framing grey.
- **Light in stops** (one stop is twice the light), computed in linear light on
  the *lit side* of the face, so a shadow on one half reads as side light rather
  than "dark". Backlit means the background is at least 2 stops brighter *and*
  the face is under 150/255. Too dark is under 70/255.
- **Framing**: face width between 11% and 50% of the frame, centre no lower than
  62%, no more than 22% off-centre, head not cut off at the top.
- Four chips (Image, Light, Framing, Smooth). The headline names the most urgent
  problem with its numbers and the fix; the preview overlays face brackets, a
  dashed target zone when framing is off, and zebra stripes on blown-out areas.
- Reported first, because they are unambiguous: unplugged, paused by the system,
  **frozen** (no new frame for 2.5 s), **black** (shutter or lens cover),
  **still image** (3 s of identical frames, a virtual camera placeholder),
  **choppy** (under 15 fps, from capture timestamps).

### Memory

- `chrome.system.cpu` and `chrome.system.memory`: system-wide CPU utilization and available memory.
- With the helper it also names the busiest CPU process and the largest memory
  process, and the actions can quit them.

### Demo injected "damages"

The ⚡ icon in a section header breaks that check on purpose: a slow connection, a
microphone that delivers digital silence, a camera whose frames stop, a runaway
process at high CPU. Everything downstream is the real code path, and the
incident is tagged `demo` in the banner and in the dashboard. Triggering a
simulated failure again always produces a fresh alert, even if the previous one
was rejected seconds earlier.

## Alerts and actions

Banners stack in the corner and **wait for an answer**: Confirm and Reject. There
is no countdown, because an alert that disappears while you are in a meeting is
the same as no alert. Only a result ("fixed") fades on its own.

| Failure | Action | Execution |
|---|---|---|
| Slow or no connection | Suggest switching network (no action applied) | none |
| Microphone sends no sound | Restore the microphone (input volume) | real via helper |
| System mic dead, another works | Make the working one the system default | real via helper |
| Voice too quiet / clipping | Input volume up or down | real via helper |
| Camera frozen | Restart the camera stream | real, inside the panel |
| Camera black | Report only: shutter or cover | none |
| CPU overloaded / memory full | Quit the top app, never Chrome or system apps | helper, simulated by default |

Policy modes: **auto** (banner with Confirm and Reject), **ask** (same, worded as
a suggestion), **suggest** (informational banner, no buttons), **off** (report
only). Execution is a property of the action, not a setting: the dashboard shows
it as a read-only badge. Each policy also carries a free-text **reference** for
your own runbook or ticket queue.

## The dashboard

`python3 central/server.py` serves a single-page app at http://localhost:8787 and
a small JSON API on the same port.

| Tab | What it shows |
|---|---|
| Reports | Every incident, filterable by text, status and section. Each row carries a **Source** badge: `live` (came from a device now), `seeded` (generated history), `demo` (triggered on purpose). Click a row for the timeline and raw diagnostics. |
| Stats → Employees | One row per person: role, department, office, reports, fixed, rejected, estimated time saved. Click a person to filter Reports. |
| Stats → Company | KPIs, what breaks most, volume per day, reports by department. |
| Actions | The policies above, editable, with Save. |

Every report belongs to a person. Seeded employees are `Employee 1`,
`Employee 2`, and so on; anything reporting from this laptop is `You`.

**Time saved is an estimate, not a measurement.** Every fixed incident is
credited with 3 minutes, whatever failed. The number is deliberately flat: it is
simple to explain and it does not pretend to model how long each failure really
costs. The info icon in the UI says so.

The first start seeds a simulated fleet (about 180 devices, 14 days) so the
charts have something to show. It follows a weekly shape with one bad day and
per-day noise, and it is labelled `seeded` everywhere. `POST /api/fleet` reseeds
it, `DELETE /api/incidents` clears live reports.

## First run

```bash
python3 central/server.py          # seeds the fleet on first start
```

Then load `extension/` unpacked and pin it. After pulling changes press ↻
**Reload** on the extension card and reopen the panel.

If the microphone or camera will not open: Chrome cannot show its prompt inside a
side panel. Click **Open in a tab to allow** in the failing section, grant it
there, close the tab and reload. On macOS also check System Settings → Privacy &
Security → Camera / Microphone → Google Chrome, and
`chrome://settings/content/camera`.

## The native helper (optional)

```bash
extension/native/install.sh <extension-id>   # id is on chrome://extensions
```

It writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.setupcheck.host.json`
and points it at `host.py` (Python 3, no packages). It unlocks:

- the Wi-Fi name (SSID), via `networksetup` then `system_profiler`;
- real CPU and memory detail: total CPU, free memory, the top CPU process and
  the largest memory process;
- the real actions: set input volume, switch the system microphone, join a known
  Wi-Fi, ask an app to quit (Chrome and a protected list are always refused).

Without it, everything still runs; the actions simply report themselves as
simulated, and the panel says the helper is off.

## Limits worth knowing

- A browser cannot read the Wi-Fi SSID, enumerate nearby networks, or bind a
  request to another interface.
- A browser cannot change networks, so the network alert only suggests it.
- Speed is measured against a test server, not the actual call quality.
- Seeded history is generated. Only rows marked `live` or `demo` come from this
  machine.

## Layout

```
extension/
  manifest.json           MV3: sidePanel, nativeMessaging, system.cpu/memory, storage
  app.js                  wiring: mounts the sections, starts and stops them
  sidepanel.html          the four section shells
  ui/                     accordion, action banners, demo ⚡ button, ring, permissions help
  lib/                    central link + outbox, remedy loop, media errors, face detector
  integrations/           network, audio, camera, memory
  native/                 host.py and its installer
  vendor/face-api/        face-api 1.7.15 + Tiny Face Detector (MIT)
central/
  server.py               stdlib HTTP server, SQLite store, policies, fleet seed
  dashboard.html/.css/.js Reports, Stats, Actions (dark theme)
  central.db              created at first run, gitignored
```
