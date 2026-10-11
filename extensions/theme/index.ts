import {
	getCurrentThemeName,
	getSelectListTheme,
	previewTheme,
	type Settings,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth } from "@oh-my-pi/pi-tui";
import { lookup, register } from "@oh-my-pi/pi-coding-agent/config/registry";

const hiddenThemes = lookup("themePicker.hiddenThemes") ?? register({
	id: "themePicker.hiddenThemes",
	type: "array",
	default: [],
	validate: validateHiddenThemes,
});

/**
 * /theme: Choose a theme at the input prompt while keeping chat visible.
 * Up/down previews; type to filter; Enter applies and saves; Esc / Ctrl+C restores.
 * Saves the selected theme to both theme.dark and theme.light; history stays unchanged.
 * Ctrl+X hides/restores the selected theme and saves immediately to themePicker.hiddenThemes.
 * Ctrl+Y temporarily shows/hides hidden themes; hidden themes stay hidden on each open.
 * Canceling does not undo hide actions.
 *
 * After installation, run /restart in an existing session, then enter /theme.
 * Interactive check: python3 ~/.omp/agent/extensions/theme/check.py
 */
export default function themePicker(pi: ExtensionAPI) {
	pi.registerCommand("theme", {
		description: "Choose, preview, and save themes; Ctrl+X hide/restore, Ctrl+Y show hidden",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/theme requires an interactive terminal.", "error");
				return;
			}

			const original = getCurrentThemeName();
			const themes = await ctx.ui.getAllThemes();
			if (!original || !themes.some(item => item.name === original)) {
				ctx.ui.notify("Cannot restore the current theme by name; preview not opened.", "error");
				return;
			}

			let applied = false;
			try {
				const selected = await selectTheme(ctx, themes, original, pi.pi.settings);
				if (selected === undefined) return;
				const darkTheme = lookup("theme.dark");
				const lightTheme = lookup("theme.light");
				if (!darkTheme || !lightTheme) throw new Error("Theme settings are not registered");
				const result = await ctx.ui.setTheme(selected);
				if (!result.success) throw new Error(result.error ?? "Failed to apply theme");
				applied = true;
				darkTheme.set(pi.pi.settings, selected);
				lightTheme.set(pi.pi.settings, selected);
				await pi.pi.settings.flush();
				ctx.ui.notify(`Theme: ${selected} (saved to both dark and light)`, "info");
			} catch (error) {
				ctx.ui.notify(applied ? `Theme applied, but saving failed: ${error}` : String(error), "error");
			} finally {
				if (!applied) {
					// Also supersedes previews still loading when the picker closes.
					const restored = getCurrentThemeName() === original
						? await previewTheme(original)
						: await ctx.ui.setTheme(original);
					if (!restored.success) ctx.ui.notify(`Failed to restore theme: ${restored.error}`, "error");
				}
			}
		},
	});
}

// ─── Local helpers ───────────────────────────────────────────

function selectTheme(
	ctx: ExtensionCommandContext,
	themes: { name: string; path: string | undefined }[],
	original: string,
	settings: Settings,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
		const saved = hiddenThemes.get(settings);
		validateHiddenThemes(saved);
		let hidden = new Set(saved);
		let showHidden = false;
		let savingHidden = false;
		const list = new SelectList([], 6, getSelectListTheme(), {
			search: "always",
			emptyText: "All themes are hidden; press Ctrl+Y to show hidden themes",
			noMatchText: "No matching themes",
		});

		let closed = false;
		let request = 0;
		let status = `Preview: ${original}`;
		let failed = false;

		async function preview(name: string): Promise<boolean> {
			const current = ++request;
			status = `Loading: ${name}`;
			failed = false;
			tui.requestRender();
			try {
				const result = await previewTheme(name);
				if (closed || current !== request) return false;
				failed = !result.success;
				status = result.success ? `Preview: ${name}` : `Preview failed: ${result.error}`;
				return result.success;
			} catch (error) {
				if (closed || current !== request) return false;
				failed = true;
				status = `Preview failed: ${error}`;
				return false;
			} finally {
				if (!closed) tui.requestRender();
			}
		}

		function refreshList() {
			list.setItems(themes
				.filter(item => showHidden || !hidden.has(item.name))
				.map(item => ({
					value: item.name,
					label: item.name,
					description: [
						item.name === original ? "Current" : "",
						hidden.has(item.name) ? "Hidden" : "",
					].filter(Boolean).join(" · ") || undefined,
				})));
			if (!list.getSelectedItem()) void preview(original);
			tui.requestRender();
		}

		async function toggleHidden() {
			const item = list.getSelectedItem();
			if (!item || savingHidden) return;
			const wasHidden = hidden.has(item.value);
			savingHidden = true;
			try {
				hiddenThemes.setMember(settings, item.value, { member: !wasHidden });
				await settings.flush();
				if (closed) return;
				if (wasHidden) hidden.delete(item.value);
				else hidden.add(item.value);
				refreshList();
			} catch (error) {
				hiddenThemes.setMember(settings, item.value, { member: wasHidden });
				if (closed) return;
				failed = true;
				status = `Failed to save hidden-theme settings: ${error}`;
			} finally {
				savingHidden = false;
				if (!closed) tui.requestRender();
			}
		}

		function close(value: string | undefined) {
			if (closed) return;
			closed = true;
			done(value);
		}

		refreshList();
		list.setSelectedValue(original);
		const initial = list.getSelectedItem();
		if (initial && initial.value !== original) void preview(initial.value);

		list.onSelectionChange = item => { void preview(item.value); };
		list.onSelect = item => {
			void preview(item.value).then(success => {
				if (success) close(item.value);
			});
		};
		list.onCancel = () => close(undefined);

		return {
			handleInput(data) {
				if (closed) return;
				if (matchesKey(data, "ctrl+c") || keybindings.matches(data, "app.interrupt")) {
					close(undefined);
					return;
				}
				if (savingHidden) return;
				if (matchesKey(data, "ctrl+x")) {
					void toggleHidden();
					return;
				}
				if (matchesKey(data, "ctrl+y")) {
					showHidden = !showHidden;
					refreshList();
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
			render(width) {
				const theme = ctx.ui.theme;
				return [
					theme.fg("accent", theme.bold("Theme · Live preview")),
					...list.render(width),
					theme.fg(failed ? "error" : "muted", savingHidden ? "Saving hidden-theme settings..." : status),
					theme.fg("muted", "↑↓ preview · Type to filter · Enter apply and save · Esc restore"),
					theme.fg("muted", `Ctrl+X hide/restore · Ctrl+Y show hidden: ${showHidden ? "on" : "off"}`),
				].map(line => truncateToWidth(line, width));
			},
			dispose() {
				closed = true;
			},
		};
	});
}

function validateHiddenThemes(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || !value.every(name => typeof name === "string")) {
		throw new Error("themePicker.hiddenThemes must be an array of theme names");
	}
}
