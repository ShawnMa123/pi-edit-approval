# pi-edit-approval

[![npm version](https://img.shields.io/npm/v/pi-edit-approval.svg)](https://www.npmjs.com/package/pi-edit-approval)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**Pi** coding-agent extension that asks before the agent modifies files.

- **Reads stay free** — `read` / `grep` / `find` / `ls` are never prompted
- **Writes need approval** — built-in `write` / `edit`, plus common mutator tool names (e.g. MCP `replace`)
- **Workspace-aware** — separate policies for paths inside vs outside the project (git root or cwd)
- **Session shortcuts** — allow one file, or all workspace writes, for the rest of the session

Keywords for discovery: `pi-package`, `pi`, `pi-extension`, `pi-coding-agent`.

> Pi has no built-in “confirm before edit” switch. This package adds that gate via the extension `tool_call` hook.

## Install

Requires [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

You can install from **npm** or **GitHub** — both are supported.

### From npm (recommended)

Published as [`pi-edit-approval`](https://www.npmjs.com/package/pi-edit-approval) on the public npm registry.

```bash
pi install npm:pi-edit-approval
```

Pin a version:

```bash
pi install npm:pi-edit-approval@0.1.0
```

### From GitHub

```bash
pi install git:github.com/ShawnMa123/pi-edit-approval
```

Equivalent forms:

```bash
pi install https://github.com/ShawnMa123/pi-edit-approval
pi install git:github.com/ShawnMa123/pi-edit-approval@main
```

Pin a tag or commit when you want a fixed revision:

```bash
pi install git:github.com/ShawnMa123/pi-edit-approval@v0.1.0
```

### Try once without installing

```bash
pi -e npm:pi-edit-approval
pi -e git:github.com/ShawnMa123/pi-edit-approval
```

### Local path (development)

```bash
pi install /path/to/pi-edit-approval
# or
pi -e ./extensions/edit-approval.ts
```

### Project-local install

Writes to `.pi/settings.json` (shared with the repo) instead of your user settings:

```bash
pi install -l npm:pi-edit-approval
# or
pi install -l git:github.com/ShawnMa123/pi-edit-approval
```

After install, start a **new** session or run **`/reload`**.

If you previously copied `edit-approval.ts` into `~/.pi/agent/extensions/`, remove that copy to avoid loading the extension twice.

## Default behavior

| Tool / path | Default |
|-------------|---------|
| `read`, `grep`, `find`, `ls` | Always allow |
| `write` / `edit` **inside** workspace | **Ask** |
| `write` / `edit` **outside** workspace | **Ask** (labeled `OUTSIDE workspace`) |
| Other tools matching mutator name patterns | Ask (same path rules) |
| `bash` | Not gated (see `gateBash`) |
| Non-interactive (`-p` / no UI) when policy is `ask` | **Block** (no silent writes) |

**Workspace root** = `git rev-parse --show-toplevel` when available, otherwise the session cwd.

### Prompt choices

When a confirmation appears you can typically choose:

- **Yes** — allow this call only  
- **Yes, this file this session** — skip further prompts for that absolute path  
- **Yes, all workspace writes this session** — if enabled in config (in-workspace only)  
- **Yes, all outside writes this session** — only if you enable it in config  
- **No** — block the tool call  

## Configuration

Optional file:

```text
~/.pi/agent/edit-approval.json
```

Copy the example:

```bash
# Linux / macOS
cp "$(npm root -g)/../..."   # or copy from the cloned repo:
cp edit-approval.example.json ~/.pi/agent/edit-approval.json

# Windows (PowerShell)
Copy-Item edit-approval.example.json $env:USERPROFILE\.pi\agent\edit-approval.json
```

### Example: ask everywhere (default)

```json
{
  "workspaceWrites": "ask",
  "outsideWrites": "ask",
  "allowSessionBypassInWorkspace": true,
  "allowSessionBypassOutside": false,
  "gateBash": false,
  "extraMutatingTools": []
}
```

### Example: Codex-style workspace-write

Allow free edits inside the repo; confirm (or deny) anything outside:

```json
{
  "workspaceWrites": "allow",
  "outsideWrites": "ask",
  "allowSessionBypassInWorkspace": true,
  "allowSessionBypassOutside": false,
  "gateBash": false,
  "extraMutatingTools": []
}
```

### Example: hard deny outside the repo

```json
{
  "workspaceWrites": "ask",
  "outsideWrites": "deny"
}
```

### Options

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `workspaceWrites` | `"allow"` \| `"ask"` \| `"deny"` | `"ask"` | Policy for paths inside the workspace |
| `outsideWrites` | `"allow"` \| `"ask"` \| `"deny"` | `"ask"` | Policy for paths outside the workspace |
| `allowSessionBypassInWorkspace` | `boolean` | `true` | Offer “all workspace writes this session” |
| `allowSessionBypassOutside` | `boolean` | `false` | Offer “all outside writes this session” |
| `gateBash` | `boolean` | `false` | If `true`, confirm every `bash` call |
| `extraMutatingTools` | `string[]` | `[]` | Extra tool names to treat as mutators |

Reload config without restarting Pi:

```text
/edit-approval reload
```

## Commands

| Command | Action |
|---------|--------|
| `/edit-approval` | Show workspace root, policies, session bypass state, config path |
| `/edit-approval reset` | Clear session allow-lists / bypasses |
| `/edit-approval reload` | Re-read `~/.pi/agent/edit-approval.json` |

## What gets gated

Always treated as mutators:

- Built-in **`write`**, **`edit`**

Also matched by name (case-insensitive), including MCP-style names:

- `replace`, `create_file`, `delete_file`, `apply_patch`, `str_replace`
- Patterns like `fastctx_replace`, `mcp_foo_write`, …

Path fields inspected on tool input:

`path`, `file_path`, `filePath`, `filepath`, `target`, `target_path`, `filename`, `paths[]`

Add stubborn custom tool names via `extraMutatingTools`.

## Limitations

1. **`bash` can bypass file gates** unless `gateBash` is `true` (noisy). Redirects like `echo hi > file` are not parsed specially.
2. This is **not an OS sandbox**. It only intercepts Pi tool calls the extension sees.
3. Unknown mutators with odd argument shapes may only show a generic confirmation.
4. In **print / headless** modes without UI, `ask` becomes a hard block by design.

For stronger isolation, combine with containers or a sandbox package; see [Pi security docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

## Package layout

```text
pi-edit-approval/
├── package.json                 # pi-package manifest + keywords
├── extensions/
│   └── edit-approval.ts         # extension entry
├── edit-approval.example.json   # sample config
├── LICENSE                      # GPL-3.0-only
└── README.md
```

`package.json` declares:

```json
{
  "keywords": ["pi-package", "pi", "pi-extension", "pi-coding-agent"],
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

That `pi-package` keyword is what the [Pi package gallery](https://pi.dev/packages) uses for discovery (this package is on npm, so it is eligible for the gallery index).

## Development

```bash
git clone https://github.com/ShawnMa123/pi-edit-approval.git
cd pi-edit-approval

# load from this checkout
pi -e ./extensions/edit-approval.ts
# or
pi install .
```

No build step: Pi loads the TypeScript extension directly.

## Uninstall

Remove whichever source you installed:

```bash
pi remove npm:pi-edit-approval
pi remove git:github.com/ShawnMa123/pi-edit-approval
```

Also delete `~/.pi/agent/edit-approval.json` if you no longer need it.

## License

[GPL-3.0-only](LICENSE)

## Related

- [Pi packages documentation](https://pi.dev/docs/latest/packages)
- [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Upstream examples: `permission-gate.ts`, `protected-paths.ts` in the Pi repo
- Similar ecosystem packages: `pi-show-diffs`, various `pi-permission-*` tools (heavier / different focus)
