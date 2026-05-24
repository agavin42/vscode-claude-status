---
description: Control the Claude Code Status panel — sibling, fork, heal, remake, rename, list, get
argument-hint: <subcommand> [args]
---

<!-- managed by claude-code-status install-hooks.sh — do not edit by hand -->

Run `cc-status $ARGUMENTS` in a Bash shell and surface the result to the user. The Bash output is ONLY visible to you — the user can't see your tool results — so you must actively render what you got.

Presentation rules by subcommand:

- **`list`** — render as a markdown table with columns: `Name`, `State`, `Dir`, `Session ID (tail)`, `Last prompt (first 50 chars)`. Show ALL sessions returned. Sort by name. Include cold ones at the bottom marked `❄️ cold`.
- **`get`** — render as a key-value list. Include every field returned. Truncate `lastPrompt` to ~200 chars with `…` if longer.
- **`sibling`, `fork`** — confirm the new session: report its name, id (short), directory, and (for fork) parent session. One short paragraph.
- **`heal`, `remake`, `rename`** — confirm the action took, in one line. Include the target session's name.
- **Any error** — surface the error message verbatim in code-fence format. Do not paraphrase.

Available subcommands:
- `sibling [--name NAME]` — spawn a new session in the same directory (cold start, new conversation)
- `fork [--name NAME]` — fork this session into a new one that inherits the conversation up to now, then diverges
- `heal [--name NAME-OF-TARGET]` — send `/remote-control` to a sibling whose link dropped
- `remake [--name NAME-OF-TARGET]` — restart a session with `--resume` (defaults to self)
- `rename --name NEW_NAME` — rename this session
- `list` — list all sessions in the current VS Code window
- `get [--name NAME-OF-TARGET]` — print one session's full record

Self is targeted by default via `$VSCODE_CC_ID`. To target a sibling, pass `--name` or `--id`.
