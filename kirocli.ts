import { execFile } from "child_process";

/**
 * Runs the Kiro CLI (`kiro-cli chat`) headlessly to perform web research —
 * searching for media (images/videos) or specific facts the agent needs. The
 * CLI has web-search tools; we run it non-interactively and capture its final
 * answer.
 *
 * This is desktop-only (uses Node's child_process, available in Obsidian's
 * Electron runtime).
 */
export class KiroResearch {
	constructor(private binary = "kiro-cli", private timeoutMs = 90000) {}

	/**
	 * Ask the Kiro CLI a research question and return its final text answer.
	 * The prompt should instruct the CLI to reply with ONLY the needed output
	 * (e.g. a bare URL) so parsing is trivial.
	 */
	run(prompt: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const args = [
				"chat",
				prompt,
				"--no-interactive",
				"--trust-all-tools",
			];
			execFile(
				this.binary,
				args,
				{ timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
				(err, stdout, stderr) => {
					if (err && !stdout) {
						reject(new Error(`kiro-cli failed: ${err.message}${stderr ? " — " + stderr : ""}`));
						return;
					}
					resolve(cleanOutput(stdout));
				}
			);
		});
	}
}

/**
 * Strip the CLI's progress/tool chatter (lines like "[tool] ...", "I'll
 * search...") and return the substantive final answer — typically the last
 * non-empty line, which is where the bare URL/answer lands.
 */
function cleanOutput(raw: string): string {
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		// Drop ANSI/control noise and known chatter prefixes.
		.filter((l) => l && !l.startsWith("[tool]") && !/^status:/i.test(l));
	if (lines.length === 0) return "";
	return lines[lines.length - 1];
}

/** Extract the first http(s) URL from a string, if any. */
export function firstUrl(text: string): string | null {
	const m = /https?:\/\/[^\s)"'<>]+/.exec(text);
	return m ? m[0] : null;
}
