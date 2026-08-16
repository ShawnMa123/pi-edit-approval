/**
 * pi-edit-approval — confirm before mutating files in Pi.
 *
 * Copyright (C) 2026 ShawnMa123
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. Distribution uses GPL-3.0-only
 * as declared in package.json unless you change it.
 *
 * Config (optional): ~/.pi/agent/edit-approval.json
 * See edit-approval.example.json in the package root.
 *
 * - read / grep / find / ls: always allowed
 * - write / edit (and known mutators): gated by workspace vs outside policy
 * - workspace = git work tree root when available, else session cwd
 *
 * Policies: "allow" | "ask" | "deny"
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Policy = "allow" | "ask" | "deny";

interface EditApprovalConfig {
	workspaceWrites: Policy;
	outsideWrites: Policy;
	allowSessionBypassInWorkspace: boolean;
	allowSessionBypassOutside: boolean;
	gateBash: boolean;
	extraMutatingTools: string[];
}

const DEFAULT_CONFIG: EditApprovalConfig = {
	workspaceWrites: "ask",
	outsideWrites: "ask",
	allowSessionBypassInWorkspace: true,
	allowSessionBypassOutside: false,
	gateBash: false,
	extraMutatingTools: [],
};

const BUILTIN_MUTATORS = new Set(["write", "edit"]);
const MUTATOR_NAME_RE =
	/(^|_)(write|edit|replace|create_file|delete_file|apply_patch|str_replace)(_|$)/i;

function agentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
}

function normPath(p: string): string {
	// Windows paths are case-insensitive; compare in a stable form.
	return resolve(p).replace(/\\/g, "/").toLowerCase();
}

function loadConfig(): EditApprovalConfig {
	const path = join(agentDir(), "edit-approval.json");
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EditApprovalConfig>;
		return {
			...DEFAULT_CONFIG,
			...raw,
			extraMutatingTools: Array.isArray(raw.extraMutatingTools) ? raw.extraMutatingTools : [],
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function findGitRoot(cwd: string): string | undefined {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
			windowsHide: true,
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

function resolvePath(cwd: string, p: string): string {
	const expanded = p.startsWith("~/")
		? join(process.env.HOME || process.env.USERPROFILE || "", p.slice(2))
		: p;
	return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function isInsideDir(root: string, target: string): boolean {
	const r = normPath(root).replace(/\/+$/, "");
	const t = normPath(target);
	return t === r || t.startsWith(`${r}/`);
}

function extractPaths(input: Record<string, unknown>): string[] {
	const keys = [
		"path",
		"file_path",
		"filePath",
		"filepath",
		"target",
		"target_path",
		"filename",
	];
	const out: string[] = [];
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string" && v.trim()) out.push(v);
	}
	if (Array.isArray(input.paths)) {
		for (const v of input.paths) {
			if (typeof v === "string" && v.trim()) out.push(v);
		}
	}
	return out;
}

function looksLikeMutator(toolName: string, extra: string[]): boolean {
	const lower = toolName.toLowerCase();
	if (BUILTIN_MUTATORS.has(lower)) return true;
	if (extra.some((n) => n.toLowerCase() === lower)) return true;
	// MCP / adapter names: replace, fastctx_replace, mcp_fastctx_replace, etc.
	if (MUTATOR_NAME_RE.test(lower)) return true;
	return false;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "edit") {
		const oldText = typeof input.oldText === "string" ? input.oldText : "";
		const newText = typeof input.newText === "string" ? input.newText : "";
		const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
		return `old → new:\n  - ${clip(oldText).replace(/\n/g, "\\n")}\n  + ${clip(newText).replace(/\n/g, "\\n")}`;
	}
	if (toolName === "write") {
		const content = typeof input.content === "string" ? input.content : "";
		const lines = content.split("\n").length;
		return `write ${content.length} chars (${lines} lines)`;
	}
	try {
		const s = JSON.stringify(input);
		return s.length > 240 ? `${s.slice(0, 240)}…` : s;
	} catch {
		return "(unprintable input)";
	}
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let workspaceRoot: string | undefined;
	let sessionAllowInWorkspace = false;
	let sessionAllowOutside = false;
	const allowedExact = new Set<string>();

	pi.on("session_start", async (event) => {
		const cwd = event.cwd || process.cwd();
		workspaceRoot = findGitRoot(cwd) || cwd;
		sessionAllowInWorkspace = false;
		sessionAllowOutside = false;
		allowedExact.clear();
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const toolName = event.toolName;
		const input = event.input as Record<string, unknown>;

		// Reads and other non-mutators: allow
		if (
			toolName === "read" ||
			toolName === "grep" ||
			toolName === "find" ||
			toolName === "ls"
		) {
			return undefined;
		}

		// Optional bash gate (off by default — noisy). Shell can still bypass write/edit.
		if (toolName === "bash") {
			if (!config.gateBash) return undefined;
			const command = typeof input.command === "string" ? input.command : "";
			if (!ctx.hasUI) {
				return { block: true, reason: "bash blocked (edit-approval gateBash, no UI)" };
			}
			const ok = await ctx.ui.confirm("Allow bash?", command);
			return ok ? undefined : { block: true, reason: "Blocked by user (bash)" };
		}

		if (!looksLikeMutator(toolName, config.extraMutatingTools)) {
			return undefined;
		}

		const cwd = ctx.cwd || process.cwd();
		const root = workspaceRoot || findGitRoot(cwd) || cwd;
		const paths = extractPaths(input);
		// Mutator with no path still confirm once (unknown shape)
		const targets = paths.length > 0 ? paths.map((p) => resolvePath(cwd, p)) : [""];

		for (const abs of targets) {
			const outside = abs ? !isInsideDir(root, abs) : true;
			const policy = outside ? config.outsideWrites : config.workspaceWrites;
			const display = abs || "(no path in tool args)";
			const where = outside ? "OUTSIDE workspace" : "inside workspace";

			if (abs && allowedExact.has(abs)) continue;
			if (!outside && sessionAllowInWorkspace) continue;
			if (outside && sessionAllowOutside) continue;

			if (policy === "allow") continue;

			if (policy === "deny") {
				if (ctx.hasUI) ctx.ui.notify(`Denied ${toolName}: ${display}`, "warning");
				return {
					block: true,
					reason: `edit-approval: ${toolName} denied (${where}): ${display}`,
				};
			}

			// ask
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `edit-approval: ${toolName} needs confirmation (${where}): ${display}`,
				};
			}

			const detail = [
				`${toolName}  [${where}]`,
				`path: ${display}`,
				`workspace: ${root}`,
				"",
				summarizeInput(toolName, input),
			].join("\n");

			const choices: string[] = ["Yes", "No"];
			if (!outside && config.allowSessionBypassInWorkspace) {
				choices.splice(1, 0, "Yes, all workspace writes this session");
			}
			if (outside && config.allowSessionBypassOutside) {
				choices.splice(1, 0, "Yes, all outside writes this session");
			}
			if (abs) {
				choices.splice(1, 0, "Yes, this file this session");
			}

			const choice = await ctx.ui.select(`Allow file modification?\n\n${detail}`, choices);
			if (!choice || choice === "No") {
				return { block: true, reason: `Blocked by user: ${toolName} ${display}` };
			}
			if (choice === "Yes, all workspace writes this session") {
				sessionAllowInWorkspace = true;
			} else if (choice === "Yes, all outside writes this session") {
				sessionAllowOutside = true;
			} else if (choice === "Yes, this file this session" && abs) {
				allowedExact.add(abs);
			}
			// "Yes" → once
		}

		return undefined;
	});

	pi.registerCommand("edit-approval", {
		description: "Show edit-approval status / reset session bypasses",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().toLowerCase();
			if (sub === "reset") {
				sessionAllowInWorkspace = false;
				sessionAllowOutside = false;
				allowedExact.clear();
				ctx.ui.notify("edit-approval: session bypasses cleared", "info");
				return;
			}
			if (sub === "reload") {
				Object.assign(config, loadConfig());
				ctx.ui.notify("edit-approval: config reloaded", "info");
				return;
			}
			const lines = [
				`workspace: ${workspaceRoot || ctx.cwd}`,
				`workspaceWrites: ${config.workspaceWrites}`,
				`outsideWrites: ${config.outsideWrites}`,
				`sessionAllowInWorkspace: ${sessionAllowInWorkspace}`,
				`sessionAllowOutside: ${sessionAllowOutside}`,
				`allowedFiles: ${allowedExact.size}`,
				`gateBash: ${config.gateBash}`,
				"",
				"commands: /edit-approval | /edit-approval reset | /edit-approval reload",
				`config: ${join(agentDir(), "edit-approval.json")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
