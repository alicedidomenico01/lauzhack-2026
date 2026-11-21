// Demo only: a small lightning button in a section header that breaks that
// check on purpose (slow network, dead mic, frozen camera, CPU spike), so the
// detect → report → fix → verify loop can be shown when everything works.
// The damage goes through exactly the same path as a real one, and every
// incident it causes is marked "simulated damage" for IT.

const ZAP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';

export function addDamageToggle(row, { label, onChange }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "damage-btn";
  btn.innerHTML = ZAP;
  btn.setAttribute("aria-pressed", "false");

  let on = false;
  const paint = () => {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? `Simulated ${label}: click to stop` : `Simulate ${label} (demo)`;
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    on = !on;
    paint();
    onChange(on);
  });

  paint();
  row.append(btn);

  // set() is for the check itself: a fix clears the damage and the button follows.
  return {
    set(next) {
      on = !!next;
      paint();
    },
    get on() {
      return on;
    },
  };
}
