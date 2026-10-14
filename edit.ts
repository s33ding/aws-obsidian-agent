import { App, TFile } from "obsidian";

export type NoteEdit =
	| { op: "replace_all"; content: string }
	| { op: "replace"; find: string; with: string }
	| { op: "append"; content: string }
	| { op: "prepend"; content: string };

export interface ParsedReply {
	/** The spoken/displayed text with any <edit> blocks removed. */
	spokenText: string;
	/** Parsed edits found in the reply, in order. */
	edits: NoteEdit[];
}

const EDIT_RE = /<edit>([\s\S]*?)<\/edit>/gi;

/**
 * Extract <edit>...</edit> blocks from a model reply, returning the cleaned
 * text (safe to speak/display) and the structured edits. Malformed blocks are
 * ignored (left out of edits) so a bad block never crashes the flow.
 */
export function parseReply(reply: string): ParsedReply {
	const edits: NoteEdit[] = [];
	let m: RegExpExecArray | null;
	EDIT_RE.lastIndex = 0;
	while ((m = EDIT_RE.exec(reply)) !== null) {
		const edit = tryParseEdit(m[1]);
		if (edit) edits.push(edit);
	}
	const spokenText = reply.replace(EDIT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
	return { spokenText, edits };
}

function tryParseEdit(raw: string): NoteEdit | null {
	let obj: unknown;
	try {
		obj = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const o = obj as Record<string, unknown>;
	switch (o.op) {
		case "replace_all":
			return typeof o.content === "string" ? { op: "replace_all", content: o.content } : null;
		case "append":
			return typeof o.content === "string" ? { op: "append", content: o.content } : null;
		case "prepend":
			return typeof o.content === "string" ? { op: "prepend", content: o.content } : null;
		case "replace":
			return typeof o.find === "string" && typeof o.with === "string"
				? { op: "replace", find: o.find, with: o.with }
				: null;
		default:
			return null;
	}
}

/** Compute the resulting content of applying an edit, or null if not applicable. */
export function applyEditToContent(current: string, edit: NoteEdit): string | null {
	switch (edit.op) {
		case "replace_all":
			return edit.content;
		case "append":
			return current.endsWith("\n") ? current + edit.content : current + "\n" + edit.content;
		case "prepend":
			return edit.content + (edit.content.endsWith("\n") ? "" : "\n") + current;
		case "replace": {
			if (!current.includes(edit.find)) return null; // nothing to replace
			return current.replace(edit.find, edit.with);
		}
	}
}

/** A short human-readable summary of an edit for the confirmation UI. */
export function describeEdit(edit: NoteEdit): string {
	switch (edit.op) {
		case "replace_all":
			return `Replace entire note (${edit.content.length} chars)`;
		case "append":
			return `Append ${edit.content.length} chars to the end`;
		case "prepend":
			return `Prepend ${edit.content.length} chars to the start`;
		case "replace":
			return `Replace "${truncate(edit.find)}" → "${truncate(edit.with)}"`;
	}
}

function truncate(s: string, n = 40): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

/**
 * Apply an edit to a file via the Obsidian vault API. Returns true on success.
 * Returns false if the edit couldn't be applied (e.g. find text not present).
 */
export async function applyEditToFile(app: App, file: TFile, edit: NoteEdit): Promise<boolean> {
	const current = await app.vault.read(file);
	const next = applyEditToContent(current, edit);
	if (next === null) return false;
	await app.vault.modify(file, next);
	return true;
}
