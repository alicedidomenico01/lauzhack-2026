#!/usr/bin/env python3
"""Setup Check local helper: native messaging host.

The browser cannot read the Wi-Fi SSID, the CPU load or the memory pressure.
This tiny process can, and answers one JSON message at a time over stdin/stdout
using the native messaging framing (4-byte little-endian length, then UTF-8 JSON).

  {"cmd": "wifi"}   -> {"ssid": "freewifi-epfl", "interface": "en0", ...}
  {"cmd": "stats"}  -> {"cpu_percent": 37.4, "memory_free_percent": 42,
                        "top": "Google Chrome", "top_cpu": 18.2, "cores": 10}
"""

import json
import re
import struct
import subprocess
import sys


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack("<I", header)[0]
    payload = sys.stdin.buffer.read(length)
    if not payload:
        return None
    return json.loads(payload.decode("utf-8"))


def write_message(obj):
    body = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def run(cmd, timeout=6):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        ).stdout
    except Exception:
        return ""


# ---------------------------------------------------------------- Wi-Fi

def wifi_interfaces():
    out = run(["networksetup", "-listallhardwareports"])
    interfaces = []
    current = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Hardware Port:"):
            current = line.split(":", 1)[1].strip()
        elif line.startswith("Device:") and current:
            if "Wi-Fi" in current or "AirPort" in current:
                interfaces.append(line.split(":", 1)[1].strip())
            current = None
    return interfaces or ["en0"]


def via_networksetup():
    for iface in wifi_interfaces():
        out = run(["networksetup", "-getairportnetwork", iface])
        match = re.search(r"Current Wi-Fi Network:\s*(.+)", out)
        if match:
            return {
                "ssid": match.group(1).strip(),
                "interface": iface,
                "source": "networksetup",
            }
    return None


def via_system_profiler():
    out = run(["system_profiler", "SPAirPortDataType", "-json"], timeout=12)
    if not out:
        return None
    try:
        data = json.loads(out)
    except Exception:
        return None

    for block in data.get("SPAirPortDataType", []):
        for iface in block.get("spairport_airport_interfaces", []):
            current = iface.get("spairport_current_network_information")
            if not isinstance(current, dict):
                continue
            name = current.get("_name") or current.get("spairport_network_ssid")
            if name and name != "<redacted>":
                return {
                    "ssid": name,
                    "interface": iface.get("_name"),
                    "source": "system_profiler",
                }
    return None


def wifi():
    for strategy in (via_networksetup, via_system_profiler):
        try:
            found = strategy()
        except Exception:
            found = None
        if found and found.get("ssid"):
            return found
    return {"ssid": None, "reason": "no Wi-Fi SSID available on this machine"}


# ---------------------------------------------------------------- CPU / memory

def total_cpu_percent():
    """Sum of per-process CPU. On macOS 100% == one full core."""
    out = run(["ps", "-A", "-o", "%cpu="])
    total = 0.0
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            total += float(line)
        except ValueError:
            continue
    return round(total, 1)


def top_process():
    out = run(["ps", "-A", "-o", "%cpu=,comm=", "-r"])
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            cpu = float(parts[0])
        except ValueError:
            continue
        name = parts[1].rsplit("/", 1)[-1]
        return {"top": name[:40], "top_cpu": round(cpu, 1)}
    return {"top": None, "top_cpu": None}


def memory_free_percent():
    """Free + inactive pages as a share of physical memory."""
    total_out = run(["sysctl", "-n", "hw.memsize"]).strip()
    vm_out = run(["vm_stat"])
    if not total_out or not vm_out:
        return None

    try:
        total_bytes = int(total_out)
    except ValueError:
        return None

    page_size = 4096
    match = re.search(r"page size of (\d+) bytes", vm_out)
    if match:
        page_size = int(match.group(1))

    def pages(label):
        found = re.search(rf"{label}:\s+(\d+)\.", vm_out)
        return int(found.group(1)) if found else 0

    free = (pages("Pages free") + pages("Pages inactive")) * page_size
    if total_bytes <= 0:
        return None
    return round(100 * free / total_bytes, 0)


def stats():
    payload = {"cpu_percent": total_cpu_percent()}
    payload.update(top_process())
    payload["memory_free_percent"] = memory_free_percent()
    payload["cores"] = run(["sysctl", "-n", "hw.ncpu"]).strip() or None
    return payload


# ---------------------------------------------------------------- main

def main():
    message = read_message()
    if message is None:
        return

    cmd = message.get("cmd")
    if cmd == "wifi":
        write_message(wifi())
    elif cmd == "stats":
        write_message(stats())
    else:
        write_message({"error": f"unknown cmd: {cmd}"})


if __name__ == "__main__":
    main()
