// A short, cancellable "I am about to do this" banner.
// The countdown is the point: the agent announces the action before applying it.

export function showAction({ title, detail, seconds = 3, onApply, onCancel }) {
  document.querySelectorAll(".action-banner").forEach((n) => n.remove());

  const el = document.createElement("div");
  el.className = "action-banner";

  const body = document.createElement("div");
  body.className = "action-body";

  const h = document.createElement("p");
  h.className = "action-title";
  h.textContent = title;

  const p = document.createElement("p");
  p.className = "action-detail";
  p.textContent = detail;

  body.append(h, p);

  const cancel = document.createElement("button");
  cancel.className = "action-cancel";
  cancel.textContent = "Cancel";

  const progress = document.createElement("div");
  progress.className = "action-progress";
  const fill = document.createElement("span");
  progress.appendChild(fill);

  el.append(body, cancel, progress);
  document.body.appendChild(el);

  // Force a frame so the transition runs from 100% to 0%.
  requestAnimationFrame(() => {
    fill.style.transition = `width ${seconds}s linear`;
    fill.style.width = "0%";
  });

  const timer = setTimeout(() => {
    el.remove();
    onApply?.();
  }, seconds * 1000);

  cancel.addEventListener("click", () => {
    clearTimeout(timer);
    el.remove();
    onCancel?.();
  });

  return { cancel: () => cancel.click() };
}
