import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

type Choice = { id: string; delete: boolean; summarize: boolean } | undefined;

/**
 * /treed: the native session tree with Delete / Ctrl+X to delete a whole subtree.
 * Enter navigates; Shift+Enter summarizes and navigates; Esc closes.
 * Initial filtering uses the same effective treeFilterMode setting as /tree.
 * Deletion requires confirmation and an idle local, persisted session.
 * The active leaf is preserved, or moves to the deleted node's parent.
 * Each deletion saves the original journal as <session>.treed-<uuid>.bak.
 * Shared blobs/artifacts are not erased: other branches may still use them.
 *
 * Reload extensions with /restart. Check: python3 <this-directory>/check.py
 */
export default function treeDelete(pi: ExtensionAPI) {
	let busy = false;
	pi.registerCommand("treed", {
		description: "Session tree: Delete / Ctrl+X removes the selected node and all descendants",
		async handler(_args, ctx) {
			if (busy) return;
			try {
				if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("/treed requires an interactive terminal.");
				assertIdle(ctx);
				busy = true;
				while (ctx.sessionManager.getEntries().length) {
					const sessionId = ctx.sessionManager.getSessionId();
					const choice = await chooseNode(pi, ctx);
					if (!choice) return;
					assertIdle(ctx);
					if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Session changed; reopen /treed.");
					if (!choice.delete) {
						await ctx.navigateTree(choice.id, { summarize: choice.summarize });
						return;
					}
					const entries = ctx.sessionManager.getEntries();
					const removed = subtreeIds(entries, choice.id);
					if (!await ctx.ui.confirm("Delete subtree?", `Delete ${removed.size} entries, including all descendants? A journal backup will be kept.`)) continue;
					assertIdle(ctx);
					if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getEntries().length !== entries.length) {
						throw new Error("Session changed during confirmation; reopen /treed.");
					}
					await deleteSubtree(pi, ctx, choice.id);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				busy = false;
			}
		},
	});
}

// ─── Local helpers ───────────────────────────────────────────

function assertIdle(ctx: ExtensionCommandContext) {
	if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current turn and queued messages to finish.");
	const jobs = ctx.getAsyncJobSnapshot();
	if (jobs && (jobs.running.length || jobs.delivery.queued || jobs.delivery.delivering)) throw new Error("Wait for background jobs to finish before deleting history.");
}

function chooseNode(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Choice> {
	return ctx.ui.custom<Choice>((tui, _theme, _keys, done) => {
		let deleting = false;
		const configuredFilter = lookup("treeFilterMode")?.get(pi.pi.settings);
		const tree = new pi.pi.TreeSelectorComponent(
			ctx.sessionManager.getTree(), ctx.sessionManager.getLeafId(), tui.terminal.rows,
			(id, options) => done({ id, delete: deleting, summarize: options.summarize }),
			() => done(undefined),
			(id, label) => {
				try {
					assertIdle(ctx);
					(ctx.sessionManager as SessionManager).appendLabelChange(id, label);
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
			},
			pi.pi.TREE_FILTER_MODES.find(mode => mode === configuredFilter),
		);
		return {
			render(width: number) {
				return ["Delete / Ctrl+X: delete selected subtree (with confirmation)", ...tree.render(width)];
			},
			invalidate() { tree.invalidate(); },
			handleInput(data: string) {
				if (matchesKey(data, "delete") || matchesKey(data, "ctrl+x")) {
					deleting = true;
					try { tree.handleInput("\r"); } finally { deleting = false; }
				} else tree.handleInput(data);
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}

function subtreeIds(entries: { id: string; parentId: string | null }[], root: string): Set<string> {
	if (!entries.some(entry => entry.id === root)) throw new Error("Selected entry no longer exists.");
	const children = new Map<string, string[]>();
	for (const entry of entries) {
		if (entry.parentId === null) continue;
		const ids = children.get(entry.parentId) ?? [];
		ids.push(entry.id);
		children.set(entry.parentId, ids);
	}
	const removed = new Set<string>();
	const stack = [root];
	while (stack.length) {
		const id = stack.pop()!;
		if (removed.has(id)) continue;
		removed.add(id);
		stack.push(...(children.get(id) ?? []));
	}
	return removed;
}

async function deleteSubtree(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string) {
	// The public context is read-only by type; the host passes its live manager.
	// Use its flush/reload methods, never mutate private indexes or resolved blobs.
	const manager = ctx.sessionManager as SessionManager;
	const path = manager.getSessionFile();
	if (!path) throw new Error("Deletion requires a persisted local session.");
	await manager.flush();
	assertIdle(ctx);
	const original = readFileSync(path, "utf8");
	const records = original.split("\n").filter(line => line.trim()).map(line => ({ line, entry: JSON.parse(line) }));
	const header = records.find(record => record.entry.type === "session")?.entry;
	if (header?.id !== manager.getSessionId()) throw new Error("Session file changed or is not a local journal.");
	const entries = records.filter(record => record.entry.type !== "session" && typeof record.entry.id === "string");
	const removed = subtreeIds(entries.map(record => record.entry), root);
	const selected = entries.find(record => record.entry.id === root)!.entry;
	let leaf = manager.getLeafId();
	if (leaf !== null && removed.has(leaf)) leaf = selected.parentId;
	const byId = new Map(entries.map(record => [record.entry.id, record.entry]));
	const droppedLabels = new Set(entries.filter(record => record.entry.type === "label" && removed.has(record.entry.targetId)).map(record => record.entry.id));
	const output: string[] = [];
	for (const { line, entry } of records) {
		if (removed.has(entry.id) || droppedLabels.has(entry.id)) continue;
		let changed = false;
		while (droppedLabels.has(entry.parentId)) { entry.parentId = byId.get(entry.parentId).parentId; changed = true; }
		if (entry.type === "branch_summary" && removed.has(entry.fromId)) { entry.fromId = selected.parentId ?? "root"; changed = true; }
		if (removed.has(entry.providerReplayThroughEntryId)) { delete entry.providerReplayThroughEntryId; changed = true; }
		if (entry.type === "compaction" && removed.has(entry.firstKeptEntryId)) throw new Error("A retained compaction references this subtree; deletion refused.");
		output.push(changed ? JSON.stringify(entry) : line);
	}
	while (leaf !== null && droppedLabels.has(leaf)) leaf = byId.get(leaf).parentId;
	// Loading chooses the final physical entry. A metadata-only marker preserves
	// the selected branch even when another branch is last in journal order.
	output.push(JSON.stringify({ type: "custom", id: randomUUID(), parentId: leaf, timestamp: new Date().toISOString(), customType: "necolo.tree-delete.leaf", data: { deletedRoot: root } }));
	const replacement = `${output.join("\n")}\n`;
	const backup = `${path}.treed-${randomUUID()}.bak`;
	const storage = new pi.pi.FileSessionStorage();
	writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
	await storage.writeTextAtomic(path, replacement, {
		expectedSize: Buffer.byteLength(original),
		commitGuard: () => ctx.isIdle() && !ctx.hasPendingMessages() && readFileSync(path, "utf8") === original,
	});
	try {
		await manager.setSessionFile(path);
		if ((await ctx.switchSession(path)).cancelled) throw new Error("Session reload was cancelled.");
	} catch (error) {
		await storage.writeTextAtomic(path, original, {
			expectedSize: Buffer.byteLength(replacement),
			commitGuard: () => readFileSync(path, "utf8") === replacement,
		});
		await manager.setSessionFile(path);
		throw new Error(`Deletion rolled back: ${error}`);
	}
	ctx.ui.notify(`Deleted ${removed.size} entries. Backup: ${backup}`, "info");
}
