import { App, MarkdownView, TFile } from "obsidian";
import { NoteEdit, applyEditToFile } from "./edit";

/**
 * Actions the agent can take beyond editing note content: switching the view
 * mode and improving the vault's link graph. These are expressed as structured
 * tool calls and executed against the Obsidian API.
 */
export type AgentAction =
	| { kind: "edit"; edit: NoteEdit }
	| { kind: "set_view_mode"; mode: "source" | "preview" }
	| { kind: "add_link"; target: string; alias?: string };

export interface ActionResult {
	ok: boolean;
	message: string;
}

/** Switch the active markdown tab between edit (source) and read (preview). */
export async function setViewMode(
	app: App,
	mode: "source" | "preview"
): Promise<ActionResult> {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return { ok: false, message: "No active markdown view." };
	const leaf = view.leaf;
	const state = leaf.getViewState();
	state.state = { ...state.state, mode };
	await leaf.setViewState(state);
	return { ok: true, message: mode === "preview" ? "Switched to reading view." : "Switched to editing view." };
}

/**
 * Improve the graph by linking the active note to another note. Inserts a
 * `[[target]]` wikilink (optionally with an alias) at the end of the note,
 * which creates/strengthens an edge in Obsidian's graph.
 */
export async function addLink(
	app: App,
	file: TFile,
	target: string,
	alias?: string
): Promise<ActionResult> {
	const link = alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
	const edit: NoteEdit = { op: "append", content: link };
	const ok = await applyEditToFile(app, file, edit);
	return {
		ok,
		message: ok ? `Linked to [[${target}]].` : "Could not add the link.",
	};
}

/** Summary of the vault's link graph for analysis / suggestions. */
export interface GraphReport {
	totalNotes: number;
	orphans: string[]; // notes with no incoming or outgoing resolved links
	topConnected: { path: string; links: number }[];
}

/**
 * Analyze the vault link graph via metadataCache. Returns orphan notes and the
 * most connected notes so the agent can suggest connections to improve it.
 */
export function analyzeGraph(app: App): GraphReport {
	const resolved = app.metadataCache.resolvedLinks ?? {};
	const files = app.vault.getMarkdownFiles();
	const paths = files.map((f) => f.path);

	// Count outgoing + incoming resolved links per note.
	const outgoing: Record<string, number> = {};
	const incoming: Record<string, number> = {};
	for (const src of Object.keys(resolved)) {
		const targets = resolved[src] ?? {};
		outgoing[src] = Object.keys(targets).length;
		for (const dst of Object.keys(targets)) {
			incoming[dst] = (incoming[dst] ?? 0) + 1;
		}
	}

	const orphans = paths.filter(
		(p) => !(outgoing[p] > 0) && !(incoming[p] > 0)
	);

	const topConnected = paths
		.map((p) => ({ path: p, links: (outgoing[p] ?? 0) + (incoming[p] ?? 0) }))
		.sort((a, b) => b.links - a.links)
		.slice(0, 10);

	return { totalNotes: paths.length, orphans, topConnected };
}
