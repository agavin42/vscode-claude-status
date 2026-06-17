#!/bin/bash
# cc-status — CLI for the Claude Code Status VS Code extension.
# Writes JSON requests into $TMPDIR/claude-code-status/cmd/ and polls for
# the extension's response.
#
# Subcommands:
#   sibling   [--name NAME]               new session in this dir (cold start)
#   fork      [--name NAME] [--id ID | --source NAME-OR-DISPLAYNAME]
#   heal      [--id ID | --name NAME]     send /remote-control to a session
#   remake    [--id ID | --name NAME]     kill+restart with --resume
#   rename    --name NAME [--id ID]       set customName + /rename
#   list                                  print all known sessions
#   get       [--id ID | --name NAME]     print one session's full record
#
# Self-targeting via $VSCODE_CC_ID (set by the extension when it launches
# the terminal). Sibling-targeting via --id or --name. Names match against
# customName / displayName / id.

set -e

STATE_DIR="${TMPDIR:-/tmp/}claude-code-status"
CMD_DIR="$STATE_DIR/cmd"
TIMEOUT_S=2

mkdir -p "$CMD_DIR" 2>/dev/null

usage() {
    cat <<EOF
cc-status — Claude Code Status CLI

Usage:
  cc-status sibling [--name NAME]
  cc-status fork    [--name NAME] [--id ID | --source NAME]
  cc-status heal    [--id ID | --name NAME]
  cc-status remake  [--id ID | --name NAME]
  cc-status rename  --name NAME [--id ID]
  cc-status list
  cc-status get     [--id ID | --name NAME]
  cc-status pr-status --pr URL --checkpoint CP [--stage N] [--id ID | --name NAME]

Self is targeted by default via \$VSCODE_CC_ID. Override with --id or
--name to act on a sibling session.

pr-status reports a PR's workflow checkpoint to the Sessions & PRs dashboard.
  CP is one of: drafting shipit shipit-done reviewable deployed done
  e.g.  cc-status pr-status --pr "\$PR_URL" --checkpoint shipit --stage 3
EOF
}

# Generate a UUID-ish nonce. Try uuidgen first (macOS / coreutils), fall
# back to /dev/urandom hex if not available.
gen_nonce() {
    if command -v uuidgen &>/dev/null; then
        uuidgen
    else
        printf 'cc-%s' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
    fi
}

# JSON-quote a value (escapes backslash and double-quote). For arbitrary
# user input — names, ids, etc.
json_quote() {
    printf '%s' "$1" | python3 -c '
import json, sys
sys.stdout.write(json.dumps(sys.stdin.read()))
'
}

# Send a request and wait for the response. Args:
#   $1: cmd (sibling|fork|heal|remake|rename|list|get)
#   $2: args JSON (e.g. '{"name":"foo"}' or '{}')
send_request() {
    local cmd="$1"
    local args_json="$2"
    local from="${VSCODE_CC_ID:-}"

    local nonce
    nonce=$(gen_nonce)

    local req_path="$CMD_DIR/$nonce.req"
    local res_path="$CMD_DIR/$nonce.res"

    # Build request JSON.
    local body
    if [ -n "$from" ]; then
        body=$(printf '{"id":%s,"from":%s,"cmd":%s,"args":%s}' \
            "$(json_quote "$nonce")" \
            "$(json_quote "$from")" \
            "$(json_quote "$cmd")" \
            "$args_json")
    else
        body=$(printf '{"id":%s,"cmd":%s,"args":%s}' \
            "$(json_quote "$nonce")" \
            "$(json_quote "$cmd")" \
            "$args_json")
    fi

    # Write atomically (write to .tmp, rename in).
    local tmp_path="$req_path.tmp"
    printf '%s' "$body" > "$tmp_path"
    mv "$tmp_path" "$req_path"

    # Poll for response. Sleep 50ms between checks.
    local elapsed=0
    local poll_step=0.05
    while [ ! -f "$res_path" ]; do
        sleep "$poll_step"
        elapsed=$(python3 -c "print($elapsed + $poll_step)")
        if python3 -c "import sys; sys.exit(0 if $elapsed >= $TIMEOUT_S else 1)"; then
            echo "Error: no response from extension within ${TIMEOUT_S}s" >&2
            echo "  Is VS Code running with this workspace open?" >&2
            echo "  Did the extension activate? Check Output → 'Claude Code Status'" >&2
            # Best-effort cleanup of the abandoned request.
            rm -f "$req_path" "$req_path.taken" 2>/dev/null
            return 1
        fi
    done

    # Hand the response file to Python via env var (avoids quoting issues
    # with newlines, quotes, etc. that JSON might contain).
    RES_PATH="$res_path" python3 <<'PYEOF'
import json, os, sys
res_path = os.environ['RES_PATH']
try:
    with open(res_path) as f:
        d = json.load(f)
except Exception as e:
    print(f'Bad response JSON: {e}', file=sys.stderr)
    sys.exit(2)
finally:
    try:
        os.unlink(res_path)
    except Exception:
        pass
if not d.get('ok'):
    print('Error:', d.get('error', 'unknown'), file=sys.stderr)
    sys.exit(1)
result = d.get('result', {})
print(json.dumps(result, indent=2))
PYEOF
}

# --- subcommand dispatch ---

if [ $# -eq 0 ]; then
    usage
    exit 1
fi

CMD="$1"
shift

NAME=""
ID=""
SOURCE=""
PR=""
CHECKPOINT=""
STAGE=""

# Parse target/value flags from remaining args.
while [ $# -gt 0 ]; do
    case "$1" in
        --name)
            NAME="$2"
            shift 2
            ;;
        --id)
            ID="$2"
            shift 2
            ;;
        --source)
            SOURCE="$2"
            shift 2
            ;;
        --pr)
            PR="$2"
            shift 2
            ;;
        --checkpoint)
            CHECKPOINT="$2"
            shift 2
            ;;
        --stage)
            STAGE="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 1
            ;;
    esac
done

build_args_json() {
    # $1: subcommand kind for arg shape selection
    case "$1" in
        sibling|fork)
            # new_name is the name to give the new session
            local pairs=""
            [ -n "$NAME" ] && pairs="$pairs,\"new_name\":$(json_quote "$NAME")"
            [ -n "$ID" ] && pairs="$pairs,\"id\":$(json_quote "$ID")"
            [ -n "$SOURCE" ] && pairs="$pairs,\"name\":$(json_quote "$SOURCE")"
            printf '{%s}' "${pairs#,}"
            ;;
        heal|remake|get)
            # --name and --id select the TARGET
            local pairs=""
            [ -n "$ID" ] && pairs="$pairs,\"id\":$(json_quote "$ID")"
            [ -n "$NAME" ] && pairs="$pairs,\"name\":$(json_quote "$NAME")"
            printf '{%s}' "${pairs#,}"
            ;;
        rename)
            # --name is the NEW name; --id is target
            local pairs=""
            [ -n "$ID" ] && pairs="$pairs,\"id\":$(json_quote "$ID")"
            [ -n "$NAME" ] && pairs="$pairs,\"new_name\":$(json_quote "$NAME")"
            printf '{%s}' "${pairs#,}"
            ;;
        pr-status)
            # --id/--name select the TARGET (default self via $VSCODE_CC_ID);
            # --pr/--checkpoint/--stage carry the PR + its workflow checkpoint.
            local pairs=""
            [ -n "$ID" ] && pairs="$pairs,\"id\":$(json_quote "$ID")"
            [ -n "$NAME" ] && pairs="$pairs,\"name\":$(json_quote "$NAME")"
            [ -n "$PR" ] && pairs="$pairs,\"pr\":$(json_quote "$PR")"
            [ -n "$CHECKPOINT" ] && pairs="$pairs,\"checkpoint\":$(json_quote "$CHECKPOINT")"
            [ -n "$STAGE" ] && pairs="$pairs,\"stage\":$(json_quote "$STAGE")"
            printf '{%s}' "${pairs#,}"
            ;;
        list)
            printf '{}'
            ;;
    esac
}

case "$CMD" in
    sibling|fork|heal|remake|rename|list|get|pr-status)
        ARGS_JSON=$(build_args_json "$CMD")
        send_request "$CMD" "$ARGS_JSON"
        ;;
    *)
        usage
        exit 1
        ;;
esac
