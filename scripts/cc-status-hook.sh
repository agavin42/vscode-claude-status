#!/bin/bash
# Claude Code status hook for VS Code extension
# Writes state to a file that the extension watches
# Gracefully skips if anything is missing

# Check for required env var - silently exit if not present
[ -z "$VSCODE_CC_ID" ] && exit 0

# State directory - use TMPDIR if set (macOS), fallback to /tmp
STATE_DIR="${TMPDIR:-/tmp}claude-code-status"
STATE_FILE="$STATE_DIR/$VSCODE_CC_ID.state"

# Ensure state directory exists
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Read JSON from stdin (Claude passes hook context as JSON)
INPUT=$(cat 2>/dev/null) || exit 0

# Extract hook event name, prompt, notification type, and tool name - try jq first, fall back to grep
if command -v jq &>/dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
    PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
    NOTIFICATION=$(echo "$INPUT" | jq -r '.notification // empty' 2>/dev/null)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
else
    # Fallback: simple grep extraction
    HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    PROMPT=""
    NOTIFICATION=""
fi

# Skip if we couldn't determine the hook event
[ -z "$HOOK_EVENT" ] && exit 0

# Map hook event to state
case "$HOOK_EVENT" in
    PermissionRequest)
        # AskUserQuestion is a question, not a permission
        if [ "$TOOL_NAME" = "AskUserQuestion" ]; then
            STATE="WAITING"
        else
            STATE="PERMS"
        fi
        ;;
    PreToolUse|PostToolUse)
        STATE="BUSY"
        ;;
    Stop)
        STATE="IDLE"
        ;;
    UserPromptSubmit)
        STATE="BUSY"
        ;;
    Notification)
        # Differentiate notification types
        if [ "$NOTIFICATION" = "waiting_for_user_action" ]; then
            # Claude asked a question, waiting for user response
            STATE="WAITING"
        else
            # idle_timeout or other = just idle
            STATE="IDLE"
        fi
        ;;
    SessionStart)
        STATE="IDLE"
        ;;
    SessionEnd)
        # Clean up state file on session end
        rm -f "$STATE_FILE" 2>/dev/null
        exit 0
        ;;
    *)
        # Unknown hook, skip
        exit 0
        ;;
esac

# Write state to file
echo "$STATE" > "$STATE_FILE" 2>/dev/null

# Write prompt to separate file if present (from UserPromptSubmit)
if [ -n "$PROMPT" ]; then
    echo "$PROMPT" > "${STATE_FILE%.state}.prompt" 2>/dev/null
fi

exit 0
