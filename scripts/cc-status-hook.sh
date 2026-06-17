#!/bin/bash
# Claude Code status hook for VS Code extension
# Writes state to a file that the extension watches
# Gracefully skips if anything is missing

# Check for required env var - silently exit if not present
[ -z "$VSCODE_CC_ID" ] && exit 0

# State directory - use TMPDIR if set (macOS), fallback to /tmp
STATE_DIR="${TMPDIR:-/tmp}claude-code-status"
STATE_FILE="$STATE_DIR/$VSCODE_CC_ID.state"
SESSION_FILE="$STATE_DIR/$VSCODE_CC_ID.session"
CWD_FILE="$STATE_DIR/$VSCODE_CC_ID.cwd"
TX_FILE="$STATE_DIR/$VSCODE_CC_ID.tx"
VERSION_FILE="$STATE_DIR/$VSCODE_CC_ID.version"
PROMPT_FILE="$STATE_DIR/$VSCODE_CC_ID.prompt"
SUBAGENT_FILE="$STATE_DIR/$VSCODE_CC_ID.subagents"
PRS_LOG_FILE="$STATE_DIR/$VSCODE_CC_ID.prs.log"

# Ensure state directory exists
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Read JSON from stdin (Claude passes hook context as JSON)
INPUT=$(cat 2>/dev/null) || exit 0

# Extract hook event name + auxiliary fields. The always-present fields per docs
# are session_id, transcript_path, cwd, hook_event_name. Prefer jq when available.
if command -v jq &>/dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
    PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
    NOTIFICATION=$(echo "$INPUT" | jq -r '.notification // empty' 2>/dev/null)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
    CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
else
    # Fallback: simple grep extraction
    HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    TRANSCRIPT_PATH=$(echo "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\([^"]*\)".*/\1/' 2>/dev/null)
    PROMPT=""
    NOTIFICATION=""
fi

# Skip if we couldn't determine the hook event
[ -z "$HOOK_EVENT" ] && exit 0

# Always-on captures: write sidecar files for any event that included them.
# Idempotent overwrites; the extension polls these in the same cycle as .state.
[ -n "$SESSION_ID" ] && echo "$SESSION_ID" > "$SESSION_FILE" 2>/dev/null
[ -n "$CWD" ] && echo "$CWD" > "$CWD_FILE" 2>/dev/null
[ -n "$TRANSCRIPT_PATH" ] && echo "$TRANSCRIPT_PATH" > "$TX_FILE" 2>/dev/null

# Helper: atomic-ish counter bump. Race-tolerant — integer overwrite is fine
# if we miss a stop event; the count will floor at zero on the next read.
bump_subagents() {
    local delta=$1
    local cur
    cur=$(cat "$SUBAGENT_FILE" 2>/dev/null || echo 0)
    # Validate it's an integer; default to 0 if not
    [[ "$cur" =~ ^[0-9]+$ ]] || cur=0
    local new=$((cur + delta))
    [ "$new" -lt 0 ] && new=0
    echo "$new" > "$SUBAGENT_FILE" 2>/dev/null
}

# Dashboard PR detection: when a `gh pr create` call returns a github pull URL,
# append it (https-normalized) for the Sessions & PRs dashboard to reconcile.
# Append-only; the extension owns dedup.
detect_pr_for_dashboard() {
    local input="$1"
    case "$input" in
        *"gh pr create"*) ;;
        *) return 0 ;;
    esac
    local pr_url
    pr_url=$(printf '%s' "$input" \
        | grep -oE 'github\.com/[^/"]+/[^/"]+/pull/[0-9]+' | head -1)
    [ -z "$pr_url" ] && return 0
    printf 'https://%s\n' "$pr_url" >> "$PRS_LOG_FILE" 2>/dev/null
}

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
    PermissionDenied)
        # User responded; clear PERMS without waiting for timeout
        STATE="IDLE"
        ;;
    PreToolUse|PostToolUse|PostToolUseFailure|PostToolBatch)
        STATE="BUSY"
        # A finished Bash call is the only place a `gh pr create` URL surfaces.
        if [ "$HOOK_EVENT" = "PostToolUse" ] && [ "$TOOL_NAME" = "Bash" ]; then
            detect_pr_for_dashboard "$INPUT"
        fi
        ;;
    Stop)
        STATE="IDLE"
        ;;
    StopFailure)
        # Stop failed but session isn't actively working; safe default
        STATE="IDLE"
        ;;
    UserPromptSubmit)
        STATE="BUSY"
        ;;
    Notification)
        # Both old (idle_timeout / waiting_for_user_action) and new
        # (idle_prompt / permission_prompt) matcher names are recognized so
        # the hook keeps working before the user re-runs install-hooks.sh.
        case "$NOTIFICATION" in
            waiting_for_user_action|permission_prompt)
                STATE="WAITING"
                ;;
            idle_timeout|idle_prompt|auth_success)
                STATE="IDLE"
                ;;
            elicitation_dialog)
                # MCP elicitation is functionally a question to the user
                STATE="WAITING"
                ;;
            elicitation_complete|elicitation_response)
                STATE="IDLE"
                ;;
            *)
                STATE="IDLE"
                ;;
        esac
        ;;
    SessionStart)
        STATE="IDLE"
        # Capture claude --version once per session (backgrounded so we don't
        # slow the hook). Gated on file existence so it runs at most once.
        if [ ! -f "$VERSION_FILE" ]; then
            ( "${CLAUDE_CMD:-claude}" --version > "$VERSION_FILE" 2>/dev/null ) &
        fi
        # Reset subagent counter — new session, no inherited count
        echo 0 > "$SUBAGENT_FILE" 2>/dev/null
        ;;
    CwdChanged)
        # .cwd already updated above by the always-on capture. No state change.
        exit 0
        ;;
    PreCompact)
        # Compacting — treat as BUSY for now; can become a dedicated state later
        STATE="BUSY"
        ;;
    PostCompact)
        # Compaction done. session_id may have changed; the always-on
        # capture above already updated .session. Go back to IDLE.
        STATE="IDLE"
        ;;
    SubagentStart)
        bump_subagents 1
        # Don't change top-level state — parent session's state still drives UI
        exit 0
        ;;
    SubagentStop)
        bump_subagents -1
        exit 0
        ;;
    SessionEnd)
        # Clean up state files on session end
        rm -f "$STATE_FILE" "$SESSION_FILE" "$CWD_FILE" "$TX_FILE" "$VERSION_FILE" "$PROMPT_FILE" "$SUBAGENT_FILE" 2>/dev/null
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
    echo "$PROMPT" > "$PROMPT_FILE" 2>/dev/null
fi

exit 0
