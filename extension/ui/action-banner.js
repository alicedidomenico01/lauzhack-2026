// Remote-action banners: IT says what it wants to do on this device, the
// employee decides. Several open at once stack, so it is obvious how many are
// waiting. An unanswered banner fades after a while instead of staying on
// screen forever, and that is recorded as "no answer", not as a rejection.
// Hovering pauses the fade, so it can still be answered.

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

// `mode: "info"` has no decision to make: it is a suggestion, not an offer.
// Nothing to confirm, nothing to reject, so it shows no buttons at all.
const AUTO_DISMISS_MS = 10000;
const INFO_DISMISS_MS = 5000; // a suggestion has nothing to answer, so it leaves

export function proposeAction({ section, title, detail, mode = "auto", simulated = false, execution = null }) {
  const isInfo = mode === "info";
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
    isInfo
      ? `Suggestion · ${section}`
      : mode === "auto"
        ? `IT can fix this · ${section}`
        : `IT suggests a fix · ${section}`
  );
  // Two different facts, two different labels: what the fix will do, and
  // whether the failure itself was staged for the demo.
  if (execution && !isInfo) {
    const tag = el("span", `action-tag exec ${execution}`, execution);
    tag.title = execution === "real"
      ? "The fix runs on this device"
      : "The fix only goes through the motions and changes nothing";
    kicker.append(" ", tag);
  }
  if (simulated) {
    const tag = el("span", "action-tag demo", "demo");
    tag.title = "This failure was triggered on purpose from the panel";
    kicker.append(" ", tag);
  }

  const titleEl = el("p", "action-title");
  titleEl.textContent = title;

  const detailEl = el("p", "action-detail");
  detailEl.textContent = detail || "Nothing changes until you answer.";

  body.append(kicker, titleEl, detailEl);

  // A suggestion has no Confirm/Reject, so it needs its own way out.
  let close = null;
  if (isInfo) {
    close = el("button", "action-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss suggestion");
    close.title = "Dismiss";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      handle.dismiss();
    });
  }

  const buttons = el("div", "action-buttons");
  if (!isInfo) {
    const yes = el("button", "action-yes", mode === "auto" ? "Confirm" : "Fix it");
    const no = el("button", "action-reject", "Reject");
    yes.type = no.type = "button";
    yes.addEventListener("click", () => decide("apply"));
    no.addEventListener("click", () => decide("reject"));
    buttons.append(yes, no);
  }

  // A countdown the eye can follow: the bar empties, then the banner fades.
  const progress = el("div", "action-progress");
  const bar = el("span");
  progress.append(bar);

  let timer = 0;
  const stopTimer = () => {
    clearTimeout(timer);
    timer = 0;
    bar.style.transition = "none";
    bar.style.width = `${bar.getBoundingClientRect().width}px`;
  };
  const startTimer = (ms) => {
    stopTimer();
    requestAnimationFrame(() => {
      bar.style.transition = `width ${ms}ms linear`;
      bar.style.width = "0%";
    });
    timer = setTimeout(() => decide("timeout"), ms);
  };

  node.append(icon, body, buttons);
  if (isInfo) node.append(progress);
  if (close) node.append(close);
  stack().append(node);

  Object.assign(handle, { node, icon, titleEl, detailEl, buttons });

  if (isInfo) {
    startTimer(INFO_DISMISS_MS);
    // Reading it should stop the clock.
    node.addEventListener("mouseenter", stopTimer);
    node.addEventListener("focusin", stopTimer);
    const resume = () => {
      if (!handle.decided) startTimer(INFO_DISMISS_MS);
    };
    node.addEventListener("mouseleave", resume);
    node.addEventListener("focusout", resume);
  }

  return handle;
}
