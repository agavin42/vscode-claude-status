#!/bin/bash
# Install script for Claude Code Status VS Code extension hooks
# Usage: ./scripts/install-hooks.sh [--uninstall] [--verify]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/cc-status-hook.sh"
INSTALL_DIR="$HOME/bin"
INSTALL_PATH="$INSTALL_DIR/cc-status-hook.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Hook configuration to add
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

    # Create ~/.claude directory if needed
    if [ ! -d "$HOME/.claude" ]; then
        mkdir -p "$HOME/.claude"
        print_status "Created ~/.claude directory"
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
