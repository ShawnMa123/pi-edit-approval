# Changelog

## 0.2.0

### Added
- **Profiles**: `strict` | `workspace` | `review` | `off` via config or `/edit-approval profile <name>`
- **Persistent memory** (`~/.pi/agent/edit-approval-memory.json`): always allow/deny file or directory
- **Richer diff/write preview** in the approval prompt (`diffMaxLines`)
- **Protected paths** hard-deny list (e.g. `.env`, key files)
- Commands: `allow`, `deny`, `forget`, `memory`, `profile`

### Prompt choices
- Yes / No
- Yes, this file this session
- Yes, all workspace|outside writes this session
- Yes, always allow this file|directory
- No, this file this session
- No, always deny this file

## 0.1.0

- Initial release: ask before write/edit, reads free, workspace vs outside policies
