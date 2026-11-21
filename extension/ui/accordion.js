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

// Integrations pass human words too ("blocked", "busy elsewhere", "no signal"),
// so map them onto the five colours we actually have.
export function normalizeLevel(level) {
  if (!level) return "idle";
  if (DOT_COLORS[level]) return level;
  const text = String(level).toLowerCase();
  if (/^(ok|fixed|good|works)$/.test(text)) return "ok";
  if (/(busy|starting|measuring|listening|acting|sampling)/.test(text)) return "busy";
  if (/(blocked|missing|error|no signal|unavailable|fail|offline|struggling)/.test(text)) return "bad";
  return "warn";
}

// Takes the element, not a selector: the element is resolved once at mount,
// so a bad selector can only fail loudly, never silently.
export function paintDot(dot, level, text) {
  if (!dot) {
    console.error("[setup-check] status dot element is missing");
    return;
  }
  const state = normalizeLevel(level);
  const color = DOT_COLORS[state] || DOT_COLORS.idle;
  dot.dataset.level = state;
  dot.style.background = color;
  dot.style.boxShadow =
    state === "idle" ? "none" : `0 0 0 3px ${color}22`;
  dot.title = text || "";
}

export function dotOf(key) {
  return document.querySelector(`.row[data-key="${key}"] [data-status]`);
}

export function mountOf(key) {
  return document.querySelector(`.row[data-key="${key}"] [data-mount]`);
}
