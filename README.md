# pi-edit-approval

[![npm version](https://img.shields.io/npm/v/pi-edit-approval.svg)](https://www.npmjs.com/package/pi-edit-approval)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**Pi** coding-agent extension that asks before the agent modifies files.

- **Reads stay free** — `read` / `grep` / `find` / `ls` are never prompted
- **Writes need approval** — built-in `write` / `edit`, plus common mutator tool names (e.g. MCP `replace`)
- **Profiles** — `strict` / `workspace` / `review` / `off` presets
- **Diff preview** — approval UI shows a compact unified-style diff for edits
- **Persistent memory** — always allow/deny a file or directory across sessions
- **Protected paths** — hard-deny for `.env`, keys, etc.
- **Workspace-aware** — separate policies inside vs outside the git root (or cwd)

Keywords: `pi-package`, `pi`, `pi-extension`, `pi-coding-agent`.

> Pi has no built-in “confirm before edit” switch. This package adds that gate via the extension `tool_call` hook.

## Install

Requires [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

You can install from **npm** or **GitHub**.

### From npm (recommended)

```bash
pi install npm:pi-edit-approval
```

Pin a version:

```bash
pi install npm:pi-edit-approval@0.2.0
```

### From GitHub

```bash
pi install git:github.com/ShawnMa123/pi-edit-approval
```

```bash
pi install https://github.com/ShawnMa123/pi-edit-approval
pi install git:github.com/ShawnMa123/pi-edit-approval@v0.2.0
```

### Try once without installing

```bash
pi -e npm:pi-edit-approval
pi -e git:github.com/ShawnMa123/pi-edit-approval
```

### Local path (development)

```bash
pi install /path/to/pi-edit-approval
pi -e ./extensions/edit-approval.ts
```

### Project-local install

```bash
pi install -l npm:pi-edit-approval
pi install -l git:github.com/ShawnMa123/pi-edit-approval
```

After install, start a **new** session or run **`/reload`**.

If you previously copied `edit-approval.ts` into `~/.pi/agent/extensions/`, remove that copy to avoid loading the extension twice.

## Profiles

| Profile | Inside workspace | Outside workspace | Notes |
|---------|------------------|-------------------|--------|
| **`strict`** (default) | ask | ask | Safest everyday default |
| **`workspace`** | **allow** | ask | Codex-style workspace-write |
| **`review`** | ask | ask | Larger diff preview (`diffMaxLines: 80`) |
| **`off`** | allow | allow | Disables write gating |

Switch live (persists to config):

```text
/edit-approval profile workspace
/edit-approval profile strict
```

## Default behavior

| Tool / path | Default (`strict`) |
|-------------|--------------------|
| `read`, `grep`, `find`, `ls` | Always allow |
| `write` / `edit` inside workspace | **Ask** (+ diff preview) |
| `write` / `edit` outside workspace | **Ask** (labeled `OUTSIDE workspace`) |
| Paths matching `protectedPaths` | **Deny** (no prompt) |
| Paths in persistent allow memory | Allow |
| Paths in persistent deny memory | Deny |
| `bash` | Not gated (see `gateBash`) |
| Non-interactive (`-p` / no UI) when policy is `ask` | **Block** |

**Workspace root** = `git rev-parse --show-toplevel` when available, otherwise the session cwd.

### Prompt choices

- **Yes** — this call only  
- **Yes, this file this session**  
- **Yes, all workspace writes this session** (if enabled)  
- **Yes, all outside writes this session** (if enabled)  
- **Yes, always allow this file** — persists to memory  
- **Yes, always allow this directory** — persists prefix allow  
- **No**  
- **No, this file this session**  
- **No, always deny this file** — persists to memory  

## Configuration

Optional file:

```text
~/.pi/agent/edit-approval.json
```

Copy the example from the package:

```bash
# from a clone / install tree
cp edit-approval.example.json ~/.pi/agent/edit-approval.json
```

```powershell
Copy-Item edit-approval.example.json $env:USERPROFILE\.pi\agent\edit-approval.json
```

### Example: strict (default)

```json
{
  "profile": "strict",
  "persistentMemory": true,
  "diffMaxLines": 40,
  "protectedPaths": [".env", ".env.", "id_rsa", "id_ed25519", ".npmrc", "credentials"],
  "gateBash": false,
  "extraMutatingTools": []
}
```

### Example: Codex-style workspace-write

```json
{
  "profile": "workspace"
}
```

Or:

```json
{
  "profile": "strict",
  "workspaceWrites": "allow",
  "outsideWrites": "ask"
}
```

Explicit `workspaceWrites` / `outsideWrites` override the profile baseline when set in the JSON file.  
`/edit-approval profile <name>` rewrites those fields to match the preset.

### Options

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `profile` | `strict` \| `workspace` \| `review` \| `off` | `strict` | Named preset |
| `workspaceWrites` | `allow` \| `ask` \| `deny` | from profile | Inside workspace |
| `outsideWrites` | `allow` \| `ask` \| `deny` | from profile | Outside workspace |
| `allowSessionBypassInWorkspace` | `boolean` | `true` | Offer session-wide workspace allow |
| `allowSessionBypassOutside` | `boolean` | `false` | Offer session-wide outside allow |
| `persistentMemory` | `boolean` | `true` | Offer always-allow / always-deny |
| `diffMaxLines` | `number` | `40` | Diff/preview size in the prompt |
| `protectedPaths` | `string[]` | see example | Substring / `*.ext` hard-deny |
| `gateBash` | `boolean` | `false` | Confirm every `bash` (noisy) |
| `extraMutatingTools` | `string[]` | `[]` | Extra tool names to gate |

Reload without restarting Pi:

```text
/edit-approval reload
```

## Persistent memory

File:

```text
~/.pi/agent/edit-approval-memory.json
```

```json
{
  "allowPaths": [],
  "allowPrefixes": [],
  "denyPaths": [],
  "denyPrefixes": []
}
```

Managed from the approval UI or:

```text
/edit-approval allow path/to/file
/edit-approval deny path/to/file
/edit-approval forget path/to/file
/edit-approval memory
```

**Order of checks** (first match wins where applicable):

1. Session deny  
2. Protected paths → deny  
3. Memory deny → deny  
4. Memory allow → allow  
5. Session allow / session workspace|outside bypass → allow  
6. Policy `allow` / `ask` / `deny`  

## Commands

| Command | Action |
|---------|--------|
| `/edit-approval` | Status (profile, policies, session, memory counts) |
| `/edit-approval reset` | Clear session allow/deny bypasses |
| `/edit-approval reload` | Re-read config + memory files |
| `/edit-approval profile <name>` | Set profile and persist |
| `/edit-approval allow <path>` | Persist allow path |
| `/edit-approval deny <path>` | Persist deny path |
| `/edit-approval forget <path>` | Remove path from memory |
| `/edit-approval memory` | Dump memory entries |

## What gets gated

Always treated as mutators:

- Built-in **`write`**, **`edit`**

Also matched by name (case-insensitive), including MCP-style names:

- `replace`, `create_file`, `delete_file`, `apply_patch`, `str_replace`
- Patterns like `fastctx_replace`, `mcp_foo_write`, …

Path fields inspected:  
`path`, `file_path`, `filePath`, `filepath`, `target`, `target_path`, `filename`, `paths[]`

Edit preview also understands `oldText` / `newText` and `old_string` / `new_string`.

## Limitations

1. **`bash` can bypass file gates** unless `gateBash` is `true`. Redirects are not parsed by default.  
2. **Not an OS sandbox** — only Pi tool calls this extension sees.  
3. Diff preview is a compact summary, not a full side-by-side reviewer (`pi-show-diffs` is complementary).  
4. In **print / headless** modes without UI, `ask` becomes a hard block.

For stronger isolation, use containers or a sandbox package; see [Pi security docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

## Package layout

```text
pi-edit-approval/
├── package.json
├── extensions/edit-approval.ts
├── edit-approval.example.json
├── CHANGELOG.md
├── LICENSE
└── README.md
```

```json
{
  "keywords": ["pi-package", "pi", "pi-extension", "pi-coding-agent"],
  "pi": { "extensions": ["./extensions"] }
}
```

The `pi-package` keyword is used by the [Pi package gallery](https://pi.dev/packages).

## Development

```bash
git clone https://github.com/ShawnMa123/pi-edit-approval.git
cd pi-edit-approval
pi -e ./extensions/edit-approval.ts
# or
pi install .
```

No build step: Pi loads the TypeScript extension directly.

## Uninstall

```bash
pi remove npm:pi-edit-approval
pi remove git:github.com/ShawnMa123/pi-edit-approval
```

Optional cleanup:

```bash
rm ~/.pi/agent/edit-approval.json
rm ~/.pi/agent/edit-approval-memory.json
```

## License

[GPL-3.0-only](LICENSE)

## Related

- [Pi packages documentation](https://pi.dev/docs/latest/packages)
- [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Upstream examples: `permission-gate.ts`, `protected-paths.ts`
- Complementary: [`pi-show-diffs`](https://www.npmjs.com/package/pi-show-diffs) (full diff UI)
- Heavier alternatives: various `pi-permission-*` packages
