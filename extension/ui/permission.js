// Chrome cannot show a camera/microphone prompt inside a side panel.
// The fix is to open the same page as a normal tab, grant once, come back:
// permissions are per extension origin, so the panel inherits them.

export function permissionHelp(root, kind) {
  // start() runs again every time the panel comes back: show the help once.
  root.querySelectorAll(".perm-help").forEach((n) => n.remove());

  const box = document.createElement("div");
  box.className = "perm-help";

  const text = document.createElement("p");
  text.textContent = `Chrome will not show its ${kind} prompt inside the side panel.`;

  const button = document.createElement("button");
  button.className = "ghost";
  button.textContent = "Open in a tab to allow";
  button.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
  });

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent =
    "Grant it there, then close the tab and reload this panel. Also check macOS → System Settings → Privacy & Security → Camera/Microphone → Google Chrome.";

  box.append(text, button, hint);
  root.appendChild(box);
}
