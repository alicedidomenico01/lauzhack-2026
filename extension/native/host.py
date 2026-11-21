#!/usr/bin/env python3
"""Setup Check local helper: native messaging host.

The browser cannot read the Wi-Fi SSID. This tiny process can, and answers one
JSON message at a time over stdin/stdout using the native messaging framing
(4-byte little-endian length prefix, then UTF-8 JSON).

Request:  {"cmd": "wifi"}
Response: {"ssid": "freewifi-epfl", "interface": "en0", "source": "networksetup"}
          or {"ssid": null, "reason": "..."}
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


def run(cmd, timeout=4):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        ).stdout
    except Exception:
        return ""


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
    out = run(["system_profiler", "SPAirPortDataType", "-json"], timeout=10)
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

    return {
        "ssid": None,
        "reason": (
            "No Wi-Fi SSID available. Either this machine is on Ethernet, or "
            "macOS withheld it: System Settings -> Privacy & Security -> "
            "Location Services must allow the app that launches this helper."
        ),
    }


def main():
    message = read_message()
    if message is None:
        return

    cmd = message.get("cmd")
    if cmd == "wifi":
        write_message(wifi())
    else:
        write_message({"error": f"unknown cmd: {cmd}"})


if __name__ == "__main__":
    main()
