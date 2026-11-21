// A circular gauge with the figure inside the circle.
// Score 0..100, rendered as a stroke offset so the change animates in CSS.

const CIRCUMFERENCE = 2 * Math.PI * 34;

export function createRing() {
  const wrap = document.createElement("div");
  wrap.className = "ring";
  wrap.innerHTML = `
    <svg viewBox="0 0 80 80" aria-hidden="true">
      <circle class="bg" cx="40" cy="40" r="34"></circle>
      <circle class="fg" cx="40" cy="40" r="34"></circle>
    </svg>
    <div class="ring-figure">
      <span class="ring-value">-</span>
      <span class="ring-label">Mb/s</span>
    </div>
  `;

  const fg = wrap.querySelector(".fg");
  const value = wrap.querySelector(".ring-value");
  const label = wrap.querySelector(".ring-label");

  return {
    el: wrap,
    set(score, main, sub, color) {
      const clamped = Math.max(0, Math.min(100, score));
      fg.style.strokeDashoffset = String(
        CIRCUMFERENCE - (CIRCUMFERENCE * clamped) / 100
      );
      if (color) fg.style.stroke = color;
      value.textContent = main;
      label.textContent = sub;
    },
  };
}
