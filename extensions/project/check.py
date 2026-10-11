import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


def main():
    with tempfile.TemporaryDirectory(prefix="omp-project-check-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        alpha = root / "alpha"
        beta = root / "beta project"
        for directory in (agent, alpha, beta):
            directory.mkdir()
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("PI_", "OMP_"))
        }
        env["PI_CODING_AGENT_DIR"] = str(agent)
        process = subprocess.Popen(
            ["omp", "--mode", "rpc", "--no-extensions", "-e", str(Path(__file__).with_name("index.ts")),
             "--no-skills", "--no-rules", "--no-lsp", "--cwd", str(alpha),
             "--model", "openai/gpt-4o", "--api-key", "project-check-not-a-real-key"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = bytearray()
        try:
            receive(process, selector, buffer, lambda frame: frame.get("type") == "ready")
            config = agent / "projects.json"
            command(process, selector, buffer, "/project --add alpha .")
            assert json.loads(config.read_text()) == {"alpha": str(alpha)}
            command(process, selector, buffer, f'/project --add beta "{beta}"')
            command(process, selector, buffer, "/project --rename beta renamed")
            assert json.loads(config.read_text()) == {"alpha": str(alpha), "renamed": str(beta)}
            command(process, selector, buffer, "/project --update renamed .")
            assert json.loads(config.read_text())["renamed"] == str(alpha)
            before = config.read_bytes()
            for text in (
                "/project --add alpha .",
                "/project --rename renamed alpha",
                "/project --update missing .",
                "/project --delete missing",
                "/project --update alpha nonexistent",
                "/project --add extra . unexpected",
                '/project --add bad "unclosed',
            ):
                command(process, selector, buffer, text, error=True)
                assert config.read_bytes() == before, text
            command(process, selector, buffer, "/project --delete renamed")
            assert json.loads(config.read_text()) == {"alpha": str(alpha)}
            command(process, selector, buffer, "/project --add home ~")
            assert json.loads(config.read_text())["home"] == str(Path.home())
            config.write_text("invalid JSON")
            command(process, selector, buffer, "/project --delete alpha", error=True)
            assert config.read_text() == "invalid JSON"
            print("PASS: real omp commands; persistence, rename/update/delete, quoted paths, ~, collisions, invalid input, corrupt config")
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            selector.close()
            for stream in (process.stdout, process.stderr):
                stream.close()


# ─── Local helpers ───────────────────────────────────────────


def receive(process, selector, buffer, predicate):
    frames = []
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        while b"\n" in buffer:
            line, _, remainder = buffer.partition(b"\n")
            buffer[:] = remainder
            frame = json.loads(line)
            assert frame.get("type") not in ("agent_start", "extension_error"), frame
            frames.append(frame)
            if predicate(frame):
                return frames
        if not selector.select(max(0, deadline - time.monotonic())):
            break
        chunk = os.read(process.stdout.fileno(), 65536)
        if not chunk:
            raise AssertionError(process.stderr.read().decode())
        buffer.extend(chunk)
    raise AssertionError(f"RPC timeout: {frames}")


def command(process, selector, buffer, message, error=False):
    identifier = str(time.monotonic_ns())
    process.stdin.write((json.dumps({"id": identifier, "type": "prompt", "message": message}) + "\n").encode())
    process.stdin.flush()
    frames = receive(process, selector, buffer, lambda frame: frame.get("type") == "response" and frame.get("id") == identifier)
    assert frames[-1]["success"], frames[-1]
    notices = [frame for frame in frames if frame.get("method") == "notify"]
    assert notices and notices[-1]["notifyType"] == ("error" if error else "info"), frames


if __name__ == "__main__":
    main()
