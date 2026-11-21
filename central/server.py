#!/usr/bin/env python3
"""Setup Check central: where every device reports what broke and what was done.

Standard library only. Run it on the demo laptop:

    python3 central/server.py            # http://localhost:8787
    python3 central/server.py --port 9000 --no-seed

The extension posts an incident when a check fails (real or simulated), then
updates it as the remote action is proposed, applied or rejected, and
verified. The dashboard (same address, in a browser tab) shows the live feed,
company-level stats and the action policies the devices follow.

On first start the database is seeded with a *simulated* fleet (marked as such
everywhere) so the company-level charts have something to show.
"""

import argparse
import json
import os
import random
import re
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "central.db")
DASHBOARD = os.path.join(HERE, "dashboard.html")
DAY = 86400

# What each failure is, what IT does about it, and how. The dashboard edits
# mode / seconds / execution / params; devices fetch this every few seconds.
#   mode       auto   = announce, count down, apply unless the employee rejects
#              ask    = propose, apply only if the employee accepts
#              off    = report only, no action
#   execution  real      = run it on the device when the device can
#              simulated = go through the motions, change nothing
DEFAULT_POLICIES = [
    {"id": "network.slow", "section": "network", "label": "Slow or no connection",
     "action": "Switch to a better Wi-Fi network", "mode": "auto", "seconds": 3,
     "execution": "simulated", "params": {"targetNetwork": "eduroam"}, "minutes_saved": 12},
    {"id": "audio.dead", "section": "audio", "label": "Microphone sends no sound",
     "action": "Restore the microphone (input volume to 75%)", "mode": "auto", "seconds": 3,
     "execution": "real", "params": {"inputVolume": 75}, "minutes_saved": 15},
    {"id": "audio.wrongdefault", "section": "audio", "label": "System microphone is dead, another one works",
     "action": "Make the working microphone the system default", "mode": "auto", "seconds": 3,
     "execution": "real", "params": {}, "minutes_saved": 15},
    {"id": "audio.quiet", "section": "audio", "label": "Voice too quiet",
     "action": "Raise the microphone input volume", "mode": "ask", "seconds": 3,
     "execution": "real", "params": {"step": 20}, "minutes_saved": 5},
    {"id": "audio.clipping", "section": "audio", "label": "Voice distorted (clipping)",
     "action": "Lower the microphone input volume", "mode": "ask", "seconds": 3,
     "execution": "real", "params": {"step": 20}, "minutes_saved": 5},
    {"id": "camera.frozen", "section": "camera", "label": "Camera frozen",
     "action": "Restart the camera", "mode": "auto", "seconds": 3,
     "execution": "real", "params": {}, "minutes_saved": 10},
    {"id": "camera.black", "section": "camera", "label": "Camera shows a black image",
     "action": "None (shutter or cover: the employee fixes it)", "mode": "off", "seconds": 3,
     "execution": "simulated", "params": {}, "minutes_saved": 0},
    {"id": "memory.cpu", "section": "memory", "label": "CPU overloaded",
     "action": "Quit the app using the most CPU", "mode": "auto", "seconds": 3,
     "execution": "simulated", "params": {}, "minutes_saved": 8},
    {"id": "memory.lowmem", "section": "memory", "label": "Memory almost full",
     "action": "Quit the app using the most memory", "mode": "ask", "seconds": 3,
     "execution": "simulated", "params": {}, "minutes_saved": 8},
]

MODES = {"auto", "ask", "off"}
EXECUTIONS = {"real", "simulated"}
STATUSES = {"detected", "proposed", "applying", "fixed", "applied", "escalated",
            "rejected", "failed", "reported", "resolved", "interrupted"}
STALE_S = 120  # proposed/applying for longer than this: the panel was closed mid-action

lock = threading.Lock()


# ---------------------------------------------------------------- storage

def connect():
    db = sqlite3.connect(DB_PATH, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS incidents (
            id TEXT PRIMARY KEY,
            fleet INTEGER NOT NULL DEFAULT 0,      -- 1 = simulated fleet history
            device_id TEXT, device_name TEXT, department TEXT,
            section TEXT, issue TEXT, title TEXT, severity TEXT,
            simulated INTEGER NOT NULL DEFAULT 0,  -- damage triggered on purpose
            status TEXT, action TEXT, execution TEXT, outcome TEXT,
            diagnostics TEXT, after TEXT, timeline TEXT,
            created_at REAL, updated_at REAL, duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_created ON incidents(created_at);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    """)
    return db


def get_policies(db):
    row = db.execute("SELECT value FROM settings WHERE key='policies'").fetchone()
    stored = json.loads(row["value"]) if row else {}
    out = []
    for base in DEFAULT_POLICIES:
        p = json.loads(json.dumps(base))
        p.update({k: v for k, v in stored.get(p["id"], {}).items()
                  if k in ("mode", "seconds", "execution", "params")})
        out.append(p)
    return out


def save_policies(db, updates):
    current = {p["id"]: p for p in get_policies(db)}
    stored = {}
    for p in updates:
        pid = p.get("id")
        if pid not in current:
            continue
        mode = p.get("mode", current[pid]["mode"])
        execution = p.get("execution", current[pid]["execution"])
        seconds = p.get("seconds", current[pid]["seconds"])
        if mode not in MODES or execution not in EXECUTIONS:
            raise ValueError(f"bad mode or execution for {pid}")
        seconds = int(seconds)
        if not 1 <= seconds <= 30:
            raise ValueError("seconds must be between 1 and 30")
        params = p.get("params", current[pid]["params"])
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        stored[pid] = {"mode": mode, "execution": execution, "seconds": seconds,
                       "params": {k: v for k, v in params.items() if isinstance(v, (str, int, float))}}
    db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('policies', ?)", (json.dumps(stored),))
    db.commit()


def close_stale(db):
    """An incident left mid-action (panel closed, laptop asleep) is marked
    interrupted instead of showing "applying" forever."""
    cutoff = time.time() - STALE_S
    stale = db.execute("SELECT id, timeline FROM incidents WHERE fleet = 0 AND status IN "
                       "('detected', 'proposed', 'applying') AND updated_at < ?", (cutoff,)).fetchall()
    for r in stale:
        timeline = json.loads(r["timeline"] or "[]")
        timeline.append({"t": time.time(), "status": "interrupted", "note": "no update from the device"})
        db.execute("UPDATE incidents SET status='interrupted', timeline=?, updated_at=? WHERE id=?",
                   (json.dumps(timeline), time.time(), r["id"]))
    if stale:
        db.commit()


def row_dict(r):
    d = dict(r)
    for k in ("diagnostics", "after", "timeline"):
        d[k] = json.loads(d[k]) if d.get(k) else None
    return d


# ---------------------------------------------------------------- incidents

TEXT_LIMIT = 300


def clean_text(v, limit=TEXT_LIMIT):
    return None if v is None else str(v)[:limit]


def event_time(body):
    """When it happened on the device (queued events arrive late), within reason."""
    now = time.time()
    try:
        at = float(body.get("at"))
    except (TypeError, ValueError):
        return now
    return at if now - DAY <= at <= now + 5 else now


def create_incident(db, body):
    now = event_time(body)
    iid = clean_text(body.get("id")) or uuid.uuid4().hex
    status = body.get("status") if body.get("status") in STATUSES else "detected"
    timeline = [{"t": now, "status": status, "note": clean_text(body.get("note"))}]
    db.execute("""INSERT OR IGNORE INTO incidents
        (id, fleet, device_id, device_name, department, section, issue, title, severity,
         simulated, status, action, execution, outcome, diagnostics, after, timeline,
         created_at, updated_at, duration_ms)
        VALUES (?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,NULL)""", (
        iid, clean_text(body.get("device_id")), clean_text(body.get("device_name")),
        clean_text(body.get("department")) or "Demo",
        clean_text(body.get("section")), clean_text(body.get("issue")), clean_text(body.get("title")),
        clean_text(body.get("severity")), 1 if body.get("simulated") else 0, status,
        clean_text(body.get("action")), clean_text(body.get("execution")), clean_text(body.get("outcome")),
        json.dumps(body.get("diagnostics") or {})[:20000], json.dumps(timeline), now, now))
    db.commit()
    return iid


def update_incident(db, iid, body):
    row = db.execute("SELECT * FROM incidents WHERE id=?", (iid,)).fetchone()
    if not row:
        return False
    now = event_time(body)
    fields = {}
    if body.get("status") in STATUSES:
        fields["status"] = body["status"]
    for k in ("action", "execution", "outcome"):
        if k in body:
            fields[k] = clean_text(body[k])
    if "after" in body:
        fields["after"] = json.dumps(body["after"] or {})[:20000]
    if "duration_ms" in body:
        try:
            fields["duration_ms"] = int(body["duration_ms"])
        except (TypeError, ValueError):
            pass
    timeline = json.loads(row["timeline"] or "[]")
    if "status" in fields:
        timeline.append({"t": now, "status": fields["status"], "note": clean_text(body.get("note"))})
    fields["timeline"] = json.dumps(timeline[-30:])
    fields["updated_at"] = now
    sets = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE incidents SET {sets} WHERE id=?", (*fields.values(), iid))
    db.commit()
    return True


# ---------------------------------------------------------------- stats

DONE_OK = {"fixed"}
DONE_APPLIED = {"fixed", "applied"}


def stats(db, days, include_fleet):
    since = time.time() - days * DAY
    where = "created_at >= ?" + ("" if include_fleet else " AND fleet = 0")
    rows = [dict(r) for r in db.execute(
        f"SELECT section, issue, status, simulated, fleet, created_at, device_id, department "
        f"FROM incidents WHERE {where}", (since,))]
    policies = {p["id"]: p for p in get_policies(db)}

    total = len(rows)
    fixed = sum(r["status"] in DONE_OK for r in rows)
    rejected = sum(r["status"] == "rejected" for r in rows)
    escalated = sum(r["status"] in ("escalated", "failed") for r in rows)
    minutes = sum(policies.get(r["issue"], {}).get("minutes_saved", 0) for r in rows if r["status"] in DONE_OK)
    acted = sum(r["status"] in DONE_APPLIED | {"rejected", "escalated", "failed"} for r in rows)

    by_issue = {}
    for r in rows:
        b = by_issue.setdefault(r["issue"], {"issue": r["issue"], "section": r["section"], "count": 0,
                                             "fixed": 0, "rejected": 0, "escalated": 0})
        b["count"] += 1
        b["fixed"] += r["status"] in DONE_OK
        b["rejected"] += r["status"] == "rejected"
        b["escalated"] += r["status"] in ("escalated", "failed")
    for b in by_issue.values():
        b["label"] = policies.get(b["issue"], {}).get("label", b["issue"])

    # Per day (oldest first) and per hour of the working day, split by section.
    today = time.localtime()
    midnight = time.mktime((today.tm_year, today.tm_mon, today.tm_mday, 0, 0, 0, 0, 0, -1))
    per_day = [{"day": time.strftime("%a %d", time.localtime(midnight - i * DAY)), "sections": {}}
               for i in range(days - 1, -1, -1)]
    per_hour = [{"hour": h, "sections": {}} for h in range(24)]
    per_minute = [0] * 60
    for r in rows:
        days_ago = 0 if r["created_at"] >= midnight else int((midnight - r["created_at"]) // DAY) + 1
        idx = days - 1 - days_ago
        if 0 <= idx < days:
            s = per_day[idx]["sections"]
            s[r["section"]] = s.get(r["section"], 0) + 1
        lt = time.localtime(r["created_at"])
        h = per_hour[lt.tm_hour]["sections"]
        h[r["section"]] = h.get(r["section"], 0) + 1
        per_minute[lt.tm_min] += 1

    # Failures right before a meeting starts (:55 to :59) vs. an even spread.
    pre_meeting = sum(per_minute[55:60])
    pre_meeting_share = pre_meeting / total if total else 0

    by_dept = {}
    for r in rows:
        d = r["department"] or "Other"
        by_dept[d] = by_dept.get(d, 0) + 1

    return {
        "days": days,
        "include_fleet": include_fleet,
        "total": total,
        "devices": len({r["device_id"] for r in rows}),
        "fixed": fixed,
        "rejected": rejected,
        "escalated": escalated,
        "acted": acted,
        "fix_rate": fixed / acted if acted else None,
        "reject_rate": rejected / acted if acted else None,
        "hours_saved": round(minutes / 60, 1),
        "by_issue": sorted(by_issue.values(), key=lambda b: -b["count"]),
        "per_day": per_day,
        "per_hour": per_hour,
        "pre_meeting_share": round(pre_meeting_share, 3),
        "by_department": sorted(({"department": k, "count": v} for k, v in by_dept.items()),
                                key=lambda d: -d["count"]),
        "live": sum(1 for r in rows if not r["fleet"]),
    }


# ---------------------------------------------------------------- simulated fleet

DEPARTMENTS = [("Sales", 0.26), ("Engineering", 0.24), ("Support", 0.18), ("Finance", 0.12),
               ("HR", 0.08), ("Marketing", 0.12)]
ISSUE_WEIGHTS = [("network.slow", 30), ("audio.dead", 12), ("audio.wrongdefault", 11),
                 ("audio.quiet", 9), ("audio.clipping", 3), ("camera.frozen", 9),
                 ("camera.black", 6), ("memory.cpu", 13), ("memory.lowmem", 7)]
APPS = ["Microsoft Teams", "Docker Desktop", "Google Drive", "Zoom", "Slack", "OneDrive", "Xcode"]
MICS = ["MacBook Pro Microphone", "AirPods Pro", "Jabra Evolve2 65", "Logitech Zone Vibe", "USB Audio Device"]
CAMS = ["FaceTime HD Camera", "Logitech BRIO", "Continuity Camera", "Insta360 Link"]
SSIDS = ["corp-wifi", "corp-guest", "eduroam", "iPhone hotspot", "Home-5G"]


def weighted(rng, pairs):
    total = sum(w for _, w in pairs)
    x = rng.random() * total
    for item, w in pairs:
        x -= w
        if x <= 0:
            return item
    return pairs[-1][0]


def fake_diagnostics(rng, issue):
    if issue == "network.slow":
        speed = round(rng.uniform(0.2, 1.9), 2)
        return {"speedMbps": speed, "latencyMs": rng.randint(90, 900), "jitterMs": rng.randint(20, 240),
                "lostProbes": f"{rng.randint(0, 6)}/20", "ssid": rng.choice(SSIDS)}
    if issue.startswith("audio."):
        return {"device": rng.choice(MICS), "noiseFloorDb": rng.randint(-95, -55),
                "voicePeakDb": rng.randint(-70, -3), "inputVolume": rng.choice([0, 0, 10, 35, 60, 100])}
    if issue.startswith("camera."):
        return {"device": rng.choice(CAMS), "fps": rng.choice([0, 0, 7, 12, 30]),
                "resolution": rng.choice(["1280×720", "1920×1080", "640×480"])}
    return {"cpuPercent": rng.randint(88, 100), "availableMemoryPercent": rng.randint(3, 25),
            "topProcess": rng.choice(APPS)}


def seed_fleet(db, devices=180, days=14, per_device_day=0.45, rng_seed=7):
    rng = random.Random(rng_seed)
    policies = {p["id"]: p for p in get_policies(db)}
    fleet = []
    for i in range(devices):
        dept = weighted(rng, DEPARTMENTS)
        fleet.append((f"fleet-{i:04d}", f"{dept[:3].upper()}-MBP-{100 + i}", dept))
    now = time.time()
    rows = []
    for dev_id, name, dept in fleet:
        n = int(rng.expovariate(1 / (per_device_day * days)))
        for _ in range(min(n, 40)):
            day = rng.randint(0, days - 1)
            base = time.localtime(now - day * DAY)
            if base.tm_wday >= 5 and rng.random() < 0.85:
                continue  # weekends are quiet
            hour = int(min(18, max(8, rng.gauss(11.5, 2.6))))
            # Failures surface when people join calls: a peak just before the hour.
            minute = rng.randint(52, 59) if rng.random() < 0.38 else rng.randint(0, 59)
            t = time.mktime((base.tm_year, base.tm_mon, base.tm_mday, hour, minute, rng.randint(0, 59), 0, 0, -1))
            if t > now:
                continue
            issue = weighted(rng, ISSUE_WEIGHTS)
            pol = policies[issue]
            if pol["mode"] == "off":
                status = "reported"
            else:
                status = weighted(rng, [("fixed", 70), ("rejected", 9), ("escalated", 9),
                                        ("failed", 3), ("resolved", 9)])
            rows.append((uuid.uuid4().hex, dev_id, name, dept, pol["section"], issue, pol["label"],
                         "warn" if issue in ("audio.quiet", "audio.clipping") else "bad", status,
                         pol["action"], pol["execution"], None, json.dumps(fake_diagnostics(rng, issue)),
                         json.dumps([{"t": t, "status": "detected"}, {"t": t + 4, "status": status}]),
                         t, t + 4, rng.randint(2500, 9000)))
    db.executemany("""INSERT INTO incidents (id, fleet, device_id, device_name, department, section, issue,
        title, severity, simulated, status, action, execution, outcome, diagnostics, after, timeline,
        created_at, updated_at, duration_ms) VALUES (?,1,?,?,?,?,?,?,?,0,?,?,?,?,?,NULL,?,?,?,?)""", rows)
    db.commit()
    return len(rows)


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "SetupCheckCentral/1.0"

    def log_request(self, code="-", size="-"):
        # Polling is constant; only show what went wrong.
        if str(code)[:1] in ("4", "5"):
            super().log_request(code, size)

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 200_000:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        db = self.server.db
        if url.path in ("/", "/dashboard", "/index.html"):
            with open(DASHBOARD, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path == "/api/health":
            return self.send_json({"ok": True, "time": time.time()})
        if url.path == "/api/policies":
            with lock:
                return self.send_json({"policies": get_policies(db)})
        if url.path == "/api/incidents":
            limit = max(1, min(500, int(q.get("limit", ["60"])[0])))
            live_only = q.get("live", ["0"])[0] == "1"
            with lock:
                close_stale(db)
                rows = db.execute(
                    "SELECT * FROM incidents " + ("WHERE fleet = 0 " if live_only else "") +
                    "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            return self.send_json({"incidents": [row_dict(r) for r in rows]})
        if url.path == "/api/stats":
            days = max(1, min(60, int(q.get("days", ["14"])[0])))
            fleet = q.get("fleet", ["1"])[0] == "1"
            with lock:
                return self.send_json(stats(db, days, fleet))
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        db = self.server.db
        try:
            body = self.read_json()
            if url.path == "/api/incidents":
                with lock:
                    iid = create_incident(db, body)
                return self.send_json({"id": iid}, 201)
            if url.path == "/api/fleet":
                with lock:
                    db.execute("DELETE FROM incidents WHERE fleet = 1")
                    n = seed_fleet(db, rng_seed=int(time.time()) % 1000)
                return self.send_json({"seeded": n})
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"error": "not found"}, 404)

    def do_PATCH(self):
        m = re.fullmatch(r"/api/incidents/([A-Za-z0-9_-]{1,64})", urlparse(self.path).path)
        if not m:
            return self.send_json({"error": "not found"}, 404)
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)
        with lock:
            ok = update_incident(self.server.db, m.group(1), body)
        self.send_json({"ok": ok}, 200 if ok else 404)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/policies":
            return self.send_json({"error": "not found"}, 404)
        try:
            body = self.read_json()
            with lock:
                save_policies(self.server.db, body.get("policies") or [])
                return self.send_json({"policies": get_policies(self.server.db)})
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)

    def do_DELETE(self):
        path = urlparse(self.path).path
        db = self.server.db
        with lock:
            if path == "/api/fleet":
                db.execute("DELETE FROM incidents WHERE fleet = 1")
            elif path == "/api/incidents":
                db.execute("DELETE FROM incidents WHERE fleet = 0")
            else:
                return self.send_json({"error": "not found"}, 404)
            db.commit()
        self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to let teammates' laptops report too")
    ap.add_argument("--no-seed", action="store_true", help="do not create the simulated fleet")
    args = ap.parse_args()

    db = connect()
    if not args.no_seed and not db.execute("SELECT 1 FROM incidents WHERE fleet = 1 LIMIT 1").fetchone():
        n = seed_fleet(db)
        print(f"Seeded a simulated fleet: {n} incidents over 14 days (marked as simulated).")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.db = db
    print(f"Setup Check central on http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
