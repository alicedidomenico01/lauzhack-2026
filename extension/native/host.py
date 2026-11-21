#!/usr/bin/env python3
"""Setup Check local helper: native messaging host.

The browser cannot read the Wi-Fi SSID, the CPU load or the memory pressure.
This tiny process can, and answers one JSON message at a time over stdin/stdout
using the native messaging framing (4-byte little-endian length, then UTF-8 JSON).

  {"cmd": "wifi"}   -> {"ssid": "freewifi-epfl", "interface": "en0", ...}
  {"cmd": "stats"}  -> {"cpu_percent": 37.4, "memory_free_percent": 42,
                        "top": "Google Chrome", "top_cpu": 18.2, "cores": 10}

Remote actions (the extension only calls these after the employee had the
chance to reject them):

  {"cmd": "whoami"}                       -> {"name": "Alice's MacBook Pro", "os": "macOS 14.5"}
  {"cmd": "audio_status"}                 -> {"input_volume": 0, "default_input": "MacBook Pro Microphone"}
  {"cmd": "set_input_volume", "value": 75}   (or "delta": 20)
                                          -> {"ok": true, "before": 0, "input_volume": 75}
  {"cmd": "switch_input", "name": "AirPods Pro"}   needs `brew install switchaudio-osx`
  {"cmd": "wifi_join", "ssid": "eduroam"}          a network this Mac already knows
  {"cmd": "quit_app", "name": "Docker Desktop"}    asks the app to quit, never system apps
"""

import json
import os
import re
import shutil
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


def top_memory():
    """The process holding the most resident memory, in MB."""
    out = run(["ps", "-A", "-o", "rss=,comm=", "-m"])
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        try:
            kb = int(parts[0])
        except ValueError:
            continue
        return {"top_mem": parts[1].rsplit("/", 1)[-1][:40], "top_mem_mb": round(kb / 1024)}
    return {"top_mem": None, "top_mem_mb": None}


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
    payload.update(top_memory())
    payload["memory_free_percent"] = memory_free_percent()
    payload["cores"] = run(["sysctl", "-n", "hw.ncpu"]).strip() or None
    return payload


# ---------------------------------------------------------------- remote actions

# Chrome starts native hosts with a minimal PATH: look in Homebrew's places too.
EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"]

# Never quit these, whatever the extension asks.
PROTECTED_APPS = {
    "finder", "dock", "systemuiserver", "windowserver", "loginwindow", "kernel_task",
    "google chrome", "chrome", "google chrome helper", "system settings", "system preferences",
    "launchd", "controlcenter", "coreaudiod", "python", "python3",
}


def run_full(cmd, timeout=10):
    """(exit code, stdout, stderr); never raises."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def tool(name):
    return shutil.which(name, path=os.pathsep.join([os.environ.get("PATH", ""), *EXTRA_PATHS]))


def clean_name(value, limit=100):
    """A device, network or app name: plain text, no control characters."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > limit or any(ord(c) < 32 for c in value):
        return None
    return value


def whoami():
    name = run(["scutil", "--get", "ComputerName"]).strip() or None
    version = run(["sw_vers", "-productVersion"]).strip()
    return {"name": name, "os": f"macOS {version}" if version else None}


def input_volume():
    out = run(["osascript", "-e", "input volume of (get volume settings)"]).strip()
    return int(out) if out.isdigit() else None


def audio_status():
    status = {"input_volume": input_volume(), "switch_available": bool(tool("SwitchAudioSource"))}
    if status["switch_available"]:
        code, out, _ = run_full([tool("SwitchAudioSource"), "-c", "-t", "input"])
        status["default_input"] = out if code == 0 and out else None
    return status


def set_input_volume(message):
    before = input_volume()
    if "value" in message:
        target = message.get("value")
    else:
        delta = message.get("delta")
        if not isinstance(delta, (int, float)) or before is None:
            return {"ok": False, "reason": "need a value, or a delta and a readable volume"}
        target = before + delta
    if not isinstance(target, (int, float)):
        return {"ok": False, "reason": "value must be a number"}
    target = int(max(0, min(100, round(target))))
    code, _, err = run_full(["osascript", "-e", f"set volume input volume {target}"])
    if code != 0:
        return {"ok": False, "reason": err or "osascript failed", "before": before}
    return {"ok": True, "before": before, "input_volume": input_volume()}


def switch_input(message):
    name = clean_name(message.get("name"))
    if not name:
        return {"ok": False, "reason": "bad device name"}
    binary = tool("SwitchAudioSource")
    if not binary:
        return {"ok": False, "reason": "SwitchAudioSource is not installed (brew install switchaudio-osx)"}
    code, out, err = run_full([binary, "-t", "input", "-s", name])
    if code != 0:
        return {"ok": False, "reason": err or out or f"could not switch to {name}"}
    return {"ok": True, "default_input": name}


def wifi_join(message):
    ssid = clean_name(message.get("ssid"), limit=32)
    if not ssid:
        return {"ok": False, "reason": "bad network name"}
    iface = wifi_interfaces()[0]
    # Without a password this joins networks whose password is in the keychain.
    code, out, err = run_full(["networksetup", "-setairportnetwork", iface, ssid], timeout=25)
    text = (out + " " + err).strip()
    if code != 0 or re.search(r"(could not|failed|error)", text, re.I):
        return {"ok": False, "reason": text or f"could not join {ssid}"}
    return {"ok": True, "ssid": ssid, "interface": iface}


APPLESCRIPT_RUNNING = ["-e", "on run argv", "-e", "return application (item 1 of argv) is running", "-e", "end run"]
APPLESCRIPT_QUIT = ["-e", "on run argv", "-e", "tell application (item 1 of argv) to quit", "-e", "end run"]


def quit_app(message):
    name = clean_name(message.get("name"))
    if not name:
        return {"ok": False, "reason": "bad app name"}
    if name.lower() in PROTECTED_APPS or name.lower().startswith("google chrome"):
        return {"ok": False, "reason": f"{name} is protected and is never quit remotely"}
    # The name travels as an argument, never inside the script text.
    code, out, _ = run_full(["osascript", *APPLESCRIPT_RUNNING, name])
    if code != 0 or out != "true":
        return {"ok": False, "reason": f"{name} is not a running app that can be asked to quit"}
    code, _, err = run_full(["osascript", *APPLESCRIPT_QUIT, name], timeout=15)
    if code != 0:
        return {"ok": False, "reason": err or f"{name} refused to quit"}
    return {"ok": True, "quit": name}


COMMANDS = {
    "wifi": lambda m: wifi(),
    "stats": lambda m: stats(),
    "whoami": lambda m: whoami(),
    "audio_status": lambda m: audio_status(),
    "set_input_volume": set_input_volume,
    "switch_input": switch_input,
    "wifi_join": wifi_join,
    "quit_app": quit_app,
}


# ---------------------------------------------------------------- main

def main():
    message = read_message()
    if message is None:
        return

    cmd = message.get("cmd")
    handler = COMMANDS.get(cmd)
    if not handler:
        write_message({"error": f"unknown cmd: {cmd}"})
        return
    try:
        write_message(handler(message))
    except Exception as e:  # always answer: Chrome waits for one reply
        write_message({"ok": False, "reason": f"{cmd} failed: {e}"})


if __name__ == "__main__":
    main()
