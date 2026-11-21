# Setup Check — Chrome extension

A side panel that answers one question before a meeting: **is my microphone
actually picking me up?** If it isn't, it offers the other input and retests.

## There is nothing to deploy

Chrome extensions are not "deployed" during a hackathon. There is no build
step, no server, no store listing. You load the folder **unpacked** and Chrome
runs it directly from disk. That is the whole loop.

### Load it (once per machine)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder
4. Pin the extension, click its icon → the side panel opens

### After you pull changes

Click the ↻ **Reload** button on the extension's card in `chrome://extensions`.
Any panel already open must be closed and reopened.

### A teammate, from a fresh clone

```bash
git clone git@github.com:alicedidomenico01/lauzhack-2026.git
cd lauzhack-2026
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick
`lauzhack-2026/extension`. Same three clicks, no build.

> Publishing to the Chrome Web Store is the only thing that resembles
> deployment: a $5 developer account and a review that takes days. Not for a
> 48-hour hackathon. A `.zip` of the folder is enough to share with judges.

## Where things run

| Layer | File | What it does |
|---|---|---|
| Shell | `manifest.json` | declares the side panel; requests **only** `sidePanel` |
| Service worker | `background.js` | opens the panel on icon click. No audio here — an MV3 service worker cannot hold a microphone stream |
| UI + logic | `sidepanel.html/.css/.js` | samples the mic, computes dBFS, decides pass/fail, offers the retest |

**Inputs:** the selected microphone, via `getUserMedia`, sampled 100 ms at a
time. No system logs, no network probe, no camera yet.

**Decision:** peak level above −45 dBFS for at least 400 ms counts as "sound".
Everything is local; nothing is recorded, stored or uploaded.

**Action:** the only real one is switching the *test* input and retesting.
It does **not** change the device Meet is using — the panel tells the user to
pick it in Meet's settings. A Nexthink remote action would do that; we don't
pretend to be connected to one.

## Known limits

- The side panel is its own page. If `getUserMedia` misbehaves inside the
  panel, open the same page in a tab (`chrome-extension://<id>/sidepanel.html`)
  — same code, and it proves the logic is not tied to the panel.
- Two inputs are needed for the interesting demo. A laptop alone usually has
  one; a headset gives you a second.
- No content script on `meet.google.com` yet: nothing reads or clicks Meet's
  buttons. That is the next step, and it is the fragile one.

## Next steps, in order

1. Verify the loop on a real laptop with a headset (dead input → retest → pass).
2. Add a content script that detects a Meet tab and shows the panel only there.
3. Add the network probe as a second, independent check.
4. Only then: read Meet's own mic state, so we can say "you are muted" instead
   of only "your mic is silent".
