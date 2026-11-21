// The remote-action banner: IT announces what it is about to do on this
// device, and the employee can say no. One banner at a time; the rest queue.
//
//   auto  "Fixing remotely in 3 s"  progress bar + Reject (opt-out)
//   ask   "IT suggests a fix"       Fix it / Not now      (opt-in)
// then    working…                  "Applying…", "Checking it worked…"
// then    done                      fixed / still broken / rejected, then fades
//
// proposeAction() returns a handle right away; `choice` resolves to "apply",
// "reject" or "dismissed" (the problem went away on its own before the end).

const queue = [];
let current = null;

const ICON = {
  wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.5 1.5 0 0 0 2.1 2.1l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.1-.4-.4-2.1z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9.5"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>',
};
ICON.bad = ICON.warn;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

export function proposeAction({ section, title, detail, seconds = 3, mode = "auto", simulated = false }) {
  let resolveChoice;
  const handle = {
    choice: new Promise((r) => (resolveChoice = r)),
    decided: false,
    node: null,
    timer: 0,
    applyNow() {
      decide("apply");
    },
    dismiss() {
      decide("dismissed");
      if (handle.node) finish(0);
    },
    progress(text) {
      if (!handle.node) return void (handle.pending = ["progress", text]);
      handle.node.className = "action-banner working";
      handle.icon.innerHTML = '<span class="spinner"></span>';
      handle.titleEl.textContent = text;
      handle.detailEl.textContent = ""; // the countdown line no longer applies
      handle.buttons.innerHTML = "";
      handle.bar.style.transition = "none";
      handle.bar.style.width = "0%";
    },
    done(level, text, sub = "") {
      if (!handle.node) return void (handle.pending = ["done", level, text, sub]);
      handle.node.className = `action-banner done ${level}`;
      handle.icon.innerHTML = ICON[level] || ICON.ok;
      handle.titleEl.textContent = text;
      handle.detailEl.textContent = sub;
      handle.buttons.innerHTML = "";
      finish(level === "ok" ? 3500 : 5000);
    },
  };

  function decide(choice) {
    if (handle.decided) return;
    handle.decided = true;
    clearTimeout(handle.timer);
    resolveChoice(choice);
    // Rejected or gone while still queued: it will never be shown. (An "apply"
    // stays queued: its progress and result are shown when its turn comes.)
    if (!handle.node && choice !== "apply") {
      const i = queue.indexOf(handle);
      if (i >= 0) queue.splice(i, 1);
    }
  }

  function finish(delay) {
    setTimeout(() => {
      handle.node?.classList.add("leaving");
      setTimeout(() => {
        handle.node?.remove();
        handle.node = null;
        if (current === handle) current = null;
        next();
      }, 180);
    }, delay);
  }

  handle.show = () => {
    const node = el("div", `action-banner ${mode}`);
    node.setAttribute("role", "alertdialog");
    node.setAttribute("aria-live", "assertive");
    const icon = el("div", "action-icon", ICON.wrench);
    const body = el("div", "action-body");
    const kicker = el(
      "p",
      "action-kicker",
      mode === "auto" ? `Fixing remotely · ${section}` : `IT suggests a fix · ${section}`
    );
    const titleEl = el("p", "action-title");
    titleEl.textContent = title;
    const detailEl = el("p", "action-detail");
    const howItWorks =
      mode === "auto" ? `Applies in ${seconds} s unless you reject it.` : "Nothing changes unless you say yes.";
    detailEl.textContent = detail ? `${detail} ${howItWorks}` : howItWorks;
    if (simulated) kicker.innerHTML += ' <span class="action-tag" title="Damage triggered on purpose from the panel">simulated</span>';
    body.append(kicker, titleEl, detailEl);

    const buttons = el("div", "action-buttons");
    if (mode === "auto") {
      const reject = el("button", "action-reject", "Reject");
      reject.type = "button";
      reject.addEventListener("click", () => decide("reject"));
      buttons.append(reject);
    } else {
      const yes = el("button", "action-yes", "Fix it");
      const no = el("button", "action-reject", "Not now");
      yes.type = no.type = "button";
      yes.addEventListener("click", () => decide("apply"));
      no.addEventListener("click", () => decide("reject"));
      buttons.append(yes, no);
    }

    const progress = el("div", "action-progress");
    const bar = el("span");
    progress.append(bar);
    node.append(icon, body, buttons, progress);
    document.body.append(node);
    Object.assign(handle, { node, icon, titleEl, detailEl, buttons, bar });

    if (handle.decided) {
      // Already accepted (by the employee) while queued: show where it is now.
      const [kind, ...args] = handle.pending || ["progress", "Applying…"];
      handle.pending = null;
      handle[kind](...args);
    } else if (mode === "auto") {
      // A real countdown the eye can follow: the bar empties as time runs out.
      requestAnimationFrame(() => {
        bar.style.transition = `width ${seconds}s linear`;
        bar.style.width = "0%";
      });
      handle.timer = setTimeout(() => decide("apply"), seconds * 1000);
    } else {
      bar.style.width = "0%";
    }
  };

  queue.push(handle);
  next();
  return handle;
}

function next() {
  if (current || !queue.length) return;
  current = queue.shift();
  current.show();
}
