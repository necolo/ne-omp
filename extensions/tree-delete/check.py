import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


def main():
    plugin = Path(__file__).with_name("index.ts")
    with tempfile.TemporaryDirectory(prefix="omp-treed-check-") as temporary:
        root = Path(temporary)
        harness = root / "check.ts"
        source = plugin.read_text().replace("export default function treeDelete", "function treeDelete")
        harness.write_text(source + "\n" + HARNESS)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PI_", "OMP_"))}
        env["PI_CODING_AGENT_DIR"] = str(root / "agent")
        process = subprocess.Popen(
            ["omp", "--mode", "rpc", "--no-extensions", "-e", str(plugin), "-e", str(harness),
             "--no-skills", "--no-rules", "--no-lsp", "--cwd", str(root),
             "--model", "openai/gpt-4o", "--api-key", "treed-check-not-a-real-key"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = bytearray()
        try:
            receive(process, selector, buffer, lambda frame: frame.get("type") == "ready")
            process.stdin.write(b'{"id":"check","type":"prompt","message":"/tree-check"}\n')
            process.stdin.flush()
            frames = receive(process, selector, buffer, lambda frame: frame.get("method") == "notify" and (frame.get("message", "").startswith("PASS:") or frame.get("notifyType") == "error"))
            notices = [f for f in frames if f.get("method") == "notify"]
            assert notices and notices[-1]["message"].startswith("PASS:"), notices
            print(notices[-1]["message"])
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            errors = process.stderr.read().decode()
            selector.close()
            for stream in (process.stdout, process.stderr):
                stream.close()
            assert "Failed to load extension" not in errors, errors


# ─── Local helpers ───────────────────────────────────────────


def receive(process, selector, buffer, predicate):
    frames = []
    deadline = time.monotonic() + 60
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


HARNESS = r'''
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, basename } from "node:path";

export default function (pi) {
    let handler;
    const binding = Object.create(pi);
    binding.registerCommand = (name, command) => { assert.equal(name, "treed"); handler = command.handler; };
    treeDelete(binding);
    pi.registerCommand("tree-check", { handler: async (_args, ctx) => {
        try {
            for (const scenario of ["inactive", "active", "root", "cancel", "reload-cancel", "busy"]) {
                let ids;
                await ctx.newSession({ setup: async manager => {
                    manager.resetLeaf();
                    const root = manager.appendMessage({ role: "user", content: "ROOT", timestamp: 1 });
                    const target = manager.appendMessage({ role: "user", content: "TARGET", timestamp: 2 });
                    const child = manager.appendMessage({ role: "user", content: "CHILD", timestamp: 3 });
                    manager.branch(root);
                    const sibling = manager.appendMessage({ role: "user", content: "SIBLING", timestamp: 4 });
                    const label = manager.appendLabelChange(target, "remove-label");
                    if (scenario === "active") manager.branch(child);
                    ids = { root, target, child, sibling, label };
                    await manager.flush();
                }});
                const path = ctx.sessionManager.getSessionFile();
                const before = readFileSync(path, "utf8");
                let shown = 0;
                const notices = [];
                const scoped = Object.create(ctx);
                scoped.mode = "tui";
                scoped.hasUI = true;
                scoped.ui = {
                    notify: (message, kind) => notices.push({ message, kind }),
                    confirm: async (_title, text) => {
                        assert.match(text, scenario === "root" ? /Delete 5 entries/ : /Delete 2 entries/);
                        return scenario !== "cancel";
                    },
                    custom: async factory => {
                        if (shown++) return undefined;
                        let result;
                        const component = factory({ terminal: { rows: 30 } }, null, null, value => result = value);
                        const view = component.render(100).join("\n");
                        assert.match(view, /Delete.*Ctrl\+X/);
                        assert.match(view, /ROOT/);
                        const query = scenario === "root" ? "ROOT" : "TARGET";
                        for (const char of query) component.handleInput(char);
                        component.handleInput("\x18");
                        assert.ok(result);
                        return result;
                    },
                };
                if (scenario === "busy") scoped.isIdle = () => false;
                if (scenario === "reload-cancel") scoped.switchSession = async () => ({ cancelled: true });
                await handler("", scoped);
                const current = ctx.sessionManager.getEntries();
                const has = id => current.some(entry => entry.id === id);
                if (["cancel", "busy", "reload-cancel"].includes(scenario)) {
                    assert.equal(readFileSync(path, "utf8"), before, scenario);
                    assert.ok(has(ids.target) && has(ids.child));
                    if (scenario !== "cancel") assert.equal(notices.at(-1).kind, "error");
                } else {
                    assert.ok(!has(ids.target) && !has(ids.child) && !has(ids.label), scenario);
                    assert.equal(has(ids.root), scenario !== "root");
                    assert.equal(has(ids.sibling), scenario !== "root");
                    const leaf = ctx.sessionManager.getLeafEntry();
                    assert.equal(leaf.parentId, scenario === "active" ? ids.root : scenario === "root" ? null : ids.sibling);
                    assert.equal(notices.at(-1).kind, "info", JSON.stringify(notices));
                    const backups = readdirSync(dirname(path)).filter(name => name.startsWith(basename(path) + ".treed-"));
                    assert.equal(backups.length, 1);
                    assert.equal(readFileSync(dirname(path) + "/" + backups[0], "utf8"), before);
                    const reopened = await pi.pi.SessionManager.open(path);
                    assert.equal(reopened.getLeafEntry().parentId, leaf.parentId);
                    assert.ok(!reopened.getEntry(ids.target));
                    await reopened.close();
                    const continuation = ctx.sessionManager.appendMessage({ role: "user", content: "AFTER", timestamp: 5 });
                    await ctx.sessionManager.flush();
                    assert.equal(ctx.sessionManager.getEntry(continuation).parentId, leaf.id);
                    assert.ok(!readFileSync(path, "utf8").includes('"content":"TARGET"'));
                }
            }
            ctx.ui.notify("PASS: real omp loader, native tree rendering and Ctrl+X, descendant deletion, sibling preservation, labels, active/root rollback, confirmation cancellation, reload cancellation, busy refusal, backups, reopening and continued appends", "info");
        } catch (error) { ctx.ui.notify(String(error) + "\n" + error.stack, "error"); }
    }});
}
'''


if __name__ == "__main__":
    main()
