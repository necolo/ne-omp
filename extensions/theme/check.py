import fcntl
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


def main(appearance):
    with tempfile.TemporaryDirectory(prefix="omp-theme-check-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        (agent / "themes").mkdir(parents=True)
        config = agent / "config.yml"
        config.write_text("setupVersion: 2\ntheme:\n  dark: dark\n  light: dark\nsymbolPreset: ascii\n")
        before = config.read_bytes()
        background = b"ffff/ffff/ffff" if appearance == "light" else b"0000/0000/0000"
        (agent / "themes" / "broken.json").write_text('{"name":"broken","colors":{}}')
        state = root / "state.jsonl"
        probe = root / "probe.ts"
        extension = Path(__file__).with_name("index.ts").resolve()
        (root / "index.ts").write_bytes(extension.read_bytes())
        probe.write_text(PROBE.replace("__STATE__", json.dumps(str(state))))
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("PI_", "OMP_"))}
        env.update(PI_CODING_AGENT_DIR=str(agent), OMP_SKIP_SETUP="1",
                   TERM="xterm-256color", COLORTERM="truecolor",
                   COLORFGBG="0;15" if appearance == "light" else "15;0")
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        arguments = ["omp", "--no-extensions", "-e", str(probe), "--no-skills", "--no-rules",
                     "--no-lsp", "--no-session", "--no-title", "--cwd", str(root),
                     "--model", "openai/gpt-4o", "--api-key", "theme-check-not-a-real-key"]
        process = subprocess.Popen(
            arguments, stdin=slave, stdout=slave, stderr=slave, env=env,
        )
        os.close(slave)
        terminal = bytearray()
        try:
            def read_terminal():
                pump(master, terminal, background)

            def saved_value(key):
                result = subprocess.run(["omp", "config", "get", key, "--json"],
                                        env=env, text=True, capture_output=True, timeout=15, check=True)
                return json.loads(result.stdout)["value"]

            def frames():
                return [json.loads(line) for line in state.read_text().splitlines()] if state.exists() else []

            def wait_for(predicate):
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    read_terminal()
                    if predicate():
                        return
                    if process.poll() is not None:
                        break
                raise AssertionError(f"State: {frames()[-5:]}\n" + terminal.decode(errors="replace")[-8000:])

            def restart(preferences=None):
                nonlocal process, master
                # Saving must survive an abrupt exit, not depend on shutdown flushing.
                process.kill()
                process.wait(timeout=5)
                if preferences is not None:
                    config.write_text(json.dumps(preferences))
                state.write_text("")
                terminal.clear()
                os.close(master)
                master, slave = os.openpty()
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
                process = subprocess.Popen(arguments, stdin=slave, stdout=slave, stderr=slave, env=env)
                os.close(slave)
                wait_for(lambda: any(frame["event"] == "ready" for frame in frames()))

            def send(data):
                os.write(master, data)

            def open_picker():
                offset = len(terminal)
                previous = sum(frame["event"] == "begin" for frame in frames())
                send(b"/theme\r")
                wait_for(lambda: sum(frame["event"] == "begin" for frame in frames()) > previous
                         and (previous > 0 or "Theme · Live preview" in terminal[offset:].decode(errors="replace")))
                read_terminal()

            def close_picker(data, expected, save=False):
                nonlocal before
                previous = sum(frame["event"] == "end" for frame in frames())
                send(data)
                wait_for(lambda: sum(frame["event"] == "end" for frame in frames()) > previous)
                assert frames()[-1]["current"] == expected, frames()[-1]
                if save:
                    assert saved_value("theme.dark") == expected
                    assert saved_value("theme.light") == expected
                    assert saved_value("symbolPreset") == "ascii"
                    before = config.read_bytes()
                else:
                    assert config.read_bytes() == before

            wait_for(lambda: any(frame["event"] == "ready" for frame in frames()))
            original = frames()[-1]["accent"]
            open_picker()
            send(b"titanium")
            wait_for(lambda: frames()[-1]["accent"] != original)
            assert b"THEME_RESPONSE_SAMPLE" in terminal
            close_picker(b"\x1b", "dark")
            assert frames()[-1]["accent"] == original

            open_picker()
            previous = sum(frame["event"] == "end" for frame in frames())
            send(b"\x1b[B" * 12 + b"\x1b")
            wait_for(lambda: sum(frame["event"] == "end" for frame in frames()) > previous)
            for _ in range(8):
                read_terminal()
                time.sleep(0.05)
            assert frames()[-1]["current"] == "dark" and frames()[-1]["accent"] == original

            open_picker()
            offset = len(terminal)
            send(b"broken")
            wait_for(lambda: "Preview failed" in terminal[offset:].decode(errors="replace"))
            ended = sum(frame["event"] == "end" for frame in frames())
            send(b"\r")
            for _ in range(8):
                read_terminal()
                time.sleep(0.05)
            assert sum(frame["event"] == "end" for frame in frames()) == ended
            assert frames()[-1]["accent"] == original
            close_picker(b"\x1b", "dark")

            open_picker()
            send(b"titanium")
            wait_for(lambda: frames()[-1]["accent"] != original)
            close_picker(b"\r", "titanium", save=True)
            committed = frames()[-1]["accent"]

            open_picker()
            offset = len(terminal)
            send(b"zzzznomatchingtheme")
            wait_for(lambda: "No matching themes" in terminal[offset:].decode(errors="replace"))
            close_picker(b"\x1b", "titanium")

            open_picker()
            send(b"light")
            wait_for(lambda: frames()[-1]["accent"] != committed)
            close_picker(b"\x03", "titanium")
            assert frames()[-1]["accent"] == committed
            assert config.read_bytes() == before
            open_picker()
            send(b"light")
            wait_for(lambda: frames()[-1]["accent"] != committed)
            close_picker(b"\r", "light", save=True)
            persisted = frames()[-1]["accent"]

            open_picker()
            send(b"titanium")
            wait_for(lambda: frames()[-1]["accent"] == committed)
            offset = len(terminal)
            send(b"\x18")
            wait_for(lambda: "titanium" in frames()[-1]["hidden"]
                     and "No matching themes" in terminal[offset:].decode(errors="replace"))
            before = config.read_bytes()
            assert saved_value("theme.dark") == "light" and saved_value("theme.light") == "light"
            close_picker(b"\x1b", "light")

            open_picker()
            offset = len(terminal)
            send(b"titanium")
            wait_for(lambda: "No matching themes" in terminal[offset:].decode(errors="replace"))
            ended = sum(frame["event"] == "end" for frame in frames())
            send(b"\r")
            for _ in range(4):
                read_terminal()
            assert sum(frame["event"] == "end" for frame in frames()) == ended
            offset = len(terminal)
            send(b"\x19")
            wait_for(lambda: frames()[-1]["accent"] == committed
                     and "Hidden" in terminal[offset:].decode(errors="replace"))
            send(b"\x19")
            wait_for(lambda: frames()[-1]["accent"] == persisted)
            close_picker(b"\x1b", "light")

            # A different terminal appearance must still restore the same saved theme.
            background = b"0000/0000/0000" if appearance == "light" else b"ffff/ffff/ffff"
            env["COLORFGBG"] = "15;0" if appearance == "light" else "0;15"
            restart()
            wait_for(lambda: frames()[-1]["current"] == "light" and frames()[-1]["accent"] == persisted)
            assert saved_value("theme.dark") == "light" and saved_value("theme.light") == "light"
            assert "titanium" in frames()[-1]["hidden"]
            open_picker()
            offset = len(terminal)
            send(b"titanium")
            wait_for(lambda: "No matching themes" in terminal[offset:].decode(errors="replace"))
            offset = len(terminal)
            send(b"\x19")
            wait_for(lambda: "Hidden" in terminal[offset:].decode(errors="replace"))
            send(b"\x18")
            wait_for(lambda: "titanium" not in frames()[-1]["hidden"])
            for _ in range(4):
                read_terminal()
            before = config.read_bytes()
            close_picker(b"\x1b", "light")
            open_picker()
            send(b"titanium")
            wait_for(lambda: frames()[-1]["accent"] == committed)
            close_picker(b"\x1b", "light")

            available = next(frame["themes"] for frame in frames() if frame["event"] == "ready")
            restart({
                "setupVersion": 2,
                "theme": {"dark": "light", "light": "light"},
                "symbolPreset": "ascii",
                "themePicker": {"hiddenThemes": available},
            })
            before = config.read_bytes()
            open_picker()
            wait_for(lambda: "All themes are hidden" in terminal.decode(errors="replace"))
            send(b"\x19")
            send(b"titanium")
            wait_for(lambda: frames()[-1]["accent"] == committed)
            send(b"\x18")
            wait_for(lambda: "titanium" not in frames()[-1]["hidden"])
            for _ in range(4):
                read_terminal()
            before = config.read_bytes()
            send(b"\x19")
            close_picker(b"\x1b", "light")
            restart()
            before = config.read_bytes()
            open_picker()
            wait_for(lambda: frames()[-1]["accent"] == committed)
            assert "light" in frames()[-1]["hidden"]
            close_picker(b"\x1b", "light")
            print(f"PASS ({appearance} terminal): real OMP TUI; live preview, search, "
                  "Enter applies and persists, cancellation leaves config unchanged, invalid theme, "
                  "rapid cancellation, unified dark/light settings, restart with opposite appearance, "
                  "persistent hiding, show-hidden toggle, restore, all-hidden recovery, hidden current theme")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            os.close(master)


# ─── Local helpers ───────────────────────────────────────────


def pump(master, terminal, background):
    if not select.select([master], [], [], 0.1)[0]:
        return
    try:
        data = os.read(master, 65536)
    except OSError:
        return
    terminal.extend(data)
    for _ in re.finditer(rb"\x1b\[6n", data):
        os.write(master, b"\x1b[1;1R")
    if b"\x1b]11;?" in data:
        os.write(master, b"\x1b]11;rgb:" + background + b"\x1b\\")


PROBE = '''
import { appendFileSync } from "node:fs";
import themePicker from "./index.ts";
import { getCurrentThemeName } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
export default function (pi) {
    let command;
    themePicker({ pi: pi.pi, registerCommand(_name, definition) { command = definition; } });
    let last;
    function record(ctx, event, themes) {
        const value = {
            event, current: getCurrentThemeName(), accent: ctx.ui.theme.getColorHex("accent"),
            hidden: lookup("themePicker.hiddenThemes").get(pi.pi.settings),
            ...(themes ? { themes } : {}),
        };
        const key = JSON.stringify(value);
        if (key !== last) appendFileSync(__STATE__, key + "\\n");
        last = key;
    }
    pi.on("session_start", async (_event, ctx) => {
        pi.sendMessage({ customType: "theme-smoke", content: "## THEME_RESPONSE_SAMPLE\\n**Bold** and `code`.", display: true }, { triggerTurn: false });
        record(ctx, "ready", (await ctx.ui.getAllThemes()).map(item => item.name));
        ctx.setInterval(() => record(ctx, "palette"), 25);
    });
    pi.registerCommand("theme", {
        ...command,
        handler: async (args, ctx) => {
            record(ctx, "begin");
            await command.handler(args, ctx);
            record(ctx, "end");
        },
    });
}
'''


if __name__ == "__main__":
    main("dark")
    main("light")
