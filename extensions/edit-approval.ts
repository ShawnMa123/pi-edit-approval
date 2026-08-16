/**
 * pi-edit-approval — confirm before mutating files in Pi.
 *
 * Copyright (C) 2026 ShawnMa123
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License (GPL-3.0-only
 * as declared in package.json).
 *
 * Config (optional): ~/.pi/agent/edit-approval.json
 * Persistent decisions: ~/.pi/agent/edit-approval-memory.json
 * See edit-approval.example.json in the package root.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Policy = "allow" | "ask" | "deny";
type ProfileName = "strict" | "workspace" | "review" | "off";

interface EditApprovalConfig {
	/** Named preset; explicit policy fields below override the preset. */
	profile: ProfileName;
	workspaceWrites: Policy;
	outsideWrites: Policy;
	allowSessionBypassInWorkspace: boolean;
	allowSessionBypassOutside: boolean;
	/** Offer "always allow/deny this file" (writes edit-approval-memory.json). */
	persistentMemory: boolean;
	/** Max lines of diff/preview in the approval prompt. */
	diffMaxLines: number;
	/** Path substrings / globs that are always denied (checked before allow memory). */
	protectedPaths: string[];
	gateBash: boolean;
	extraMutatingTools: string[];
}

interface MemoryFile {
	allowPaths: string[];
	allowPrefixes: string[];
	denyPaths: string[];
	denyPrefixes: string[];
}

const PROFILES: Record<
	ProfileName,
	Pick<
		EditApprovalConfig,
		| "workspaceWrites"
		| "outsideWrites"
		| "allowSessionBypassInWorkspace"
		| "allowSessionBypassOutside"
		| "diffMaxLines"
	>
> = {
	// Ask on every write (in and out of repo).
	strict: {
		workspaceWrites: "ask",
		outsideWrites: "ask",
		allowSessionBypassInWorkspace: true,
		allowSessionBypassOutside: false,
		diffMaxLines: 40,
	},
	// Codex-like workspace-write: free inside repo, ask outside.
	workspace: {
		workspaceWrites: "allow",
		outsideWrites: "ask",
		allowSessionBypassInWorkspace: true,
		allowSessionBypassOutside: false,
		diffMaxLines: 40,
	},
	// Like strict, but larger diff preview in the prompt.
	review: {
		workspaceWrites: "ask",
		outsideWrites: "ask",
		allowSessionBypassInWorkspace: true,
		allowSessionBypassOutside: false,
		diffMaxLines: 80,
	},
	// Disable write gating (reads were always free).
	off: {
		workspaceWrites: "allow",
		outsideWrites: "allow",
		allowSessionBypassInWorkspace: true,
		allowSessionBypassOutside: true,
		diffMaxLines: 40,
	},
};

const DEFAULT_CONFIG: EditApprovalConfig = {
	profile: "strict",
	...PROFILES.strict,
	persistentMemory: true,
	protectedPaths: [".env", ".env.", "id_rsa", "id_ed25519", ".npmrc", "credentials"],
	gateBash: false,
	extraMutatingTools: [],
};

const EMPTY_MEMORY: MemoryFile = {
	allowPaths: [],
	allowPrefixes: [],
	denyPaths: [],
	denyPrefixes: [],
};

const BUILTIN_MUTATORS = new Set(["write", "edit"]);
const MUTATOR_NAME_RE =
	/(^|_)(write|edit|replace|create_file|delete_file|apply_patch|str_replace)(_|$)/i;

const PROFILE_NAMES: ProfileName[] = ["strict", "workspace", "review", "off"];

function agentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
}

function configPath(): string {
	return join(agentDir(), "edit-approval.json");
}

function memoryPath(): string {
	return join(agentDir(), "edit-approval-memory.json");
}

function normPath(p: string): string {
	return resolve(p).replace(/\\/g, "/").toLowerCase();
}

function isProfileName(s: string): s is ProfileName {
	return (PROFILE_NAMES as string[]).includes(s);
}

function resolveConfig(raw: Partial<EditApprovalConfig> & Record<string, unknown>): EditApprovalConfig {
	const profile = isProfileName(String(raw.profile || DEFAULT_CONFIG.profile))
		? (String(raw.profile || DEFAULT_CONFIG.profile) as ProfileName)
		: DEFAULT_CONFIG.profile;
	const base = { ...DEFAULT_CONFIG, ...PROFILES[profile], profile };

	const out: EditApprovalConfig = {
		...base,
		workspaceWrites: isPolicy(raw.workspaceWrites) ? raw.workspaceWrites : base.workspaceWrites,
		outsideWrites: isPolicy(raw.outsideWrites) ? raw.outsideWrites : base.outsideWrites,
		allowSessionBypassInWorkspace:
			typeof raw.allowSessionBypassInWorkspace === "boolean"
				? raw.allowSessionBypassInWorkspace
				: base.allowSessionBypassInWorkspace,
		allowSessionBypassOutside:
			typeof raw.allowSessionBypassOutside === "boolean"
				? raw.allowSessionBypassOutside
				: base.allowSessionBypassOutside,
		persistentMemory:
			typeof raw.persistentMemory === "boolean" ? raw.persistentMemory : base.persistentMemory,
		diffMaxLines:
			typeof raw.diffMaxLines === "number" && raw.diffMaxLines > 0
				? Math.floor(raw.diffMaxLines)
				: base.diffMaxLines,
		protectedPaths: Array.isArray(raw.protectedPaths)
			? raw.protectedPaths.filter((x): x is string => typeof x === "string")
			: base.protectedPaths,
		gateBash: typeof raw.gateBash === "boolean" ? raw.gateBash : base.gateBash,
		extraMutatingTools: Array.isArray(raw.extraMutatingTools)
			? raw.extraMutatingTools.filter((x): x is string => typeof x === "string")
			: base.extraMutatingTools,
	};
	return out;
}

function isPolicy(v: unknown): v is Policy {
	return v === "allow" || v === "ask" || v === "deny";
}

function loadConfig(): EditApprovalConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EditApprovalConfig>;
		return resolveConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
	}
}

function saveConfigPatch(patch: Partial<EditApprovalConfig>): EditApprovalConfig {
	const dir = agentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	let existing: Record<string, unknown> = {};
	if (existsSync(configPath())) {
		try {
			existing = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
		} catch {
			existing = {};
		}
	}
	const merged = { ...existing, ...patch };
	writeFileSync(configPath(), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	return resolveConfig(merged);
}

function loadMemory(): MemoryFile {
	const path = memoryPath();
	if (!existsSync(path)) return { ...EMPTY_MEMORY, allowPaths: [], allowPrefixes: [], denyPaths: [], denyPrefixes: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryFile>;
		return {
			allowPaths: arr(raw.allowPaths).map(normPath),
			allowPrefixes: arr(raw.allowPrefixes).map((p) => normPrefix(p)),
			denyPaths: arr(raw.denyPaths).map(normPath),
			denyPrefixes: arr(raw.denyPrefixes).map((p) => normPrefix(p)),
		};
	} catch {
		return { ...EMPTY_MEMORY, allowPaths: [], allowPrefixes: [], denyPaths: [], denyPrefixes: [] };
	}
}

function arr(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

function normPrefix(p: string): string {
	const n = normPath(p).replace(/\/+$/, "");
	return `${n}/`;
}

function saveMemory(mem: MemoryFile): void {
	const dir = agentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const body: MemoryFile = {
		allowPaths: unique(mem.allowPaths.map(normPath)),
		allowPrefixes: unique(mem.allowPrefixes.map(normPrefix)),
		denyPaths: unique(mem.denyPaths.map(normPath)),
		denyPrefixes: unique(mem.denyPrefixes.map(normPrefix)),
	};
	writeFileSync(memoryPath(), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function unique(xs: string[]): string[] {
	return [...new Set(xs)].sort();
}

function memoryAllows(mem: MemoryFile, abs: string): boolean {
	const n = normPath(abs);
	if (mem.allowPaths.includes(n)) return true;
	return mem.allowPrefixes.some((pre) => n.startsWith(pre) || n + "/" === pre);
}

function memoryDenies(mem: MemoryFile, abs: string): boolean {
	const n = normPath(abs);
	if (mem.denyPaths.includes(n)) return true;
	return mem.denyPrefixes.some((pre) => n.startsWith(pre) || n + "/" === pre);
}

function isProtected(abs: string, patterns: string[]): boolean {
	if (!abs || patterns.length === 0) return false;
	const n = normPath(abs);
	const base = n.split("/").pop() || n;
	for (const pat of patterns) {
		const p = pat.replace(/\\/g, "/").toLowerCase();
		if (!p) continue;
		// substring match on full path or basename (covers .env, id_rsa, credentials)
		if (n.includes(p) || base.includes(p)) return true;
		// simple *.ext on basename
		if (p.startsWith("*.") && base.endsWith(p.slice(1))) return true;
	}
	return false;
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
	if (MUTATOR_NAME_RE.test(lower)) return true;
	return false;
}

function pickEditStrings(input: Record<string, unknown>): { oldText: string; newText: string } {
	const oldText =
		(typeof input.oldText === "string" && input.oldText) ||
		(typeof input.old_string === "string" && input.old_string) ||
		(typeof input.oldString === "string" && input.oldString) ||
		"";
	const newText =
		(typeof input.newText === "string" && input.newText) ||
		(typeof input.new_string === "string" && input.new_string) ||
		(typeof input.newString === "string" && input.newString) ||
		"";
	return { oldText, newText };
}

/** Build a compact unified-ish diff preview for approval UI. */
function formatDiffPreview(oldText: string, newText: string, maxLines: number): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const lines: string[] = [
		`@@ -${oldLines.length} lines +${newLines.length} lines @@`,
	];

	// Prefer a simple LCS-free hunk view: show removed then added, capped.
	const budget = Math.max(6, maxLines);
	const half = Math.floor((budget - 1) / 2);
	const showOld = oldLines.slice(0, half);
	const showNew = newLines.slice(0, half);
	for (const l of showOld) lines.push(`- ${truncateLine(l)}`);
	if (oldLines.length > showOld.length) {
		lines.push(`- … (${oldLines.length - showOld.length} more old lines)`);
	}
	for (const l of showNew) lines.push(`+ ${truncateLine(l)}`);
	if (newLines.length > showNew.length) {
		lines.push(`+ … (${newLines.length - showNew.length} more new lines)`);
	}
	const stats = `Δ lines: -${oldLines.length} +${newLines.length} · chars: -${oldText.length} +${newText.length}`;
	lines.push(stats);
	return lines.join("\n");
}

function truncateLine(s: string, n = 160): string {
	const t = s.replace(/\t/g, "  ");
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

function formatWritePreview(content: string, maxLines: number): string {
	const lines = content.split("\n");
	const head = lines.slice(0, Math.max(4, maxLines));
	const body = head.map((l) => `+ ${truncateLine(l)}`).join("\n");
	const more =
		lines.length > head.length ? `\n+ … (${lines.length - head.length} more lines)` : "";
	return `write ${content.length} chars (${lines.length} lines)\n${body}${more}`;
}

function summarizeInput(toolName: string, input: Record<string, unknown>, maxLines: number): string {
	const lower = toolName.toLowerCase();
	const { oldText, newText } = pickEditStrings(input);
	if (lower === "edit" || (oldText && newText) || lower.includes("replace") || lower.includes("str_replace")) {
		if (oldText || newText) return formatDiffPreview(oldText, newText, maxLines);
	}
	if (lower === "write" || lower.includes("write") || lower.includes("create_file")) {
		const content = typeof input.content === "string" ? input.content : "";
		if (content) return formatWritePreview(content, Math.min(20, maxLines));
	}
	try {
		const s = JSON.stringify(input);
		return s.length > 400 ? `${s.slice(0, 400)}…` : s;
	} catch {
		return "(unprintable input)";
	}
}

function applyConfigInPlace(target: EditApprovalConfig, next: EditApprovalConfig): void {
	Object.assign(target, next);
	target.protectedPaths = [...next.protectedPaths];
	target.extraMutatingTools = [...next.extraMutatingTools];
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	let memory = loadMemory();
	let workspaceRoot: string | undefined;
	let sessionAllowInWorkspace = false;
	let sessionAllowOutside = false;
	const sessionAllowExact = new Set<string>();
	const sessionDenyExact = new Set<string>();

	pi.on("session_start", async (event) => {
		const cwd = event.cwd || process.cwd();
		workspaceRoot = findGitRoot(cwd) || cwd;
		sessionAllowInWorkspace = false;
		sessionAllowOutside = false;
		sessionAllowExact.clear();
		sessionDenyExact.clear();
		// Pick up config/memory edits between sessions.
		applyConfigInPlace(config, loadConfig());
		memory = loadMemory();
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const toolName = event.toolName;
		const input = event.input as Record<string, unknown>;

		if (
			toolName === "read" ||
			toolName === "grep" ||
			toolName === "find" ||
			toolName === "ls"
		) {
			return undefined;
		}

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
		const targets = paths.length > 0 ? paths.map((p) => resolvePath(cwd, p)) : [""];

		for (const abs of targets) {
			const outside = abs ? !isInsideDir(root, abs) : true;
			const policy = outside ? config.outsideWrites : config.workspaceWrites;
			const display = abs || "(no path in tool args)";
			const where = outside ? "OUTSIDE workspace" : "inside workspace";

			if (abs && sessionDenyExact.has(normPath(abs))) {
				return {
					block: true,
					reason: `edit-approval: denied this session: ${display}`,
				};
			}

			if (abs && isProtected(abs, config.protectedPaths)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Protected path blocked: ${display}`, "warning");
				}
				return {
					block: true,
					reason: `edit-approval: protected path: ${display}`,
				};
			}

			if (abs && memoryDenies(memory, abs)) {
				return {
					block: true,
					reason: `edit-approval: denied by memory: ${display}`,
				};
			}

			if (abs && memoryAllows(memory, abs)) continue;
			if (abs && sessionAllowExact.has(normPath(abs))) continue;
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
				`${toolName}  [${where}]  profile=${config.profile}`,
				`path: ${display}`,
				`workspace: ${root}`,
				"",
				summarizeInput(toolName, input, config.diffMaxLines),
			].join("\n");

			const choices: string[] = ["Yes"];
			if (abs) choices.push("Yes, this file this session");
			if (!outside && config.allowSessionBypassInWorkspace) {
				choices.push("Yes, all workspace writes this session");
			}
			if (outside && config.allowSessionBypassOutside) {
				choices.push("Yes, all outside writes this session");
			}
			if (abs && config.persistentMemory) {
				choices.push("Yes, always allow this file");
				choices.push("Yes, always allow this directory");
			}
			choices.push("No");
			if (abs) choices.push("No, this file this session");
			if (abs && config.persistentMemory) {
				choices.push("No, always deny this file");
			}

			const choice = await ctx.ui.select(`Allow file modification?\n\n${detail}`, choices);
			if (!choice || choice === "No") {
				return { block: true, reason: `Blocked by user: ${toolName} ${display}` };
			}
			if (choice === "No, this file this session" && abs) {
				sessionDenyExact.add(normPath(abs));
				return { block: true, reason: `Blocked by user (session): ${toolName} ${display}` };
			}
			if (choice === "No, always deny this file" && abs) {
				memory.denyPaths.push(normPath(abs));
				// remove conflicting allows
				memory.allowPaths = memory.allowPaths.filter((p) => p !== normPath(abs));
				saveMemory(memory);
				return { block: true, reason: `Blocked permanently: ${toolName} ${display}` };
			}
			if (choice === "Yes, all workspace writes this session") {
				sessionAllowInWorkspace = true;
			} else if (choice === "Yes, all outside writes this session") {
				sessionAllowOutside = true;
			} else if (choice === "Yes, this file this session" && abs) {
				sessionAllowExact.add(normPath(abs));
			} else if (choice === "Yes, always allow this file" && abs) {
				memory.allowPaths.push(normPath(abs));
				memory.denyPaths = memory.denyPaths.filter((p) => p !== normPath(abs));
				saveMemory(memory);
			} else if (choice === "Yes, always allow this directory" && abs) {
				const pre = normPrefix(dirname(abs));
				memory.allowPrefixes.push(pre);
				saveMemory(memory);
			}
			// "Yes" → once
		}

		return undefined;
	});

	pi.registerCommand("edit-approval", {
		description:
			"edit-approval status | reset | reload | profile <name> | allow|deny|forget <path> | memory",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			const [cmd, ...rest] = raw.split(/\s+/);
			const sub = (cmd || "").toLowerCase();
			const restJoined = rest.join(" ").trim();

			if (sub === "reset") {
				sessionAllowInWorkspace = false;
				sessionAllowOutside = false;
				sessionAllowExact.clear();
				sessionDenyExact.clear();
				ctx.ui.notify("edit-approval: session bypasses cleared", "info");
				return;
			}

			if (sub === "reload") {
				applyConfigInPlace(config, loadConfig());
				memory = loadMemory();
				ctx.ui.notify(
					`edit-approval: reloaded (profile=${config.profile}, memory allow=${memory.allowPaths.length}+${memory.allowPrefixes.length})`,
					"info",
				);
				return;
			}

			if (sub === "profile") {
				const name = rest[0]?.toLowerCase() || "";
				if (!isProfileName(name)) {
					ctx.ui.notify(
						`usage: /edit-approval profile <${PROFILE_NAMES.join("|")}>\ncurrent: ${config.profile}`,
						"warning",
					);
					return;
				}
				// Persist profile and clear stale explicit policy overrides so the preset applies cleanly.
				const next = saveConfigPatch({
					profile: name,
					workspaceWrites: PROFILES[name].workspaceWrites,
					outsideWrites: PROFILES[name].outsideWrites,
					allowSessionBypassInWorkspace: PROFILES[name].allowSessionBypassInWorkspace,
					allowSessionBypassOutside: PROFILES[name].allowSessionBypassOutside,
					diffMaxLines: PROFILES[name].diffMaxLines,
				});
				applyConfigInPlace(config, next);
				ctx.ui.notify(
					`edit-approval: profile=${name} (workspace=${config.workspaceWrites}, outside=${config.outsideWrites})`,
					"info",
				);
				return;
			}

			if (sub === "allow" || sub === "deny" || sub === "forget") {
				if (!restJoined) {
					ctx.ui.notify(`usage: /edit-approval ${sub} <path>`, "warning");
					return;
				}
				const abs = resolvePath(ctx.cwd || process.cwd(), restJoined);
				const n = normPath(abs);
				if (sub === "allow") {
					memory.allowPaths.push(n);
					memory.denyPaths = memory.denyPaths.filter((p) => p !== n);
					saveMemory(memory);
					ctx.ui.notify(`edit-approval: always allow ${abs}`, "info");
				} else if (sub === "deny") {
					memory.denyPaths.push(n);
					memory.allowPaths = memory.allowPaths.filter((p) => p !== n);
					saveMemory(memory);
					ctx.ui.notify(`edit-approval: always deny ${abs}`, "info");
				} else {
					memory.allowPaths = memory.allowPaths.filter((p) => p !== n);
					memory.denyPaths = memory.denyPaths.filter((p) => p !== n);
					memory.allowPrefixes = memory.allowPrefixes.filter((p) => p !== normPrefix(abs) && p !== n + "/");
					memory.denyPrefixes = memory.denyPrefixes.filter((p) => p !== normPrefix(abs) && p !== n + "/");
					saveMemory(memory);
					ctx.ui.notify(`edit-approval: forgot ${abs}`, "info");
				}
				return;
			}

			if (sub === "memory") {
				const lines = [
					`memory file: ${memoryPath()}`,
					`allowPaths (${memory.allowPaths.length}):`,
					...memory.allowPaths.map((p) => `  + ${p}`),
					`allowPrefixes (${memory.allowPrefixes.length}):`,
					...memory.allowPrefixes.map((p) => `  + ${p}*`),
					`denyPaths (${memory.denyPaths.length}):`,
					...memory.denyPaths.map((p) => `  - ${p}`),
					`denyPrefixes (${memory.denyPrefixes.length}):`,
					...memory.denyPrefixes.map((p) => `  - ${p}*`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub && sub !== "status" && sub !== "help") {
				ctx.ui.notify(
					`unknown: ${sub}\ncommands: status | reset | reload | profile | allow | deny | forget | memory`,
					"warning",
				);
				return;
			}

			const lines = [
				`profile: ${config.profile}`,
				`workspace: ${workspaceRoot || ctx.cwd}`,
				`workspaceWrites: ${config.workspaceWrites}`,
				`outsideWrites: ${config.outsideWrites}`,
				`persistentMemory: ${config.persistentMemory}`,
				`diffMaxLines: ${config.diffMaxLines}`,
				`protectedPaths: ${config.protectedPaths.length}`,
				`sessionAllowInWorkspace: ${sessionAllowInWorkspace}`,
				`sessionAllowOutside: ${sessionAllowOutside}`,
				`sessionAllowFiles: ${sessionAllowExact.size}`,
				`sessionDenyFiles: ${sessionDenyExact.size}`,
				`memory: allow=${memory.allowPaths.length} pfx=${memory.allowPrefixes.length} deny=${memory.denyPaths.length}`,
				`gateBash: ${config.gateBash}`,
				"",
				"profiles: strict | workspace | review | off",
				"commands:",
				"  /edit-approval",
				"  /edit-approval reset | reload | memory",
				"  /edit-approval profile <name>",
				"  /edit-approval allow|deny|forget <path>",
				`config: ${configPath()}`,
				`memory: ${memoryPath()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
