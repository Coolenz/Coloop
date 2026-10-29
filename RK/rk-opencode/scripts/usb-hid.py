"""Add only our keyboard/mouse to the existing RNDIS gadget, with timed rollback."""

import argparse
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GADGET = Path("/sys/kernel/config/usb_gadget/rockchip")
STATE = ROOT / ".runtime/hid-setup.json"
KEYBOARD = bytes.fromhex(
    "05010906a101050719e029e715002501750195088102950175088103"
    "9505750105081901290591029501750391039506750815002565"
    "0507190029658100c0"
)
MOUSE = bytes.fromhex(
    "05010902a1010901a10005091901290315002501950375018102"
    "950175058103050109300931150026ff7f751095028102"
    "09381581257f750895018106c0c0"
)
FUNCTIONS = {"hid.rk_keyboard": (KEYBOARD, 8, 1, 1), "hid.rk_mouse": (MOUSE, 6, 0, 0)}
LINKS = {"hid.rk_keyboard": "zz-rk-keyboard", "hid.rk_mouse": "zz-rk-mouse"}
ATTRS = ("bDeviceClass", "bDeviceSubClass", "bDeviceProtocol")


def write(path, value):
    path.write_text(str(value) + "\n")


def save(state):
    pending = STATE.with_suffix(".pending")
    pending.write_text(json.dumps(state, indent=2))
    pending.chmod(0o600)
    pending.replace(STATE)


def permissions():
    user = pwd.getpwnam("cat")
    for _ in range(30):
        identifiers = []
        for name in FUNCTIONS:
            dev = GADGET / "functions" / name / "dev"
            if dev.exists():
                identifiers.append(tuple(map(int, dev.read_text().strip().split(":"))))
        nodes = [
            node
            for node in Path("/dev").glob("hidg*")
            if (os.major(node.stat().st_rdev), os.minor(node.stat().st_rdev)) in identifiers
        ]
        if len(nodes) == 2:
            for node in nodes:
                os.chown(node, user.pw_uid, user.pw_gid)
                node.chmod(0o600)
            return
        time.sleep(0.2)
    raise RuntimeError("HID device nodes did not appear")


def apply():
    if STATE.exists():
        old = json.loads(STATE.read_text())
        if old.get("applied") and all((GADGET / "functions" / name).exists() for name in FUNCTIONS):
            permissions()
            print("HID is already configured")
            return
    configs = list((GADGET / "configs").iterdir())
    if len(configs) != 1 or not (GADGET / "functions/rndis.gs0").is_dir():
        raise RuntimeError("Expected exactly one existing RNDIS configuration")
    if any((GADGET / "functions" / name).exists() for name in FUNCTIONS):
        raise RuntimeError("Unexpected existing project HID function; inspect before changing it")
    state = {
        "udc": (GADGET / "UDC").read_text().strip(),
        "config": str(configs[0]),
        "attributes": {name: (GADGET / name).read_text().strip() for name in ATTRS},
        "unit": "rk-opencode-hid-rollback-" + str(int(time.time())),
        "applied": False,
    }
    if not state["udc"]:
        raise RuntimeError("Existing USB gadget is not bound")
    save(state)
    # This timer survives an SSH disconnect. Confirm cancels it after reconnecting.
    subprocess.run(
        [
            "systemd-run",
            "--unit=" + state["unit"],
            "--on-active=120s",
            sys.executable,
            str(Path(__file__).resolve()),
            "rollback",
        ],
        check=True,
    )
    try:
        write(GADGET / "UDC", "")
        for name, (descriptor, length, protocol, subclass) in FUNCTIONS.items():
            function = GADGET / "functions" / name
            function.mkdir()
            for attr, value in [
                ("protocol", protocol),
                ("subclass", subclass),
                ("report_length", length),
            ]:
                write(function / attr, value)
            (function / "report_desc").write_bytes(descriptor)
            (configs[0] / LINKS[name]).symlink_to(function)
        # IAD composite class; the existing RNDIS function and its OS descriptors stay intact.
        for name, value in zip(ATTRS, ("0xef", "0x02", "0x01")):
            write(GADGET / name, value)
        write(GADGET / "UDC", state["udc"])
        permissions()
        state["applied"] = True
        save(state)
        print("RNDIS + HID active; confirm within 120 seconds or automatic rollback runs")
    except BaseException:
        rollback()
        raise


def rollback():
    if not STATE.exists():
        return
    state = json.loads(STATE.read_text())
    if Path(state["config"]).parent != GADGET / "configs":
        raise RuntimeError("Invalid saved USB configuration path")
    write(GADGET / "UDC", "")
    config = Path(state["config"])
    for name in FUNCTIONS:
        link = config / LINKS[name]
        function = GADGET / "functions" / name
        if link.is_symlink():
            if link.resolve() != function:
                raise RuntimeError("Refusing to remove an unexpected config link")
            link.unlink()
        if function.exists():
            function.rmdir()
    for name, value in state["attributes"].items():
        write(GADGET / name, value)
    write(GADGET / "UDC", state["udc"])
    state.update(applied=False, rolled_back_at=time.time())
    save(state)
    print("Original RNDIS gadget restored")


def confirm():
    state = json.loads(STATE.read_text())
    if not state.get("applied"):
        raise RuntimeError("HID was not applied")
    if state.get("confirmed_at"):
        print("HID configuration was already confirmed")
        return
    subprocess.run(["systemctl", "stop", state["unit"] + ".timer"], check=True)
    state["confirmed_at"] = time.time()
    save(state)
    print("HID configuration confirmed; USB network connection restored")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["apply", "rollback", "confirm", "status"])
    args = parser.parse_args()
    if args.action == "status":
        print(
            json.dumps(
                {
                    "udc": (GADGET / "UDC").read_text().strip(),
                    "functions": [p.name for p in (GADGET / "functions").iterdir()],
                    "hid_nodes": [str(p) for p in Path("/dev").glob("hidg*")],
                }
            )
        )
        return
    if os.geteuid() != 0:
        parser.error("This USB configuration action requires sudo")
    globals()[args.action]()


if __name__ == "__main__":
    main()
