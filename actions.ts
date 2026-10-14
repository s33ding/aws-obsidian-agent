import { App, MarkdownView, TFile } from "obsidian";
import { NoteEdit, applyEditToFile } from "./edit";
import { KiroResearch, firstUrl } from "./kirocli";

/**
 * Actions the agent can take beyond editing note content: switching the view
 * mode and improving the vault's link graph. These are expressed as structured
 * tool calls and executed against the Obsidian API.
 */
export type AgentAction =
	| { kind: "edit"; edit: NoteEdit }
	| { kind: "set_view_mode"; mode: "source" | "preview" }
	| { kind: "add_link"; target: string; alias?: string }
	| { kind: "create_note"; name: string; content?: string; open?: boolean }
	| { kind: "open_note"; name: string }
	| { kind: "rename_note"; name: string; newName: string }
	| { kind: "delete_note"; name: string }
	| { kind: "research_media"; query: string; mediaType: "image" | "video" | "fact" };

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

/** Normalize a note name into a vault path ending in .md. */
function toNotePath(name: string): string {
	let p = name.trim().replace(/^\/+/, "");
	// Strip wiki-link brackets if the model passed "[[Note]]".
	p = p.replace(/^\[\[|\]\]$/g, "");
	if (!p.toLowerCase().endsWith(".md")) p += ".md";
	return p;
}

/** Does the given name already specify a folder (contains a slash)? */
function hasExplicitFolder(name: string): boolean {
	return name.replace(/^\[\[|\]\]$/g, "").trim().includes("/");
}

/** The folder of the currently active note, or "" (vault root). */
function activeFolder(app: App): string {
	const file = app.workspace.getActiveFile();
	if (!file || !file.parent) return "";
	// parent.path is "" for the vault root.
	return file.parent.path === "/" ? "" : file.parent.path;
}

/**
 * Resolve where a new note should live. If the user gave an explicit folder
 * (a slash in the name), honor it. Otherwise place it alongside the note the
 * user is working on (same folder = same topic). Falls back to vault root.
 */
function resolveCreatePath(app: App, name: string): string {
	const rel = toNotePath(name);
	if (hasExplicitFolder(name)) return rel;
	const folder = activeFolder(app);
	return folder ? `${folder}/${rel}` : rel;
}

/** Find an existing markdown note by name or path (case-insensitive). */
function findNote(app: App, name: string): TFile | null {
	const path = toNotePath(name);
	const direct = app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile) return direct;
	const base = path.toLowerCase();
	const bare = base.replace(/\.md$/, "");
	return (
		app.vault.getMarkdownFiles().find((f) => {
			return (
				f.path.toLowerCase() === base ||
				f.basename.toLowerCase() === bare ||
				f.name.toLowerCase() === base
			);
		}) ?? null
	);
}

/**
 * Create a new note. If a note with that name already exists, it is opened
 * instead of overwritten (safe by default). Opens the note unless open=false.
 */
export async function createNote(
	app: App,
	name: string,
	content = "",
	open = true
): Promise<ActionResult> {
	// Reuse an existing note with that name rather than duplicating it.
	const existing = findNote(app, name);
	if (existing) {
		if (open) await app.workspace.getLeaf(false).openFile(existing);
		return { ok: true, message: `Note "${existing.basename}" already existed; opened it.` };
	}
	const path = resolveCreatePath(app, name);
	try {
		// Make sure the parent folder exists (create() won't create folders).
		const slash = path.lastIndexOf("/");
		if (slash > 0) {
			const dir = path.slice(0, slash);
			if (!app.vault.getAbstractFileByPath(dir)) {
				await app.vault.createFolder(dir).catch(() => undefined);
			}
		}
		const file = await app.vault.create(path, content);
		if (open) await app.workspace.getLeaf(false).openFile(file);
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "vault root";
		return { ok: true, message: `Created note "${file.basename}" in ${folder}.` };
	} catch (e) {
		return { ok: false, message: `Could not create note: ${(e as Error).message}` };
	}
}

/** Open (switch to) an existing note in the current tab. */
export async function openNote(app: App, name: string): Promise<ActionResult> {
	const file = findNote(app, name);
	if (!file) return { ok: false, message: `Note "${name}" not found.` };
	await app.workspace.getLeaf(false).openFile(file);
	return { ok: true, message: `Opened "${file.basename}".` };
}

/**
 * Rename a note. The new name keeps the note in its current folder unless the
 * new name includes an explicit folder path. Uses fileManager.renameFile so
 * Obsidian updates backlinks automatically.
 */
export async function renameNote(
	app: App,
	name: string,
	newName: string
): Promise<ActionResult> {
	const file = findNote(app, name);
	if (!file) return { ok: false, message: `Note "${name}" not found.` };
	const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
	const rel = toNotePath(newName);
	const dest = hasExplicitFolder(newName) || !folder ? rel : `${folder}/${rel}`;
	try {
		await app.fileManager.renameFile(file, dest);
		return { ok: true, message: `Renamed to "${dest.replace(/\.md$/, "")}".` };
	} catch (e) {
		return { ok: false, message: `Could not rename: ${(e as Error).message}` };
	}
}

/**
 * Delete a note (moves it to trash per the user's Obsidian settings, which is
 * recoverable). Returns false if the note isn't found.
 */
export async function deleteNote(app: App, name: string): Promise<ActionResult> {
	const file = findNote(app, name);
	if (!file) return { ok: false, message: `Note "${name}" not found.` };
	const label = file.basename;
	try {
		// trash() moves to the trash (recoverable). true = system trash,
		// false = vault's .trash folder; use false for portability.
		await app.vault.trash(file, false);
		return { ok: true, message: `Deleted "${label}" (moved to trash).` };
	} catch (e) {
		return { ok: false, message: `Could not delete: ${(e as Error).message}` };
	}
}

/**
 * Research the web via Kiro CLI and insert the result into the active note.
 * - image: embeds `![](url)`
 * - video: embeds the video URL (Obsidian renders YouTube/Vimeo as a player)
 * - fact:  inserts the researched text
 */
export async function researchAndInsert(
	app: App,
	file: TFile,
	query: string,
	mediaType: "image" | "video" | "fact"
): Promise<ActionResult> {
	const kiro = new KiroResearch();
	let prompt: string;
	if (mediaType === "image") {
		prompt = `Search the web for a freely-usable image matching: "${query}". Reply with ONLY the direct image URL (ending in .jpg, .jpeg, .png, .gif or .webp). No other text.`;
	} else if (mediaType === "video") {
		prompt = `Search the web for a YouTube video matching: "${query}". Reply with ONLY the full YouTube watch URL. No other text.`;
	} else {
		prompt = `Research this and answer concisely with current, factual information: "${query}". Reply with a short plain-text answer only.`;
	}

	let answer: string;
	try {
		answer = await kiro.run(prompt);
	} catch (e) {
		return { ok: false, message: `Research failed: ${(e as Error).message}` };
	}
	if (!answer) return { ok: false, message: "Research returned nothing." };

	let snippet: string;
	if (mediaType === "fact") {
		snippet = answer;
	} else {
		const url = firstUrl(answer);
		if (!url) return { ok: false, message: `No usable URL found for "${query}".` };
		// Obsidian embeds remote media with the standard image-embed syntax; for
		// videos the bare URL on its own line renders an embedded player.
		snippet = mediaType === "image" ? `![](${url})` : url;
	}

	const ok = await applyEditToFile(app, file, { op: "append", content: snippet });
	return {
		ok,
		message: ok
			? mediaType === "fact"
				? "Added the researched info."
				: `Embedded the ${mediaType} in the note.`
			: "Could not insert the result.",
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
