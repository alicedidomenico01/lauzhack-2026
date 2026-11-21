// Accordion behaviour + the status pill in each row header.

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
  const pill = document.querySelector(`.row[data-key="${key}"] [data-status]`);
  if (!pill) return;
  pill.className = `row-status${level ? ` ${level}` : ""}`;
  pill.textContent = text;
}

export function mountOf(key) {
  return document.querySelector(`.row[data-key="${key}"] [data-mount]`);
}
