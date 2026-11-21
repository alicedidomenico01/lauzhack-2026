// From "something is broken" to "it was fixed, and IT knows".
//
// Each check calls raise() every time it sees a problem and clear() when the
// problem is gone; both are cheap to call on every tick. For each new problem:
//   1. report     an incident with diagnostics goes to the central server
//   2. propose    per IT's policy: auto (countdown, opt-out), ask (opt-in), off
//   3. apply      the action runs: for real on the device when it can,
//                 otherwise simulated, and the incident says which
//   4. verify     the check confirms the problem is gone, or it is escalated
// Real and simulated damage take exactly the same path.

import { device, policyFor, send, uid, sleep } from "./central.js";
import { proposeAction } from "../ui/action-banner.js";

const VERIFY_MS = 9000;
const QUIET_AFTER_REJECT_MS = 60000; // do not nag after a "no"
const QUIET_AFTER_FAILURE_MS = 45000; // nor loop on a fix that did not work

const open = new Map(); // issue id -> incident in progress
const quietUntil = new Map(); // issue id -> timestamp

function env() {
  return {
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
  };
}

// Diagnostics may be sync or async (some ask the native helper); never throw.
async function safe(fn) {
  try {
    return (await fn?.()) ?? {};
  } catch {
    return {};
  }
}

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

export function createRemedy(section, sectionLabel, { onIncident } = {}) {
  const idOf = (key) => `${section}.${key}`;

  // `at` is when it happened here: queued updates keep their real times.
  function update(inc, body) {
    send("PATCH", `/api/incidents/${inc.id}`, { ...body, at: Date.now() / 1000 });
  }

  // issue: { key, title, severity, simulated, diagnostics(), action? }
  // action: { title, detail?(policy), run(policy) -> {ok, simulated, detail},
  //           verify?() -> bool | null (null = cannot tell automatically) }
  async function raise(issue, { userInitiated = false } = {}) {
    const issueId = idOf(issue.key);

    // A failure triggered by hand must always produce a fresh alert. An earlier
    // "reject" (quiet window) or a report still open must not swallow it.
    if (issue.simulated && !userInitiated) {
      const current = open.get(issueId);
      if (!current || current.state === "reported" || current.banner?.decided) {
        forget(issue.key);
      }
      quietUntil.delete(issueId);
    }

    const existing = open.get(issueId);
    if (existing) {
      if (userInitiated) existing.banner?.applyNow();
      return;
    }
    if (!userInitiated && (quietUntil.get(issueId) || 0) > Date.now()) return;

    const inc = { id: uid(), issueId, state: "detected", banner: null, startedAt: Date.now() };
    open.set(issueId, inc);
    onIncident?.(issue.key, true);

    const [dev, policy, diagnostics] = await Promise.all([device(), policyFor(issueId), safe(issue.diagnostics)]);
    const action = issue.action;
    // A suggestion has nothing to apply: it is shown, reported, and closed when
    // the problem goes away.
    const suggestOnly = !!issue.suggestOnly && !userInitiated;
    const willAct = !suggestOnly && !!action && (userInitiated || policy.mode !== "off");

    send("POST", "/api/incidents", {
      at: inc.startedAt / 1000,
      id: inc.id,
      device_id: dev.id,
      device_name: dev.name,
      section,
      issue: issueId,
      title: issue.title,
      severity: issue.severity || "bad",
      simulated: !!issue.simulated,
      status: willAct ? "proposed" : "reported",
      action: action ? action.title : null,
      note: suggestOnly
        ? "suggestion only"
        : willAct
          ? `${userInitiated ? "requested by the employee" : policy.mode} · ${policy.execution}`
          : "report only",
      diagnostics: { ...diagnostics, device: dev, env: env() },
    });

    // The problem may have gone while we were looking up the policy.
    if (open.get(issueId) !== inc) return;
    if (inc.cleared) {
      update(inc, { status: "resolved", note: "recovered before the action ran", outcome: "Recovered on its own" });
      return done(issueId, inc);
    }
    if (suggestOnly) {
      inc.state = "reported";
      inc.banner = proposeAction({
        section: sectionLabel,
        title: issue.title,
        detail: issue.suggestion?.(policy) || action?.detail?.(policy),
        mode: "info",
        simulated: issue.simulated,
      });
      return; // stays open until clear(), then marked recovered
    }

    if (!willAct) {
      inc.state = "reported";
      return; // stays open until clear(), then marked recovered
    }

    inc.banner = proposeAction({
      section: sectionLabel,
      title: action.title,
      detail: action.detail?.(policy),
      seconds: policy.seconds,
      mode: userInitiated ? "auto" : policy.mode,
      simulated: issue.simulated,
    });
    if (userInitiated) inc.banner.applyNow();

    const choice = await inc.banner.choice;
    if (choice === "dismissed") {
      update(inc, { status: "resolved", note: "recovered before the action ran", outcome: "Recovered on its own" });
      return done(issueId, inc);
    }
    if (choice === "reject") {
      inc.banner.done("muted", "Rejected. Nothing was changed.", "IT still has the diagnostics.");
      update(inc, { status: "rejected", note: "rejected by the employee", outcome: "Rejected by the employee" });
      quietUntil.set(issueId, Date.now() + QUIET_AFTER_REJECT_MS);
      return done(issueId, inc);
    }

    inc.state = "applying";
    update(inc, { status: "applying", note: policy.execution });
    inc.banner.progress(`${action.title}…`);

    let result;
    try {
      result = await action.run(policy);
    } catch (err) {
      result = { ok: false, detail: err?.message || String(err) };
    }
    const execution = result.simulated ? "simulated" : "real";

    if (!result.ok) {
      inc.banner.done("bad", "Could not apply the fix.", `${result.detail || ""} IT has the diagnostics.`.trim());
      update(inc, { status: "failed", execution, outcome: result.detail, after: await safe(issue.diagnostics),
        duration_ms: Date.now() - inc.startedAt });
      quietUntil.set(issueId, Date.now() + QUIET_AFTER_FAILURE_MS);
      return done(issueId, inc);
    }

    inc.banner.progress("Checking that it worked…");
    const verified = action.verify ? await Promise.race([action.verify(), sleep(VERIFY_MS).then(() => false)]) : null;
    const after = await safe(issue.diagnostics);
    const duration_ms = Date.now() - inc.startedAt;

    if (verified === null) {
      inc.banner.done("ok", result.detail || "Done.", "This one cannot be checked automatically.");
      update(inc, { status: "applied", execution, outcome: result.detail, after, duration_ms, note: "applied, not verifiable" });
    } else if (verified) {
      inc.banner.done("ok", `Fixed: ${result.detail}`, execution === "simulated" ? "Simulated action. Verified on this device." : "Verified on this device.");
      update(inc, { status: "fixed", execution, outcome: result.detail, after, duration_ms, note: "verified" });
    } else {
      inc.banner.done("warn", "Applied, but the problem is still there.", "IT was notified with the diagnostics.");
      update(inc, { status: "escalated", execution, outcome: `${result.detail} (not verified)`, after, duration_ms,
        note: "check still failing after the action" });
      quietUntil.set(issueId, Date.now() + QUIET_AFTER_FAILURE_MS);
    }
    done(issueId, inc);
  }

  function done(issueId, inc) {
    if (open.get(issueId) === inc) open.delete(issueId);
    onIncident?.(issueId.slice(section.length + 1), false);
  }

  // The problem is gone. Only an incident that is not mid-action is closed:
  // an action in progress finishes and verifies on its own.
  function clear(key) {
    const issueId = idOf(key);
    const inc = open.get(issueId);
    if (!inc) return;
    if (inc.state === "reported") {
      update(inc, { status: "resolved", note: "recovered", outcome: "Recovered on its own" });
      if (inc.banner && !inc.banner.decided) {
        inc.banner.done("ok", "Back to normal.", "The problem cleared on its own.");
      }
      done(issueId, inc);
    } else if (inc.state === "detected") {
      if (inc.banner && !inc.banner.decided) inc.banner.dismiss();
      else if (!inc.banner) inc.cleared = true; // raise() is still looking up the policy
    }
  }

  // Drop everything we remember about an issue: the open incident and the
  // "do not nag" window. Used when a failure is triggered again by hand.
  function forget(key) {
    const issueId = idOf(key);
    const inc = open.get(issueId);
    if (inc) {
      if (inc.banner && !inc.banner.decided) inc.banner.dismiss();
      open.delete(issueId);
    }
    quietUntil.delete(issueId);
  }

  const isOpen = (key) => open.has(idOf(key));

  return { raise, clear, isOpen, waitFor, forget };
}
