# Setup Check · LauzHack 2026 (Nexthink challenge)

Catches what will break in your next call (network, microphone, camera, CPU),
fixes it from IT with the employee's consent, checks that the fix worked, and
reports every incident with its diagnostics to a dashboard.

| Part | What it is | Run it |
|---|---|---|
| `extension/` | Chrome side panel: the four checks, the alerts, the remote actions | `chrome://extensions` → Developer mode → Load unpacked → `extension/` |
| `central/` | The IT side: incident store, dashboard, action policies | `python3 central/server.py` → http://localhost:8787 |
| `extension/native/` | Optional macOS helper for fixes a browser cannot do | `extension/native/install.sh <extension-id>` |

Standard library Python and plain JS: no build, no `npm install`, no `pip install`.

## The loop

1. **Sense**: each section measures something real on the device.
2. **Report**: a failure becomes an incident with diagnostics (queued in
   `chrome.storage` if the server is down).
3. **Propose**: the action and its mode come from IT's policy, fetched every 10 s.
4. **Act**: `real` runs on the device through the helper, `simulated` only reports.
5. **Verify**: the check re-measures. Not fixed means the incident is escalated.

## What the panel checks

| Section | Measured | Notable failure states |
|---|---|---|
| Network | Download speed (Cloudflare transfer, every second) and latency/jitter/lost probes | no connection, very slow |
| Microphone | Raw audio (no AGC or noise suppression), voice peak, noise floor | dead (digital silence), too quiet, clipping, noisy room, wrong system default |
| Camera | Real frames, fps, resolution, exposure in stops, face position | black, frozen, still image, too dark, backlit, side light, bad framing |
| Memory | `chrome.system.cpu` and `chrome.system.memory` | high CPU, low available memory |

Camera face detection runs locally (face-api Tiny Face Detector, MIT, vendored).
No image leaves the computer. Without the helper there is no per-process
attribution, so memory reports system-wide numbers only.

The **⚡ button** in a section header triggers that failure on purpose. It goes
through the same code path and is tagged `demo` everywhere.

## The dashboard

`Reports` lists every incident with a **Source** badge: `live` (came from a
device now), `seeded` (generated history, first run), `demo` (triggered on
purpose). `Stats` switches between **Employees** and **Company**; employees are
`Employee N`, and anything reporting from this laptop is `You`. `Actions` holds
the policies, including a free-text reference for your own runbook or queue.

Time saved is an estimate: every fixed incident is credited with the minutes
that failure usually costs, not measured.

## Action policies

| Failure | Action | Execution |
|---|---|---|
| Slow or no connection | Suggest switching network (no action applied) | none |
| Microphone sends no sound | Restore the microphone (input volume) | real via helper |
| System mic dead, another works | Make the working one the system default | real via helper |
| Voice too quiet / clipping | Input volume up or down | real via helper |
| Camera frozen | Restart the camera stream | real, in the panel |
| Camera black | Report only: shutter or cover | none |
| CPU overloaded / memory full | Quit the top app (never Chrome or system apps) | helper, simulated by default |

Modes: **auto** (banner with Confirm and Reject), **ask** (same, worded as a
suggestion), **suggest** (informational banner, no buttons), **off** (report
only). Banners stack and wait for an answer; they never expire. A rejection
silences that issue for 60 s, a failed fix for 45 s.

## First run

```bash
python3 central/server.py          # seeds a simulated fleet on first start
```

Then load `extension/` unpacked. If the microphone or camera will not open,
Chrome cannot show its prompt inside a side panel: click **Open in a tab to
allow** in the failing section, grant it there, and reload. On macOS also check
System Settings → Privacy & Security → Camera / Microphone → Google Chrome.

The optional helper adds the Wi-Fi name, per-process CPU and memory, and the
real actions:

```bash
extension/native/install.sh <extension-id>   # id is on chrome://extensions
```

## Limits worth knowing

- A browser cannot read the Wi-Fi SSID or enumerate nearby networks; that needs
  the helper. Without it the panel shows the fixed label `freewifi-epfl`.
- A browser cannot change networks, so the network alert only suggests it.
- Speed is measured against a test server, not the actual call quality.
- Seeded history is generated; only rows marked `live` or `demo` come from this
  machine.

## Layout

```
extension/
  app.js                  wiring: mounts the sections, starts and stops them
  ui/                     accordion, action banners, demo ⚡ button, ring
  lib/                    central link, remedy loop, media errors, face detector
  integrations/           network, audio, camera, memory
  native/                 macOS helper (host.py) and its installer
central/
  server.py               stdlib HTTP server, SQLite store, policies, seed
  dashboard.html/.css/.js Reports, Stats, Actions
```
