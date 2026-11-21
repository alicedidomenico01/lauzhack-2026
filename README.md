# Setup Check · LauzHack 2026 (Nexthink challenge)

Catches what will break in your next call (network, microphone, camera, CPU),
fixes it remotely with a 3-second opt-out, checks that the fix worked, and
reports every incident with its diagnostics to IT.

| Part | What it is | Run it |
|---|---|---|
| `extension/` | Chrome side panel: the four checks and the remote actions | `chrome://extensions` → Developer mode → Load unpacked → `extension/` |
| `central/` | The IT side: receives incidents, serves the dashboard, holds the action policies | `python3 central/server.py` → http://localhost:8787 |
| `extension/native/` | Optional macOS helper for real fixes (input volume, mic switch, Wi-Fi, quit app) | `extension/native/install.sh <extension-id>` |

Everything is standard library / plain JS: no build, no `npm install`, no `pip install`.

## Demo script (3 minutes)

1. Start `python3 central/server.py`, open http://localhost:8787 in one tab, the side panel in another window.
   The header of the panel says **Reporting to IT**.
2. Everything is green. Click the ⚡ in **Microphone**: the mic goes silent.
   Within 2 s the check says it sends no sound, and the banner announces
   **Fixing remotely · Restore the microphone**, with a 3-second bar and **Reject**.
3. Let it run: input volume is set (for real with the helper), the meter comes back,
   the banner says **Fixed · verified on this device**.
4. Switch to the dashboard: the incident is at the top of **Live from devices**, with the
   diagnostics taken at detection and after the fix, and the timeline.
5. Do it again with ⚡ **Camera** and press **Reject**: nothing changes, the dashboard shows *rejected*.
6. In **Remote actions**, set *Camera frozen* to **Ask first**, save, wait 10 s, ⚡ Camera again:
   now the employee gets **Fix it / Not now**. The policy came from IT.
7. Company view: what breaks most, the peak just before meetings, hours given back.
   (The fleet history is simulated and labelled as such; the live incidents are real.)
