import { App, TFile } from "obsidian";

/**
 * Markdown-aware edit operations. Beyond raw text ops, these understand common
 * note structures (headings, list items, tasks) so the agent can edit markdown
 * precisely instead of just appending text.
 */
export type NoteEdit =
	| { op: "replace_all"; content: string }
	| { op: "replace"; find: string; with: string }
	| { op: "append"; content: string }
	| { op: "prepend"; content: string }
	// Insert text right under a heading (creates the heading if missing).
	| { op: "insert_under_heading"; heading: string; content: string }
	// Add a list item, optionally a task, optionally under a heading.
	| { op: "add_list_item"; text: string; heading?: string; task?: boolean }
	// Check/uncheck a task matching its text.
	| { op: "toggle_task"; text: string; checked: boolean };

export interface ParsedReply {
	spokenText: string;
	edits: NoteEdit[];
}

const EDIT_RE = /<edit>([\s\S]*?)<\/edit>/gi;

export function parseReply(reply: string): ParsedReply {
	const edits: NoteEdit[] = [];
	let m: RegExpExecArray | null;
	EDIT_RE.lastIndex = 0;
	while ((m = EDIT_RE.exec(reply)) !== null) {
		const edit = toNoteEdit(safeJson(m[1]));
		if (edit) edits.push(edit);
	}
	const spokenText = reply.replace(EDIT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
	return { spokenText, edits };
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw.trim());
	} catch {
		return null;
	}
}

/** Validate/normalize a raw tool input (or parsed JSON) into a NoteEdit. */
export function toNoteEdit(input: unknown): NoteEdit | null {
	if (!input || typeof input !== "object") return null;
	const o = input as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	switch (o.op) {
		case "replace_all":
			return str(o.content) !== undefined ? { op: "replace_all", content: o.content as string } : null;
		case "append":
			return str(o.content) !== undefined ? { op: "append", content: o.content as string } : null;
		case "prepend":
			return str(o.content) !== undefined ? { op: "prepend", content: o.content as string } : null;
		case "replace":
			return str(o.find) !== undefined && str(o.with) !== undefined
				? { op: "replace", find: o.find as string, with: o.with as string }
				: null;
		case "insert_under_heading":
			return str(o.heading) !== undefined && str(o.content) !== undefined
				? { op: "insert_under_heading", heading: o.heading as string, content: o.content as string }
				: null;
		case "add_list_item":
			return str(o.text) !== undefined
				? {
						op: "add_list_item",
						text: o.text as string,
						heading: str(o.heading),
						task: typeof o.task === "boolean" ? o.task : false,
				  }
				: null;
		case "toggle_task":
			return str(o.text) !== undefined
				? { op: "toggle_task", text: o.text as string, checked: o.checked !== false }
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
			return joinBlock(current, edit.content);
		case "prepend":
			return edit.content + (edit.content.endsWith("\n") ? "" : "\n") + current;
		case "replace":
			return current.includes(edit.find) ? current.replace(edit.find, edit.with) : null;
		case "insert_under_heading":
			return insertUnderHeading(current, edit.heading, edit.content);
		case "add_list_item":
			return addListItem(current, edit);
		case "toggle_task":
			return toggleTask(current, edit.text, edit.checked);
	}
}

function joinBlock(current: string, add: string): string {
	if (!current.trim()) return add;
	return current.endsWith("\n") ? current + add : current + "\n" + add;
}

/** Normalize a heading for comparison (strip leading #'s and whitespace). */
function headingText(line: string): string | null {
	const m = /^(#{1,6})\s+(.*)$/.exec(line);
	return m ? m[2].trim() : null;
}

/**
 * Insert `content` right after the given heading. If the heading isn't found,
 * append a new section (## heading) with the content at the end of the note.
 */
function insertUnderHeading(current: string, heading: string, content: string): string {
	const lines = current.split("\n");
	const target = heading.replace(/^#+\s*/, "").trim().toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const ht = headingText(lines[i]);
		if (ht && ht.toLowerCase() === target) {
			// Insert after the heading line (and any immediately following blank line).
			let insertAt = i + 1;
			if (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
			lines.splice(insertAt, 0, content);
			return lines.join("\n");
		}
	}
	// Heading not found: create a new section at the end.
	const section = `\n## ${heading.replace(/^#+\s*/, "").trim()}\n${content}`;
	return joinBlock(current, section);
}

/** Add a list item (optionally a task) at the end, or under a heading. */
function addListItem(current: string, edit: Extract<NoteEdit, { op: "add_list_item" }>): string {
	const bullet = edit.task ? `- [ ] ${edit.text}` : `- ${edit.text}`;
	if (edit.heading) {
		return insertUnderHeading(current, edit.heading, bullet);
	}
	return joinBlock(current, bullet);
}

/** Check or uncheck the first task whose text matches (case-insensitive contains). */
function toggleTask(current: string, text: string, checked: boolean): string | null {
	const needle = text.trim().toLowerCase();
	const lines = current.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*[-*]\s+\[)[ xX](\]\s+)(.*)$/.exec(lines[i]);
		if (m && m[3].trim().toLowerCase().includes(needle)) {
			lines[i] = `${m[1]}${checked ? "x" : " "}${m[2]}${m[3]}`;
			return lines.join("\n");
		}
	}
	return null; // no matching task
}

export function describeEdit(edit: NoteEdit): string {
	switch (edit.op) {
		case "replace_all":
			return `Rewrite note (${edit.content.length} chars)`;
		case "append":
			return `Append ${edit.content.length} chars`;
		case "prepend":
			return `Prepend ${edit.content.length} chars`;
		case "replace":
			return `Replace "${truncate(edit.find)}" → "${truncate(edit.with)}"`;
		case "insert_under_heading":
			return `Insert under "${truncate(edit.heading)}"`;
		case "add_list_item":
			return `Add ${edit.task ? "task" : "item"} "${truncate(edit.text)}"${
				edit.heading ? ` under "${truncate(edit.heading)}"` : ""
			}`;
		case "toggle_task":
			return `${edit.checked ? "Check" : "Uncheck"} task "${truncate(edit.text)}"`;
	}
}

function truncate(s: string, n = 40): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

/**
 * Apply an edit to a file via the Obsidian vault API. Returns true on success,
 * false if the edit couldn't be applied (e.g. target text/task not found).
 */
export async function applyEditToFile(app: App, file: TFile, edit: NoteEdit): Promise<boolean> {
	const current = await app.vault.read(file);
	const next = applyEditToContent(current, edit);
	if (next === null) return false;
	await app.vault.modify(file, next);
	return true;
}
