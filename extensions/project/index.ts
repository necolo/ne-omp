import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CustomEditor, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

const usage = "/project [name] | --add <name> <path> | --rename <old> <new> | --delete <name> | --update <name> <path>";

/**
 * /project [name] starts a fresh session; without a name, opens the project picker.
 * /project --add omp ~/.omp registers a directory; --update changes its address.
 * /project --rename omp new-name and --delete omp only change the registry.
 *
 * Registry: <active agent directory>/projects.json (default ~/.omp/agent/projects.json).
 * Paths: existing local directories, ~ expansion, relative to cwd when saved;
 * quote paths containing spaces. No shell evaluation or directory deletion.
 *
 * OMP 18.8.0: switching is TUI-only and binds the stock CustomEditor so it can
 * dispatch native /move after newSession. Management also works in RPC.
 * Check: python3 ~/.omp/agent/extensions/project/check.py
 */
export default function projectExtension(pi: ExtensionAPI) {
	const configPath = join(pi.pi.getAgentDir(), "projects.json");
	let editor: CustomEditor | undefined;
	let switching = false;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.agent.kind !== "main") return;
		// ExtensionCommandContext has no cwd action; use the host's native /move dispatcher.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new pi.pi.CustomEditor(tui, theme, keybindings);
			return editor;
		});
	});

	pi.registerCommand("project", {
		description: "Choose a project and start a new session; --add / --rename / --delete / --update manage projects",
		getArgumentCompletions(prefix) {
			try {
				const names = Object.keys(readProjects(configPath)).sort();
				const options = ["--add", "--rename", "--delete", "--update"];
				const match = /^(--rename|--delete|--update)\s+(\S*)$/.exec(prefix);
				const values = match ? names : [...names, ...options];
				const partial = match ? match[2] : prefix;
				return values.filter(name => name.startsWith(partial)).map(name => ({
					value: match ? `${match[1]} ${name}` : name,
					label: name,
				}));
			} catch {
				return null;
			}
		},
		async handler(args, ctx) {
			try {
				const tokens = parseArguments(args);
				if (tokens[0]?.startsWith("--")) {
					updateProjects(configPath, tokens, ctx.cwd);
					ctx.ui.notify("Project configuration saved", "info");
					return;
				}
				if (tokens.length > 1) throw new Error(usage);
				if (ctx.mode !== "tui" || !editor?.onSubmit) {
					throw new Error("Project switching requires the interactive TUI; configuration commands are available outside it.");
				}
				if (switching || !ctx.isIdle() || ctx.hasPendingMessages()) {
					throw new Error("Wait for the current operation and queue to finish before switching projects.");
				}
				switching = true;
				try {
					const projects = readProjects(configPath);
					let name = tokens[0];
					if (!name) {
						const names = Object.keys(projects).sort();
						if (!names.length) throw new Error("No projects configured. Add one with /project --add <name> <path>.");
						name = await ctx.ui.select("Switch project (new session)", names.map(label => ({
							label,
							description: projects[label],
						})));
						if (!name) return;
					}
					if (!Object.hasOwn(projects, name)) throw new Error(`Project not found: ${name}`);
					const path = projectDirectory(projects[name], ctx.cwd);
					await switchProject(path, editor, ctx);
				} finally {
					switching = false;
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

// ─── Local helpers ───────────────────────────────────────────

function readProjects(path: string): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
		throw error;
	}
	const projects = JSON.parse(text);
	if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
		throw new Error(`Project configuration must be a JSON object mapping names to paths: ${path}`);
	}
	for (const [name, address] of Object.entries(projects)) {
		projectName(name);
		if (typeof address !== "string" || !address.trim()) throw new Error(`Invalid project path: ${name}`);
	}
	return Object.assign(Object.create(null), projects);
}

function updateProjects(path: string, tokens: string[], cwd: string): void {
	const [operation, name, value] = tokens;
	const expected = operation === "--delete" ? 2 : 3;
	if (!["--add", "--rename", "--delete", "--update"].includes(operation) || tokens.length !== expected) {
		throw new Error(usage);
	}
	projectName(name);
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Project configuration is being modified; try again later.");
		throw error;
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const projects = readProjects(path);
		const exists = Object.hasOwn(projects, name);
		if (operation === "--add" && exists) throw new Error(`Project already exists: ${name}; use --update.`);
		if (operation !== "--add" && !exists) throw new Error(`Project not found: ${name}`);
		switch (operation) {
			case "--add":
			case "--update":
				projects[name] = projectDirectory(value, cwd);
				break;
			case "--rename":
				projectName(value);
				if (Object.hasOwn(projects, value)) throw new Error(`Project already exists: ${value}`);
				projects[value] = projects[name];
				delete projects[name];
				break;
			case "--delete":
				delete projects[name];
				break;
		}
		writeFileSync(temporary, `${JSON.stringify(projects, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
		closeSync(lock);
		rmSync(lockPath, { force: true });
	}
}

function projectName(name: string): void {
	if (!name || name.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(name)) {
		throw new Error("Project name must not be empty, contain whitespace or control characters, or start with -.");
	}
}

function projectDirectory(address: string, cwd: string): string {
	if (!address || /[\x00-\x1f\x7f]/.test(address)) throw new Error("Project path must not be empty or contain control characters.");
	const expanded = address === "~" ? homedir() : address.startsWith("~/") ? join(homedir(), address.slice(2)) : address;
	const path = resolve(cwd, expanded);
	if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
	return path;
}

function parseArguments(args: string): string[] {
	const tokens: string[] = [];
	let remaining = args.trim();
	while (remaining) {
		const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+|$)/.exec(remaining);
		if (!match) throw new Error("Invalid argument format; quote paths containing spaces.");
		tokens.push(match[1] ?? match[2] ?? match[3]);
		remaining = remaining.slice(match[0].length);
	}
	return tokens;
}

async function switchProject(path: string, editor: CustomEditor, ctx: ExtensionCommandContext): Promise<void> {
	const result = await ctx.newSession();
	if (result.cancelled) return;
	if (resolve(ctx.sessionManager.getCwd()) === path) return;
	// onSubmit is typed void, but the TUI installs an async native command dispatcher.
	await editor.onSubmit!(`/move ${path}`);
	if (resolve(ctx.sessionManager.getCwd()) !== path) throw new Error(`New session started, but switching failed: ${path}`);
}
