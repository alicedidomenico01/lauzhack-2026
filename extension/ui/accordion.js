// Accordion behaviour + the status dot in each row header.

const DOT_COLORS = {
  ok: "#35c88a",
  warn: "#e8b23c",
  bad: "#ef5f5f",
  busy: "#4c8dff",
  idle: "#3a4452",
};

export function initAccordion(onToggle) {
  document.querySelectorAll(".row-head").forEach((head) => {
    head.addEventListener("click", () => {
      const row = head.closest(".row");
      const open = row.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
      onToggle?.(row.dataset.key, open);
    });
  });
}

export function setStatus(key, level, text) {
  const dot = document.querySelector(`.row[data-key="${key}"] [data-status]`);
  if (!dot) return;

  const state = level || "idle";
  dot.dataset.level = state;
  dot.className = `row-dot ${state}`;
  // Inline as well: the dot must be right even if a stylesheet rule is missed.
  dot.style.background = DOT_COLORS[state] || DOT_COLORS.idle;
  dot.title = text || "";
}

export function mountOf(key) {
  return document.querySelector(`.row[data-key="${key}"] [data-mount]`);
}
