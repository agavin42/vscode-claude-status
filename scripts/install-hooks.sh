#!/bin/bash
# Install script for Claude Code Status VS Code extension hooks
# Usage: ./scripts/install-hooks.sh [--uninstall] [--verify]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/cc-status-hook.sh"
CLI_SCRIPT="$SCRIPT_DIR/cc-status.sh"
SLASH_TEMPLATE="$SCRIPT_DIR/cc-slash-command.md"
INSTALL_DIR="$HOME/bin"
INSTALL_PATH="$INSTALL_DIR/cc-status-hook.sh"
CLI_INSTALL_PATH="$INSTALL_DIR/cc-status"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_COMMANDS_DIR="$CLAUDE_DIR/commands"
SLASH_INSTALL_PATH="$CLAUDE_COMMANDS_DIR/cc.md"
CLAUDE_MD_PATH="$CLAUDE_DIR/CLAUDE.md"
CLAUDE_MD_MARKER="<!-- claude-code-status: cc-status CLI reference -->"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Hook configuration to add. Notification matcher names match the current
# Claude Code docs: permission_prompt + idle_prompt (replacing the older
# waiting_for_user_action + idle_timeout). The hook script still handles
# both old and new names so a stale settings.json won't break tracking.
HOOKS_JSON='{
  "PreToolUse": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "PostToolUse": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "PermissionRequest": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "PermissionDenied": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "StopFailure": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "Notification": [
    { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] },
    { "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "SessionEnd": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "CwdChanged": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "PreCompact": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "PostCompact": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "SubagentStart": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ],
  "SubagentStop": [
    { "hooks": [{ "type": "command", "command": "~/bin/cc-status-hook.sh" }] }
  ]
}'

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}!${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

verify_installation() {
    local errors=0

    echo "Verifying installation..."
    echo ""

    # Check hook script exists and is executable
    if [ -x "$INSTALL_PATH" ]; then
        print_status "Hook script installed at $INSTALL_PATH"
    else
        print_error "Hook script not found or not executable at $INSTALL_PATH"
        errors=$((errors + 1))
    fi

    # Check cc-status CLI
    if [ -x "$CLI_INSTALL_PATH" ]; then
        print_status "cc-status CLI installed at $CLI_INSTALL_PATH"
    else
        print_warning "cc-status CLI not installed at $CLI_INSTALL_PATH (re-run install to deploy)"
    fi

    # Check /cc slash command
    if [ -f "$SLASH_INSTALL_PATH" ] && grep -q "$CLAUDE_MD_MARKER\|managed by claude-code-status" "$SLASH_INSTALL_PATH" 2>/dev/null; then
        print_status "/cc slash command installed at $SLASH_INSTALL_PATH"
    else
        print_warning "/cc slash command missing at $SLASH_INSTALL_PATH"
    fi

    # Check CLAUDE.md fragment
    if [ -f "$CLAUDE_MD_PATH" ] && grep -q "$CLAUDE_MD_MARKER" "$CLAUDE_MD_PATH" 2>/dev/null; then
        print_status "CLAUDE.md fragment present"
    else
        print_warning "CLAUDE.md fragment missing (re-run install to add)"
    fi

    # Check jq is available (recommended)
    if command -v jq &>/dev/null; then
        print_status "jq is installed (recommended for reliable JSON parsing)"
    else
        print_warning "jq not found - hook will use fallback grep parsing (less reliable)"
    fi

    # Check Claude settings file exists
    if [ -f "$CLAUDE_SETTINGS" ]; then
        print_status "Claude settings file exists at $CLAUDE_SETTINGS"

        # Check if hooks are configured
        if command -v jq &>/dev/null; then
            if jq -e '.hooks.PreToolUse' "$CLAUDE_SETTINGS" &>/dev/null; then
                print_status "Hooks are configured in Claude settings"

                # Verify hook points to our script
                if jq -e '.hooks.PreToolUse[] | select(.hooks[].command == "~/bin/cc-status-hook.sh")' "$CLAUDE_SETTINGS" &>/dev/null; then
                    print_status "PreToolUse hook points to correct script"
                else
                    print_warning "PreToolUse hook may not point to ~/bin/cc-status-hook.sh"
                fi

                # Check that the current-doc Notification matcher names are
                # present. Old names (idle_timeout / waiting_for_user_action)
                # are still tolerated by the hook script but no longer fire.
                if jq -e '.hooks.Notification[] | select(.matcher == "idle_prompt")' "$CLAUDE_SETTINGS" &>/dev/null; then
                    print_status "Notification matcher 'idle_prompt' configured"
                else
                    print_warning "Notification matcher 'idle_prompt' missing — re-run install to refresh"
                fi
                if jq -e '.hooks.Notification[] | select(.matcher == "permission_prompt")' "$CLAUDE_SETTINGS" &>/dev/null; then
                    print_status "Notification matcher 'permission_prompt' configured"
                else
                    print_warning "Notification matcher 'permission_prompt' missing — re-run install to refresh"
                fi

                # Warn about stale matchers that won't fire on current Claude Code
                if jq -e '.hooks.Notification[] | select(.matcher == "idle_timeout" or .matcher == "waiting_for_user_action")' "$CLAUDE_SETTINGS" &>/dev/null; then
                    print_warning "Stale Notification matcher (idle_timeout / waiting_for_user_action) still present — re-run install to clean up"
                fi

                # Spot-check a couple of newer event subscriptions
                for ev in PreCompact PostCompact SubagentStart SubagentStop CwdChanged; do
                    if jq -e ".hooks.$ev" "$CLAUDE_SETTINGS" &>/dev/null; then
                        print_status "$ev hook configured"
                    else
                        print_warning "$ev hook missing — re-run install to refresh"
                    fi
                done
            else
                print_error "Hooks not configured in Claude settings"
                errors=$((errors + 1))
            fi
        else
            print_warning "Cannot verify hook configuration without jq"
        fi
    else
        print_error "Claude settings file not found at $CLAUDE_SETTINGS"
        errors=$((errors + 1))
    fi

    echo ""
    if [ $errors -eq 0 ]; then
        print_status "Installation verified successfully!"
        return 0
    else
        print_error "Installation has $errors error(s)"
        return 1
    fi
}

install_hooks() {
    echo "Installing Claude Code Status hooks..."
    echo ""

    # Check if source hook script exists
    if [ ! -f "$HOOK_SCRIPT" ]; then
        print_error "Hook script not found at $HOOK_SCRIPT"
        echo "Make sure you're running this from the extension directory."
        exit 1
    fi

    # Create ~/bin if it doesn't exist
    if [ ! -d "$INSTALL_DIR" ]; then
        mkdir -p "$INSTALL_DIR"
        print_status "Created $INSTALL_DIR"
    fi

    # Copy hook script
    cp "$HOOK_SCRIPT" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
    print_status "Installed hook script to $INSTALL_PATH"

    # Copy cc-status CLI
    if [ -f "$CLI_SCRIPT" ]; then
        cp "$CLI_SCRIPT" "$CLI_INSTALL_PATH"
        chmod +x "$CLI_INSTALL_PATH"
        print_status "Installed cc-status CLI to $CLI_INSTALL_PATH"
    else
        print_warning "cc-status.sh not found in scripts/ — CLI not installed"
    fi

    # Create ~/.claude directory if needed
    if [ ! -d "$CLAUDE_DIR" ]; then
        mkdir -p "$CLAUDE_DIR"
        print_status "Created $CLAUDE_DIR"
    fi

    # Create ~/.claude/commands directory and install /cc slash command
    if [ -f "$SLASH_TEMPLATE" ]; then
        mkdir -p "$CLAUDE_COMMANDS_DIR"
        cp "$SLASH_TEMPLATE" "$SLASH_INSTALL_PATH"
        print_status "Installed /cc slash command to $SLASH_INSTALL_PATH"
    else
        print_warning "cc-slash-command.md template not found — slash command not installed"
    fi

    # Append CLAUDE.md fragment idempotently (looks for marker before adding).
    if [ ! -f "$CLAUDE_MD_PATH" ]; then
        touch "$CLAUDE_MD_PATH"
    fi
    if ! grep -q "$CLAUDE_MD_MARKER" "$CLAUDE_MD_PATH" 2>/dev/null; then
        cat >> "$CLAUDE_MD_PATH" <<EOF

$CLAUDE_MD_MARKER
## Claude Code Status CLI (cc-status)

A CLI is available for controlling the Claude Code Status VS Code panel from inside a session:

- \`/cc list\` — list all sessions in the current window
- \`/cc sibling --name NAME\` — spawn a fresh sibling session in the same directory
- \`/cc fork --name NAME\` — branch this conversation into a new session
- \`/cc heal --name NAME\` — send /remote-control to reconnect a sibling whose link dropped
- \`/cc remake\` — restart this session with --resume
- \`/cc rename --name NAME\` — rename this session

The \`/cc\` slash command wraps \`cc-status\` (installed at ~/bin/cc-status). Self is targeted by default via the \$VSCODE_CC_ID env var. To act on a sibling, use \`--name\` or \`--id\`.
<!-- end claude-code-status -->
EOF
        print_status "Appended cc-status reference to $CLAUDE_MD_PATH"
    else
        print_status "CLAUDE.md fragment already present (skipping)"
    fi

    # Check if jq is available for JSON manipulation
    if ! command -v jq &>/dev/null; then
        print_warning "jq not found - cannot automatically configure hooks"
        echo ""
        echo "Please manually add the following to $CLAUDE_SETTINGS:"
        echo ""
        echo "$HOOKS_JSON"
        echo ""
        echo "Or install jq and run this script again:"
        echo "  brew install jq  # macOS"
        echo "  apt install jq   # Ubuntu/Debian"
        return 0
    fi

    # Create or update Claude settings
    if [ -f "$CLAUDE_SETTINGS" ]; then
        # Backup existing settings
        cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup"
        print_status "Backed up existing settings to $CLAUDE_SETTINGS.backup"

        # Merge hooks into existing settings
        local existing_hooks=$(jq '.hooks // {}' "$CLAUDE_SETTINGS")
        local merged_hooks=$(echo "$existing_hooks" | jq --argjson new "$HOOKS_JSON" '. * $new')
        jq --argjson hooks "$merged_hooks" '.hooks = $hooks' "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp"
        mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
        print_status "Merged hooks into existing Claude settings"
    else
        # Create new settings file
        echo "{\"hooks\": $HOOKS_JSON}" | jq '.' > "$CLAUDE_SETTINGS"
        print_status "Created new Claude settings with hooks"
    fi

    echo ""
    print_status "Installation complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Restart VS Code"
    echo "  2. Use Cmd+Shift+C (or the + button) to create a tracked Claude terminal"
    echo "  3. The terminal should appear in the Claude Sessions panel (Source Control sidebar)"
    echo ""
    echo "Run '$0 --verify' to verify the installation"
}

uninstall_hooks() {
    echo "Uninstalling Claude Code Status hooks..."
    echo ""

    # Remove hook script
    if [ -f "$INSTALL_PATH" ]; then
        rm "$INSTALL_PATH"
        print_status "Removed hook script from $INSTALL_PATH"
    else
        print_warning "Hook script not found at $INSTALL_PATH"
    fi

    # Remove cc-status CLI
    if [ -f "$CLI_INSTALL_PATH" ]; then
        rm "$CLI_INSTALL_PATH"
        print_status "Removed cc-status CLI from $CLI_INSTALL_PATH"
    fi

    # Remove /cc slash command
    if [ -f "$SLASH_INSTALL_PATH" ]; then
        rm "$SLASH_INSTALL_PATH"
        print_status "Removed /cc slash command from $SLASH_INSTALL_PATH"
    fi

    # Note about CLAUDE.md fragment (don't auto-edit user's CLAUDE.md)
    if [ -f "$CLAUDE_MD_PATH" ] && grep -q "$CLAUDE_MD_MARKER" "$CLAUDE_MD_PATH" 2>/dev/null; then
        print_warning "CLAUDE.md fragment still present at $CLAUDE_MD_PATH"
        echo "  Look for the block starting with: $CLAUDE_MD_MARKER"
        echo "  Remove it by hand if you no longer want the cc-status reference."
    fi

    # Remove hooks from Claude settings (if jq available)
    if command -v jq &>/dev/null && [ -f "$CLAUDE_SETTINGS" ]; then
        # Remove our specific hooks (ones pointing to ~/bin/cc-status-hook.sh)
        # This is tricky - for safety, just warn the user
        print_warning "Please manually remove the cc-status-hook.sh hooks from $CLAUDE_SETTINGS"
        echo "  Or delete the 'hooks' section if you have no other hooks configured."
    fi

    echo ""
    print_status "Uninstall complete!"
}

# Parse arguments
case "${1:-}" in
    --verify|-v)
        verify_installation
        ;;
    --uninstall|-u)
        uninstall_hooks
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (none)       Install hooks"
        echo "  --verify     Verify installation"
        echo "  --uninstall  Remove hooks"
        echo "  --help       Show this help"
        ;;
    "")
        install_hooks
        ;;
    *)
        echo "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac
