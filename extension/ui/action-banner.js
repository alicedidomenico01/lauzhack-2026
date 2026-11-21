// Remote-action banners: IT says what it wants to do on this device, the
// employee decides. Nothing is applied on a timer — an alert that vanishes
// while you are in a meeting is the same as no alert. Several open at once
// stack, so it is obvious how many are waiting.

const STACK_ID = "action-stack";

const ICON = {
  wrench:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.5 1.5 0 0 0 2.1 2.1l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.1-.4-.4-2.1z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>',
};
ICON.bad = ICON.warn;

function stack() {
  let node = document.getElementById(STACK_ID);
  if (!node) {
    node = document.createElement("div");
    node.id = STACK_ID;
    node.className = "action-stack";
    node.setAttribute("aria-live", "polite");
    document.body.append(node);
  }
  return node;
}

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export function proposeAction({ section, title, detail, mode = "auto", simulated = false }) {
  let resolveChoice;
  const handle = {
    choice: new Promise((resolve) => (resolveChoice = resolve)),
    decided: false,
    node: null,
  };

  function decide(choice) {
    if (handle.decided) return;
    handle.decided = true;
    resolveChoice(choice);
    if (choice !== "apply") remove();
  }

  function remove() {
    const node = handle.node;
    if (!node) return;
    handle.node = null;
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 160);
  }

  handle.applyNow = () => decide("apply");
  handle.dismiss = () => {
    decide("dismissed");
    remove();
  };

  handle.progress = (text) => {
    if (!handle.node) return;
    handle.node.className = "action-banner working";
    handle.icon.innerHTML = '<span class="spinner"></span>';
    handle.titleEl.textContent = text;
    handle.detailEl.textContent = "";
    handle.buttons.replaceChildren();
  };

  handle.done = (level, text, sub = "") => {
    if (!handle.node) return;
    handle.node.className = `action-banner done ${level}`;
    handle.icon.innerHTML = ICON[level] || ICON.ok;
    handle.titleEl.textContent = text;
    handle.detailEl.textContent = sub;
    handle.buttons.replaceChildren();
    // A result is not something to act on: it can fade on its own.
    setTimeout(remove, level === "ok" ? 4000 : 6000);
  };

  const node = el("div", `action-banner ${mode}`);
  node.setAttribute("role", "alertdialog");
  node.setAttribute("aria-modal", "false");

  const icon = el("div", "action-icon", ICON.wrench);
  const body = el("div", "action-body");
  const kicker = el(
    "p",
    "action-kicker",
    mode === "auto" ? `IT can fix this · ${section}` : `IT suggests a fix · ${section}`
  );
  if (simulated) kicker.append(" ", el("span", "action-tag", "simulated"));

  const titleEl = el("p", "action-title");
  titleEl.textContent = title;

  const detailEl = el("p", "action-detail");
  detailEl.textContent = detail || "Nothing changes until you answer.";

  body.append(kicker, titleEl, detailEl);

  const buttons = el("div", "action-buttons");
  const yes = el("button", "action-yes", mode === "auto" ? "Confirm" : "Fix it");
  const no = el("button", "action-reject", "Reject");
  yes.type = no.type = "button";
  yes.addEventListener("click", () => decide("apply"));
  no.addEventListener("click", () => decide("reject"));
  buttons.append(yes, no);

  node.append(icon, body, buttons);
  stack().append(node);

  Object.assign(handle, { node, icon, titleEl, detailEl, buttons });
  return handle;
}
