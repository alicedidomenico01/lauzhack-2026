const state = {
  tab: "reports",
  statsView: "employees",
  days: 14,
  fleet: true,
  stats: null,
  incidents: [],
  policies: [],
  employee: null,
  search: "",
  status: "",
  section: "",
  drawer: null,
};

const TIME_SAVED_NOTE =
  "Estimated, not measured: every fixed report is credited with the minutes that failure usually costs (15 for a dead or wrong microphone, 12 for a slow network, 10 for a frozen camera, 8 for CPU or memory).";

const $ = (id) => document.getElementById(id);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const STATUS_LEVEL = {
  fixed: "ok",
  applied: "ok",
  resolved: "ok",
  rejected: "warn",
  escalated: "bad",
  failed: "bad",
  interrupted: "warn",
};

const STATUS_LABEL = {
  detected: "Detected",
  proposed: "Proposed",
  applying: "Applying",
  fixed: "Fixed",
  applied: "Applied",
  escalated: "Escalated",
  rejected: "Rejected",
  failed: "Failed",
  reported: "Reported",
  resolved: "Recovered",
  interrupted: "Interrupted",
};

const badge = (status) => {
  const level = STATUS_LEVEL[status] || "neutral";
  return el("span", `badge ${level}`, STATUS_LABEL[status] || status || "-");
};

function sourceBadge(incident) {
  if (incident.simulated) return el("span", "badge warn", "demo");
  if (incident.fleet) return el("span", "badge neutral", "seeded");
  return el("span", "badge ok", "live");
}

// A real tooltip, not the native one: the icon sits inside a scrolling table,
// so the bubble is positioned in the viewport and can never be clipped.
function attachTooltip(node, text) {
  let bubble = null;

  const show = () => {
    if (!bubble) {
      bubble = el("div", "tooltip");
      bubble.textContent = text;
      document.body.append(bubble);
    }
    bubble.hidden = false;
    const box = node.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 8));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${box.bottom + 8}px`;
  };

  const hide = () => {
    if (bubble) bubble.hidden = true;
  };

  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("focus", show);
  node.addEventListener("blur", hide);
  // Click pins it open (useful on touch), anything else closes it.
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    show();
  });
  document.addEventListener("click", hide);
  document.addEventListener("scroll", hide, true);
}

function infoIcon(text) {
  const node = el("span", "info", "i");
  node.tabIndex = 0;
  node.setAttribute("role", "note");
  node.setAttribute("aria-label", text);
  attachTooltip(node, text);
  return node;
}

const pct = (value) => (value === null || value === undefined ? "-" : `${Math.round(value * 100)}%`);

const num = (value) => (value === null || value === undefined ? "-" : new Intl.NumberFormat().format(value));

function ago(seconds) {
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  return `${Math.round(delta / 86400)} d ago`;
}

const when = (seconds) => new Date(seconds * 1000).toLocaleString();

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function load() {
  const query = `days=${state.days}&fleet=${state.fleet ? 1 : 0}`;
  try {
    const [stats, incidents, policies] = await Promise.all([
      api(`/api/stats?${query}`),
      api(`/api/incidents?limit=500&live=${state.fleet ? 0 : 1}`),
      api("/api/policies"),
    ]);
    state.stats = stats;
    state.incidents = incidents.incidents || [];
    state.policies = policies.policies || [];
    render();
  } catch (err) {
    console.error(err);
  }
}

/* ---------------------------------------------------------------- tabs */

document.querySelectorAll(".tabs > button").forEach((button) => {
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll(".tabs > button").forEach((b) => {
      b.setAttribute("aria-selected", String(b === button));
    });
    document.querySelectorAll("main > .panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${state.tab}`;
    });
    render();
  });
});

document.querySelectorAll(".sub-tabs > button").forEach((button) => {
  button.addEventListener("click", () => {
    state.statsView = button.dataset.view;
    document.querySelectorAll(".sub-tabs > button").forEach((b) => {
      b.setAttribute("aria-selected", String(b === button));
    });
    $("view-employees").hidden = state.statsView !== "employees";
    $("view-company").hidden = state.statsView !== "company";
    render();
  });
});

/* ---------------------------------------------------------------- render */

function render() {
  if (!state.stats) return;
  if (state.tab === "reports") renderReports();
  if (state.tab === "stats") {
    if (state.statsView === "employees") renderPeople();
    else renderCompany();
  }
  if (state.tab === "actions") renderPolicies();
}

function renderCompany() {
  const s = state.stats;
  const kpis = $("kpis");
  kpis.replaceChildren();

  const cards = [
    { label: "Reports", value: num(s.total), foot: `${num(s.devices)} devices, ${s.days} days` },
    { label: "Fixed remotely", value: pct(s.fix_rate), foot: `${num(s.fixed)} of ${num(s.acted)} acted on`, level: "ok" },
    { label: "Rejected by employees", value: pct(s.reject_rate), foot: `${num(s.rejected)} opt-outs`, level: "bad" },
    { label: "Time saved (est.)", value: `${s.hours_saved} h`, foot: "estimate, see note", info: TIME_SAVED_NOTE },
  ];

  for (const card of cards) {
    const box = el("dl", `kpi ${card.level || ""}`);
    const label = el("dt");
    label.append(card.label);
    if (card.info) label.append(" ", infoIcon(card.info));
    box.append(label, el("dd", "", card.value), el("p", "foot", card.foot));
    kpis.append(box);
  }

  const breaks = $("breaks");
  breaks.replaceChildren();
  const issues = (s.by_issue || []).slice(0, 8);
  const max = Math.max(1, ...issues.map((i) => i.count));
  for (const issue of issues) {
    const row = el("div", "bar-row");
    const label = el("span", "bar-label", issue.label || issue.issue);
    const count = el("span", "bar-count", num(issue.count));
    const track = el("div", "bar-track");
    const share = issue.count ? issue.fixed / issue.count : 0;
    const fill = el("div", `bar-fill ${share >= 0.7 ? "ok" : share >= 0.4 ? "" : "warn"}`);
    fill.style.width = `${Math.round((issue.count / max) * 100)}%`;
    track.append(fill);
    row.append(label, count, track);
    breaks.append(row);
  }
  if (!issues.length) breaks.append(el("p", "empty", "No reports in this window."));

  const trend = $("trend");
  trend.replaceChildren();
  const days = s.per_day || [];
  const peak = Math.max(1, ...days.map((d) => Object.values(d.sections).reduce((a, b) => a + b, 0)));
  for (const day of days) {
    const total = Object.values(day.sections).reduce((a, b) => a + b, 0);
    const col = el("div", "col");
    const area = el("div", "bar-area");
    const bar = el("i");
    bar.style.height = `${Math.max(2, Math.round((total / peak) * 100))}%`;
    bar.title = `${day.day}: ${total}`;
    area.append(bar);
    col.append(area, el("span", "", day.day));
    trend.append(col);
  }

  const departments = $("departments");
  departments.replaceChildren();
  const depts = s.by_department || [];
  const deptMax = Math.max(1, ...depts.map((d) => d.count));
  for (const dept of depts) {
    const row = el("div", "bar-row");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.round((dept.count / deptMax) * 100)}%`;
    track.append(fill);
    row.append(el("span", "bar-label", dept.department), el("span", "bar-count", num(dept.count)), track);
    departments.append(row);
  }
  if (!depts.length) departments.append(el("p", "empty", "No reports in this window."));
}

function filteredIncidents() {
  const search = state.search.trim().toLowerCase();
  return state.incidents.filter((incident) => {
    if (state.status && incident.status !== state.status) return false;
    if (state.section && incident.section !== state.section) return false;
    if (state.employee) {
      const key = `${incident.employee_id} ${incident.employee_name}`;
      if (!key.includes(state.employee)) return false;
    }
    if (!search) return true;
    const haystack = [
      incident.employee_name,
      incident.device_name,
      incident.device_id,
      incident.title,
      incident.issue,
      incident.action,
      incident.department,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });
}

function renderReports() {
  fillFilters();

  const table = $("reports");
  table.replaceChildren();
  const head = el("thead");
  const headRow = el("tr");
  ["When", "Employee", "Source", "Device", "Section", "Issue", "Status", "Action"].forEach((h) =>
    headRow.append(el("th", "", h))
  );
  head.append(headRow);
  table.append(head);

  const body = el("tbody");
  const rows = filteredIncidents();
  for (const incident of rows) {
    const tr = el("tr", "clickable");
    const employee = el("td", "");
    employee.append(el("div", "", incident.employee_name || "-"));
    employee.append(el("div", "muted small", incident.employee_role || incident.department || ""));
    const source = el("td", "");
    source.append(sourceBadge(incident));
    tr.append(
      el("td", "", ago(incident.created_at)),
      employee,
      source,
      el("td", "mono", incident.device_name || incident.device_id || "-"),
      el("td", "", incident.section || "-"),
      el("td", "", incident.title || incident.issue),
      el("td", ""),
      el("td", "", incident.action || "-")
    );
    tr.children[6].append(badge(incident.status));
    tr.addEventListener("click", () => openDrawer(incident));
    body.append(tr);
  }
  table.append(body);

  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "empty", "No reports match these filters.");
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
  }

  const note = $("reports-note");
  note.textContent = `${num(rows.length)} of ${num(state.incidents.length)} reports shown. Live means it came from a device now; seeded is generated history; demo is a failure triggered on purpose.`;
  const clear = $("clear-employee");
  clear.hidden = !state.employee;
  clear.textContent = state.employee ? `Filtered by ${state.employee}, clear` : "";
}

function fillFilters() {
  const status = $("status");
  if (!status.options.length) {
    status.append(new Option("Any status", ""));
    Object.entries(STATUS_LABEL).forEach(([value, label]) => status.append(new Option(label, value)));
    status.value = state.status;
    status.addEventListener("change", () => {
      state.status = status.value;
      renderReports();
    });
  }

  const section = $("section");
  if (!section.options.length) {
    section.append(new Option("Any section", ""));
    ["network", "audio", "camera", "memory"].forEach((value) =>
      section.append(new Option(value, value))
    );
    section.value = state.section;
    section.addEventListener("change", () => {
      state.section = section.value;
      renderReports();
    });
  }
}

function renderPeople() {
  const table = $("people");
  table.replaceChildren();
  const head = el("thead");
  const headRow = el("tr");
  ["Employee", "Role", "Department", "Office", "Reports", "Fixed", "Rejected"].forEach((h, index) =>
    headRow.append(el("th", index > 3 ? "num" : "", h))
  );
  const timeTh = el("th", "num");
  timeTh.append("Time saved (est.) ", infoIcon(TIME_SAVED_NOTE));
  headRow.append(timeTh);
  head.append(headRow);
  table.append(head);

  const body = el("tbody");
  const people = state.stats.by_employee || [];
  for (const person of people) {
    const tr = el("tr", "clickable");
    const name = el("td", "");
    name.append(el("div", "", person.name));
    name.append(el("div", "muted small", person.employee_id));
    tr.append(
      name,
      el("td", "", person.role || "-"),
      el("td", "", person.department || "-"),
      el("td", "", person.office || "-"),
      el("td", "num", num(person.incidents)),
      el("td", "num", num(person.fixed)),
      el("td", "num", num(person.rejected)),
      el("td", "num", `${Math.round(person.minutes / 6) / 10} h`)
    );
    tr.addEventListener("click", () => {
      state.employee = person.employee_id;
      state.search = "";
      $("search").value = "";
      document.querySelector('.tabs > button[data-tab="reports"]').click();
    });
    body.append(tr);
  }
  table.append(body);

  if (!people.length) {
    const tr = el("tr");
    const td = el("td", "empty", "No people in this window.");
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
  }
}

function renderPolicies() {
  const table = $("policies");
  table.replaceChildren();
  const head = el("thead");
  const headRow = el("tr");
  ["Failure", "Action", "Mode", "Execution", "Reference", "Params"].forEach((h) =>
    headRow.append(el("th", "", h))
  );
  head.append(headRow);
  table.append(head);

  const body = el("tbody");
  for (const policy of state.policies) {
    const tr = el("tr");
    tr.dataset.id = policy.id;

    const failure = el("td", "");
    failure.append(el("div", "", policy.label));
    failure.append(el("div", "muted small", policy.section));

    const mode = el("select");
    [
      ["auto", "Auto (opt-out)"],
      ["ask", "Ask first"],
      ["suggest", "Suggest only"],
      ["off", "Report only"],
    ].forEach(([value, label]) => mode.append(new Option(label, value)));
    mode.value = policy.mode;
    mode.dataset.field = "mode";

    // Execution belongs to the action, it is not a setting: shown, not editable.
    const execution = el("td", "");
    const execLevel = policy.execution === "real" ? "ok" : "neutral";
    execution.append(el("span", `badge ${execLevel}`, policy.execution));

    const ref = el("input");
    ref.type = "text";
    ref.value = policy.ref || "";
    ref.placeholder = "runbook, queue, internal id";
    ref.dataset.field = "ref";
    ref.style.width = "100%";

    const params = el("td", "");
    for (const [key, value] of Object.entries(policy.params || {})) {
      const input = el("input");
      input.type = typeof value === "number" ? "number" : "text";
      input.value = value;
      input.dataset.param = key;
      input.placeholder = key;
      input.style.width = "110px";
      input.style.marginRight = "6px";
      params.append(input);
    }

    tr.append(failure, el("td", "", policy.action || "-"), el("td", ""), execution, el("td", ""), params);
    tr.children[2].append(mode);
    tr.children[4].append(ref);
    body.append(tr);
  }
  table.append(body);
}

/* ---------------------------------------------------------------- drawer */

function openDrawer(incident) {
  const drawer = $("drawer");
  drawer.replaceChildren();

  const header = el("header");
  const title = el("div");
  title.append(el("h2", "", incident.title || incident.issue));
  title.append(el("p", "muted", `${incident.section} · ${ago(incident.created_at)}`));
  const close = el("button", "btn subtle", "Close");
  close.addEventListener("click", closeDrawer);
  header.append(title, close);

  const facts = el("dl");
  const rows = [
    ["Employee", `${incident.employee_name || "-"}${incident.employee_role ? ` · ${incident.employee_role}` : ""}`],
    ["Device", incident.device_name || incident.device_id || "-"],
    ["Department", incident.department || "-"],
    ["When", when(incident.created_at)],
    ["Status", STATUS_LABEL[incident.status] || incident.status],
    ["Action", incident.action || "-"],
    ["Execution", incident.execution || "-"],
    ["Duration", incident.duration_ms ? `${(incident.duration_ms / 1000).toFixed(1)} s` : "-"],
    ["Source", incident.simulated ? "demo, triggered on purpose" : incident.fleet ? "seeded fleet" : "live device"],
  ];
  for (const [key, value] of rows) {
    facts.append(el("dt", "", key), el("dd", "", value));
  }

  const timeline = el("ol", "timeline");
  for (const step of incident.timeline || []) {
    const level = STATUS_LEVEL[step.status] || "";
    const item = el("li", level);
    item.append(el("div", "", STATUS_LABEL[step.status] || step.status));
    item.append(el("time", "", when(step.t)));
    if (step.note) item.append(el("div", "muted small", step.note));
    timeline.append(item);
  }

  drawer.append(header, facts);
  drawer.append(el("h3", "", "Timeline"));
  drawer.append(timeline);

  if (incident.diagnostics) {
    drawer.append(el("h3", "", "Diagnostics"));
    const pre = el("pre", "json");
    pre.textContent = JSON.stringify(incident.diagnostics, null, 2);
    drawer.append(pre);
  }

  state.drawer = incident.id;
  drawer.hidden = false;
  $("scrim").hidden = false;
}

function closeDrawer() {
  state.drawer = null;
  $("drawer").hidden = true;
  $("scrim").hidden = true;
}

$("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

/* ---------------------------------------------------------------- controls */

$("days").addEventListener("change", (event) => {
  state.days = Number(event.target.value);
  load();
});

$("fleet").addEventListener("change", (event) => {
  state.fleet = event.target.checked;
  load();
});

$("refresh").addEventListener("click", load);

$("search").addEventListener("input", (event) => {
  state.search = event.target.value;
  if (state.tab === "reports") renderReports();
});

$("clear-employee").addEventListener("click", () => {
  state.employee = null;
  renderReports();
});

$("save").addEventListener("click", async () => {
  const updates = [];
  for (const row of $("policies").querySelectorAll("tbody tr")) {
    const params = {};
    for (const input of row.querySelectorAll("[data-param]")) {
      params[input.dataset.param] = input.type === "number" ? Number(input.value) : input.value;
    }
    updates.push({
      id: row.dataset.id,
      mode: row.querySelector('[data-field="mode"]').value,
      ref: row.querySelector('[data-field="ref"]').value,
      params,
    });
  }
  try {
    const result = await api("/api/policies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policies: updates }),
    });
    state.policies = result.policies;
    $("save-note").textContent = "Saved. Devices pick this up within seconds.";
  } catch (err) {
    $("save-note").textContent = `Could not save: ${err.message}`;
  }
});

setInterval(() => {
  if (!state.drawer && document.visibilityState === "visible") load();
}, 8000);

load();
