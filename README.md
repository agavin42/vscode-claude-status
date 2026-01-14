# Claude Code Status

VS Code extension for tracking Claude Code terminal status. Shows a **Claude Sessions** panel with live state updates for all your Claude terminals.

## Features

- **Claude Sessions Panel**: TreeView in Source Control sidebar showing all tracked Claude terminals
- **Live State Updates**: Real-time status via Claude Code hooks
- **Color-Coded States**:
  - 🔴 **PERMS** — Permission request waiting (needs attention!)
  - 🔵 **WAITING** — Claude asked a question (AskUserQuestion)
  - 🟡 **BUSY** — Working/thinking
  - 🟢 **idle** — Ready for input
  - 🟠 **TIMED OUT** — Permission/question timed out
- **Last Prompt Display**: Shows what was last asked of each Claude
- **Drag & Drop Reorder**: Arrange terminals in your preferred order
- **Inline Actions**: Rename (pencil) and Close (trash) buttons
- **State Persistence**: Terminal tracking survives VS Code reload

## Quick Start

### 1. Install the Extension

```bash
code --install-extension claude-code-status-0.1.0.vsix --force
```

### 2. Install the Hooks

The extension requires Claude Code hooks to communicate state. Run the install script:

```bash
./scripts/install-hooks.sh
```

This will:
- Copy `cc-status-hook.sh` to `~/bin/`
- Configure hooks in `~/.claude/settings.json`

**Note**: The script requires `jq` for JSON manipulation. Install it first if needed:
```bash
brew install jq  # macOS
```

### 3. Verify Installation

```bash
./scripts/install-hooks.sh --verify
```

### 4. Restart VS Code

After installation, restart VS Code (or reload the window with Cmd+Shift+P → "Developer: Reload Window").

### 5. Create a Claude Terminal

- Click the **+** button in the Claude Sessions panel (Source Control sidebar), or
- Use **Cmd+Shift+C**, or
- Run command: **Claude Code: New Terminal**

The terminal will appear in the Claude Sessions panel and show live status updates.

---

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Claude Code: New Terminal | Cmd+Shift+C | Create new tracked Claude terminal |
| Claude Code: New Terminal (Resume) | — | Create terminal with `--resume` flag |
| Claude Code: Show Terminals | — | Quick pick of all terminals |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeCodeStatus.enabled` | `true` | Enable the extension |
| `claudeCodeStatus.debug` | `false` | Log state changes to output channel |
| `claudeCodeStatus.permsTimeout` | `60` | Seconds before PERMS/WAITING auto-transitions to TIMED OUT |

---

## How It Works

1. Extension creates terminals with `VSCODE_CC_ID` environment variable
2. Claude Code hooks call `cc-status-hook.sh` on various events
3. Hook script writes state to `$TMPDIR/claude-code-status/{id}.state`
4. Extension polls state files (every 100ms) and updates the TreeView

### Hook Events → States

| Hook Event | Condition | State |
|------------|-----------|-------|
| `PreToolUse` | — | BUSY |
| `PostToolUse` | — | BUSY |
| `PermissionRequest` | `AskUserQuestion` | WAITING |
| `PermissionRequest` | (other tools) | PERMS |
| `UserPromptSubmit` | — | BUSY |
| `Stop` | — | IDLE |
| `Notification` | `waiting_for_user_action` | WAITING |
| `Notification` | `idle_timeout` | IDLE |
| `SessionStart` | — | IDLE |
| `SessionEnd` | — | (cleanup) |

### Timeout Behavior

If PERMS or WAITING state persists longer than `permsTimeout` seconds (default 60), the extension auto-transitions to TIMED OUT. This handles cases where the user dismisses a dialog without a hook firing.

---

## Manual Hook Setup

If the install script doesn't work for your setup, you can configure hooks manually.

### 1. Copy the Hook Script

```bash
mkdir -p ~/bin
cp scripts/cc-status-hook.sh ~/bin/
chmod +x ~/bin/cc-status-hook.sh
```

### 2. Configure Claude Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "Notification": [
      { "matcher": "idle_timeout", "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] },
      { "matcher": "waiting_for_user_action", "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
    ]
  }
}
```

---

## Requirements

- VS Code 1.108+
- Claude Code CLI with hooks support
- `jq` recommended (for install script and reliable JSON parsing in hook)

## Limitations

- Only tracks terminals created via this extension's commands (or adopted via Show Terminals)
- Hooks must be configured in `~/.claude/settings.json`

---

## Debugging

1. Enable debug logging: Set `claudeCodeStatus.debug` to `true` in VS Code settings
2. View logs: Output panel (Cmd+Shift+U) → select "Claude Code Status"
3. Check state files: `ls ${TMPDIR}claude-code-status/`
4. Verify hooks: `./scripts/install-hooks.sh --verify`

---

## Development

### Setup

```bash
cd ~/src/vscode-claude-status
npm install
npm run compile
```

### Build & Test Cycle

```bash
npm run compile && npx vsce package
code --install-extension claude-code-status-0.1.0.vsix --force
# Then: Cmd+Shift+P → "Developer: Reload Window"
```

### Debug in VS Code

Press F5 to launch Extension Development Host.

---

## Architecture Notes (for maintainers)

### Source Files

- `src/extension.ts` — Main extension code (terminal tracking, TreeView, state polling)
- `scripts/cc-status-hook.sh` — Shell hook that Claude Code calls (writes state files)
- `scripts/install-hooks.sh` — Installation and verification script
- `package.json` — Commands, keybindings, configuration schema

### Key Concepts

- Terminals get `VSCODE_CC_ID` env var for identification
- State files stored in `$TMPDIR/claude-code-status/{ccId}.state`
- Extension polls state files every 100ms
- Terminal names include `[shortId]` suffix for matching after reload
- `hasUserInput` flag suppresses BUSY during startup (until first prompt submitted)
- Restored terminals start as IDLE; state file is reset to prevent stale BUSY
- `deactivate()` preserves state files (needed for reload persistence)
- Restore retries up to 5 times waiting for VS Code to populate terminal names

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Terminal names empty on restore | VS Code hasn't populated names yet | Retry logic handles this automatically |
| State not updating | Hooks not configured | Run `./scripts/install-hooks.sh --verify` |
| BUSY stuck after accepting permission | Missing PostToolUse hook | Ensure PostToolUse is in hooks config |

---

## Uninstall

```bash
./scripts/install-hooks.sh --uninstall
code --uninstall-extension local.claude-code-status
```

---

## License

MIT
