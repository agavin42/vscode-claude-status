import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Terminal state enum
enum ClaudeState {
  Unknown = "unknown",
  Idle = "idle",
  Busy = "busy",
  Permissions = "perms",
  Waiting = "waiting", // Claude asked a question, waiting for user
  TimedOutPerms = "timedout-perms", // Permission request timed out
  TimedOutWaiting = "timedout-waiting", // Question timed out
}

// State display config
const STATE_CONFIG: Record<ClaudeState, { label: string; priority: number }> = {
  [ClaudeState.Unknown]: { label: "?", priority: 0 },
  [ClaudeState.Idle]: { label: "idle", priority: 1 },
  [ClaudeState.TimedOutWaiting]: { label: "TIMED OUT (Q)", priority: 2 },
  [ClaudeState.TimedOutPerms]: { label: "TIMED OUT (P)", priority: 3 },
  [ClaudeState.Waiting]: { label: "waiting", priority: 4 },
  [ClaudeState.Busy]: { label: "busy", priority: 5 },
  [ClaudeState.Permissions]: { label: "PERMS", priority: 6 },
};

// State file directory (shared with hook script)
const STATE_DIR = path.join(os.tmpdir(), "claude-code-status");

// Tracked terminal info
interface TrackedTerminal {
  terminal: vscode.Terminal;
  ccId: string;
  stateFile: string;
  state: ClaudeState;
  pollInterval?: NodeJS.Timeout;
  permsEnteredAt?: number; // Timestamp when entered PERMS state
  lastPrompt?: string; // Last user prompt (from hook)
  customName?: string; // User-assigned name
  displayName?: string; // Auto-generated display name (e.g. s_17_34_04)
  hasUserInput: boolean; // True after first UserPromptSubmit (ignore startup BUSY until then)
}

// Maintain ordered list of terminal IDs for stable ordering
let terminalOrder: string[] = [];

// TreeView provider for Claude terminals with drag-drop support
class ClaudeTerminalsProvider
  implements
    vscode.TreeDataProvider<TrackedTerminal>,
    vscode.TreeDragAndDropController<TrackedTerminal>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TrackedTerminal | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Drag and drop support
  readonly dropMimeTypes = ["application/vnd.code.tree.claudeterminals"];
  readonly dragMimeTypes = ["application/vnd.code.tree.claudeterminals"];

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  handleDrag(
    source: readonly TrackedTerminal[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    dataTransfer.set(
      "application/vnd.code.tree.claudeterminals",
      new vscode.DataTransferItem(source.map((t) => t.ccId)),
    );
  }

  handleDrop(
    target: TrackedTerminal | undefined,
    dataTransfer: vscode.DataTransfer,
  ): void {
    const transferItem = dataTransfer.get(
      "application/vnd.code.tree.claudeterminals",
    );
    if (!transferItem) return;

    const draggedIds: string[] = transferItem.value;
    if (!draggedIds || draggedIds.length === 0) return;

    const draggedId = draggedIds[0];
    const targetId = target?.ccId;

    // Remove dragged item from current position
    terminalOrder = terminalOrder.filter((id) => id !== draggedId);

    // Insert at new position
    if (targetId) {
      const targetIndex = terminalOrder.indexOf(targetId);
      if (targetIndex >= 0) {
        terminalOrder.splice(targetIndex, 0, draggedId);
      } else {
        terminalOrder.push(draggedId);
      }
    } else {
      // Dropped at end
      terminalOrder.push(draggedId);
    }

    this.refresh();
  }

  getTreeItem(terminal: TrackedTerminal): vscode.TreeItem {
    const label = terminal.customName || terminal.displayName || `Claude ${terminal.ccId.slice(-6)}`;

    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
    );

    // Set icon and colored state prefix based on state
    let statePrefix = "";
    switch (terminal.state) {
      case ClaudeState.Permissions:
        item.iconPath = new vscode.ThemeIcon(
          "alert",
          new vscode.ThemeColor("errorForeground"),
        );
        statePrefix = "🔴 PERMS";
        break;
      case ClaudeState.TimedOutPerms:
        item.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("editorWarning.foreground"),
        );
        statePrefix = "🟠 TIMED OUT (P)";
        break;
      case ClaudeState.TimedOutWaiting:
        item.iconPath = new vscode.ThemeIcon(
          "warning",
          new vscode.ThemeColor("editorWarning.foreground"),
        );
        statePrefix = "🟠 TIMED OUT (Q)";
        break;
      case ClaudeState.Busy:
        item.iconPath = new vscode.ThemeIcon(
          "sync~spin",
          new vscode.ThemeColor("warningForeground"),
        );
        statePrefix = "🟡 BUSY";
        break;
      case ClaudeState.Waiting:
        item.iconPath = new vscode.ThemeIcon(
          "comment-discussion",
          new vscode.ThemeColor("notificationsInfoIcon.foreground"),
        );
        statePrefix = "🔵 WAITING";
        break;
      case ClaudeState.Idle:
        item.iconPath = new vscode.ThemeIcon(
          "circle-outline",
          new vscode.ThemeColor("testing.iconPassed"),
        );
        statePrefix = "🟢 idle";
        break;
      default:
        item.iconPath = new vscode.ThemeIcon("question");
        statePrefix = "⚪ ?";
    }

    // Show state and last prompt as description
    const promptPreview = terminal.lastPrompt
      ? terminal.lastPrompt.slice(0, 50) +
        (terminal.lastPrompt.length > 50 ? "..." : "")
      : "";
    item.description = `${statePrefix}${promptPreview ? " · " + promptPreview : ""}`;

    // Tooltip with full info
    item.tooltip = new vscode.MarkdownString();
    item.tooltip.appendMarkdown(`**State:** ${statePrefix}\n\n`);
    if (terminal.lastPrompt) {
      item.tooltip.appendMarkdown(
        `**Last prompt:** ${terminal.lastPrompt}\n\n`,
      );
    }
    item.tooltip.appendMarkdown(`*Click to focus terminal*`);

    // Click to focus terminal
    item.command = {
      command: "claudeCodeStatus.focusTerminal",
      title: "Focus Terminal",
      arguments: [terminal],
    };

    // Context value for context menu
    item.contextValue =
      terminal.state === ClaudeState.Permissions
        ? "terminal-perms"
        : "terminal";

    return item;
  }

  getChildren(): TrackedTerminal[] {
    // Use custom order if set, otherwise creation order
    const allTerminals = Array.from(trackedTerminals.values());

    // Add any new terminals not in order list
    for (const t of allTerminals) {
      if (!terminalOrder.includes(t.ccId)) {
        terminalOrder.push(t.ccId);
      }
    }

    // Remove any terminals that no longer exist
    terminalOrder = terminalOrder.filter((id) => trackedTerminals.has(id));

    // Return in order
    return terminalOrder
      .map((id) => trackedTerminals.get(id))
      .filter((t): t is TrackedTerminal => t !== undefined);
  }
}

let claudeTerminalsProvider: ClaudeTerminalsProvider;

const trackedTerminals: Map<string, TrackedTerminal> = new Map();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

function log(msg: string) {
  const debug = vscode.workspace
    .getConfiguration("claudeCodeStatus")
    .get("debug");
  if (debug) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }
}

// Persisted state for surviving reloads
interface PersistedTerminal {
  ccId: string;
  customName?: string;
  displayName?: string;
}

function saveState() {
  const persisted: PersistedTerminal[] = Array.from(
    trackedTerminals.values(),
  ).map((t) => ({
    ccId: t.ccId,
    customName: t.customName,
    displayName: t.displayName,
  }));
  extensionContext.workspaceState.update("trackedTerminals", persisted);
  extensionContext.workspaceState.update("terminalOrder", terminalOrder);
  log(`Saved state: ${persisted.length} terminals`);
}

function restoreState() {
  const persisted = extensionContext.workspaceState.get<PersistedTerminal[]>(
    "trackedTerminals",
    [],
  );
  const savedOrder = extensionContext.workspaceState.get<string[]>(
    "terminalOrder",
    [],
  );

  if (persisted.length === 0) {
    log("No saved state to restore");
    return;
  }

  log(`Restoring state: ${persisted.length} terminals`);
  log(`Persisted ccIds: ${persisted.map((p) => p.ccId).join(", ")}`);
  log(
    `Existing terminals: ${vscode.window.terminals.map((t) => t.name).join(", ")}`,
  );

  // Build a map of ccId -> persisted data
  const persistedMap = new Map(persisted.map((p) => [p.ccId, p]));

  // Try to match existing terminals by name (which contains ccId)
  for (const terminal of vscode.window.terminals) {
    // Look for ccId pattern in terminal name: "CC: state [ccId]" or just check if name contains any known ccId
    for (const [ccId, data] of persistedMap) {
      const shortId = ccId.slice(-6);
      if (terminal.name.includes(shortId) || terminal.name.includes(ccId)) {
        const stateFile = path.join(STATE_DIR, `${ccId}.state`);

        // Only restore if state file still exists
        if (fs.existsSync(stateFile)) {
          // Reset state file to IDLE - any stale BUSY from before reload is meaningless
          try {
            fs.writeFileSync(stateFile, "IDLE\n");
          } catch (e) {
            // Ignore write errors
          }
          const tracked: TrackedTerminal = {
            terminal,
            ccId,
            stateFile,
            state: ClaudeState.Idle,
            customName: data.customName,
            displayName: data.displayName,
            hasUserInput: true, // Restored terminals have already had user input
          };
          trackedTerminals.set(ccId, tracked);
          watchStateFile(tracked);
          persistedMap.delete(ccId);
          log(`Restored terminal ${ccId} -> "${terminal.name}"`);
          break;
        }
      }
    }
  }

  // Fallback: if we still have unmatched persisted terminals and untracked CC: terminals,
  // try to match them by state file existence
  if (persistedMap.size > 0) {
    log(`Fallback matching: ${persistedMap.size} unmatched persisted`);
    const unmatchedTerminals = vscode.window.terminals.filter(
      (t) =>
        t.name.startsWith("CC:") &&
        !Array.from(trackedTerminals.values()).some(
          (tracked) => tracked.terminal === t,
        ),
    );
    log(
      `Unmatched CC: terminals: ${unmatchedTerminals.map((t) => t.name).join(", ") || "none"}`,
    );

    for (const terminal of unmatchedTerminals) {
      for (const [ccId, data] of persistedMap) {
        const stateFile = path.join(STATE_DIR, `${ccId}.state`);
        log(
          `Checking state file: ${stateFile} exists=${fs.existsSync(stateFile)}`,
        );
        if (fs.existsSync(stateFile)) {
          // Reset state file to IDLE - any stale BUSY from before reload is meaningless
          try {
            fs.writeFileSync(stateFile, "IDLE\n");
          } catch (e) {
            // Ignore write errors
          }
          const tracked: TrackedTerminal = {
            terminal,
            ccId,
            stateFile,
            state: ClaudeState.Idle,
            customName: data.customName,
            displayName: data.displayName,
            hasUserInput: true,
          };
          trackedTerminals.set(ccId, tracked);
          watchStateFile(tracked);
          persistedMap.delete(ccId);
          log(
            `Restored terminal ${ccId} -> "${terminal.name}" (fallback match)`,
          );
          break;
        }
      }
    }
  }

  // Restore order, filtering out any that weren't restored
  terminalOrder = savedOrder.filter((id) => trackedTerminals.has(id));

  updateStatusBar();
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function parseStateFile(filePath: string): ClaudeState {
  try {
    if (!fs.existsSync(filePath)) {
      return ClaudeState.Unknown;
    }
    const content = fs.readFileSync(filePath, "utf-8").trim().toUpperCase();

    // Check TIMEDOUT states first (they contain PERMS/WAITING substrings)
    if (content.includes("TIMEDOUT-PERMS")) {
      return ClaudeState.TimedOutPerms;
    } else if (content.includes("TIMEDOUT-WAITING")) {
      return ClaudeState.TimedOutWaiting;
    } else if (content.includes("PERMS")) {
      return ClaudeState.Permissions;
    } else if (content.includes("WAITING")) {
      return ClaudeState.Waiting;
    } else if (content.includes("BUSY")) {
      return ClaudeState.Busy;
    } else if (content.includes("IDLE")) {
      return ClaudeState.Idle;
    }
    return ClaudeState.Unknown;
  } catch (e) {
    return ClaudeState.Unknown;
  }
}

function updateStatusBar(): void {
  // Refresh tree view
  if (claudeTerminalsProvider) {
    claudeTerminalsProvider.refresh();
  }

  // Guard against early calls before statusBarItem is created
  if (!statusBarItem) {
    return;
  }

  const terminals = Array.from(trackedTerminals.values());

  if (terminals.length === 0) {
    statusBarItem.hide();
    return;
  }

  const stateCounts: Record<string, number> = {};
  for (const t of terminals) {
    const config = STATE_CONFIG[t.state];
    stateCounts[config.label] = (stateCounts[config.label] || 0) + 1;
  }

  const parts = Object.entries(stateCounts).map(([label, count]) =>
    count > 1 ? `${label}(${count})` : label,
  );

  const hasPerms = terminals.some((t) => t.state === ClaudeState.Permissions);
  const hasBusy = terminals.some((t) => t.state === ClaudeState.Busy);

  if (hasPerms) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    statusBarItem.color = new vscode.ThemeColor(
      "statusBarItem.errorForeground",
    );
  } else if (hasBusy) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    statusBarItem.color = new vscode.ThemeColor(
      "statusBarItem.warningForeground",
    );
  } else {
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = undefined;
  }

  statusBarItem.text = `$(terminal) CC: ${parts.join(", ")}`;
  statusBarItem.tooltip = `Claude Code: ${terminals.length} terminal(s)\nClick to show`;
  statusBarItem.show();
}

function readPromptFile(stateFile: string): string | undefined {
  const promptFile = stateFile.replace(".state", ".prompt");
  try {
    if (fs.existsSync(promptFile)) {
      return fs.readFileSync(promptFile, "utf-8").trim();
    }
  } catch (e) {
    // Ignore read errors
  }
  return undefined;
}

function watchStateFile(tracked: TrackedTerminal) {
  // Poll the state file for changes
  const pollInterval = setInterval(() => {
    if (!trackedTerminals.has(tracked.ccId)) {
      clearInterval(pollInterval);
      return;
    }

    const newState = parseStateFile(tracked.stateFile);
    const newPrompt = readPromptFile(tracked.stateFile);
    const now = Date.now();

    // Update prompt if changed - this also signals user has typed something
    if (newPrompt && newPrompt !== tracked.lastPrompt) {
      tracked.lastPrompt = newPrompt;
      tracked.hasUserInput = true;
    }

    // Handle PERMS/WAITING timeout - since Claude hooks don't always fire on dismiss,
    // we auto-transition to TIMED OUT after a configurable timeout
    if (
      tracked.state === ClaudeState.Permissions ||
      tracked.state === ClaudeState.Waiting
    ) {
      const timeoutSeconds = vscode.workspace
        .getConfiguration("claudeCodeStatus")
        .get<number>("permsTimeout", 60);
      if (
        tracked.permsEnteredAt &&
        now - tracked.permsEnteredAt > timeoutSeconds * 1000
      ) {
        const wasPerms = tracked.state === ClaudeState.Permissions;
        const newState = wasPerms
          ? ClaudeState.TimedOutPerms
          : ClaudeState.TimedOutWaiting;
        const stateFile = wasPerms ? "TIMEDOUT-PERMS" : "TIMEDOUT-WAITING";

        log(
          `${tracked.state} timeout for ${tracked.ccId} after ${timeoutSeconds}s, marking ${stateFile}`,
        );
        tracked.state = newState;
        tracked.permsEnteredAt = undefined;
        // Write state to file so it stays consistent
        try {
          fs.writeFileSync(tracked.stateFile, `${stateFile}\n`);
        } catch (e) {
          // Ignore write errors
        }
        updateStatusBar();
        return;
      }
    }

    if (newState !== tracked.state) {
      // Ignore BUSY until user has actually typed something
      // Claude runs startup tools (git status, Glob, etc.) which is just noise
      if (!tracked.hasUserInput && newState === ClaudeState.Busy) {
        log(`Ignoring BUSY before user input for ${tracked.ccId}`);
        return;
      }

      log(`State change for ${tracked.ccId}: ${tracked.state} -> ${newState}`);

      // Track when we enter PERMS or WAITING state (both need timeout tracking)
      if (
        newState === ClaudeState.Permissions ||
        newState === ClaudeState.Waiting
      ) {
        tracked.permsEnteredAt = now;
      } else {
        tracked.permsEnteredAt = undefined;
      }

      tracked.state = newState;
      updateStatusBar();
    }
  }, 100); // Poll every 100ms for responsiveness

  tracked.pollInterval = pollInterval;
}

function generateCcId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function adoptTerminal(terminal: vscode.Terminal): TrackedTerminal {
  ensureStateDir();

  const ccId = generateCcId();
  const stateFile = path.join(STATE_DIR, `${ccId}.state`);

  // Write initial state as unknown (we don't know Claude's current state)
  fs.writeFileSync(stateFile, "IDLE\n");

  // Inject the env var into the terminal
  // This sets it for future commands in this shell session
  terminal.sendText(`export VSCODE_CC_ID=${ccId}`, true);

  const tracked: TrackedTerminal = {
    terminal,
    ccId,
    stateFile,
    state: ClaudeState.Idle,
    hasUserInput: false,
  };

  trackedTerminals.set(ccId, tracked);
  watchStateFile(tracked);
  updateStatusBar();
  saveState();

  log(`Adopted terminal "${terminal.name}" with VSCODE_CC_ID=${ccId}`);
  vscode.window.showInformationMessage(
    `Terminal adopted. Future Claude hook events will now be tracked.`,
  );

  terminal.show();
  return tracked;
}

function createClaudeTerminal(
  args: string[] = [],
): TrackedTerminal | undefined {
  ensureStateDir();

  const ccId = generateCcId();
  const stateFile = path.join(STATE_DIR, `${ccId}.state`);

  // Write initial state
  fs.writeFileSync(stateFile, "IDLE\n");

  const workspaceFolder =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

  // Build command: configurable program + explicit args + user-configured extra args
  const config = vscode.workspace.getConfiguration("claudeCodeStatus");
  const command = config.get<string>("command", "claude");
  const extraArgs = config.get<string[]>("extraArgs", []);
  const remoteControl = config.get<boolean>("remoteControl", false);

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const sessionName = `s:${hh}:${mm}:${ss}`;
  const shortId = sessionName;

  const allArgs = [...args, ...extraArgs];
  if (remoteControl) {
    allArgs.push("--remote-control");
  }
  // Build command string, quoting the session name separately
  let claudeArgs = allArgs.length > 0 ? " " + allArgs.join(" ") : "";
  if (remoteControl) {
    claudeArgs += ` -n "${sessionName}"`;
  }
  const terminal = vscode.window.createTerminal({
    name: `CC: idle [${shortId}]`,
    cwd: workspaceFolder,
    env: {
      VSCODE_CC_ID: ccId, // This is read by the hook script
    },
  });

  const tracked: TrackedTerminal = {
    terminal,
    ccId,
    stateFile,
    state: ClaudeState.Idle,
    hasUserInput: false,
    displayName: sessionName,
  };

  trackedTerminals.set(ccId, tracked);
  watchStateFile(tracked);
  saveState();

  // Send the command to run claude
  terminal.sendText(`${command}${claudeArgs}`);

  log(`Created terminal with VSCODE_CC_ID=${ccId}`);

  return tracked;
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Claude Code Status");

  const enabled = vscode.workspace
    .getConfiguration("claudeCodeStatus")
    .get("enabled");
  if (!enabled) {
    outputChannel.appendLine("Claude Code Status is disabled");
    return;
  }

  outputChannel.appendLine("Claude Code Status activated (hook mode)");
  outputChannel.appendLine(`State directory: ${STATE_DIR}`);
  outputChannel.appendLine(
    "Make sure Claude Code hooks are configured in ~/.claude/settings.json",
  );

  try {
    ensureStateDir();

    // Restore terminals from previous session - delay to let VS Code populate terminal names
    // Retry a few times since terminal names may take a while to populate
    const tryRestore = (attempt: number) => {
      try {
        const terminalNames = vscode.window.terminals
          .map((t) => t.name)
          .filter((n) => n);
        if (terminalNames.length === 0 && attempt < 5) {
          log(`Attempt ${attempt}: terminal names not ready, retrying...`);
          setTimeout(() => tryRestore(attempt + 1), 500);
          return;
        }
        restoreState();
      } catch (e) {
        outputChannel.appendLine(`Error during restore: ${e}`);
      }
    };
    setTimeout(() => tryRestore(1), 500);
  } catch (e) {
    outputChannel.appendLine(`Error during initialization: ${e}`);
  }

  // Create TreeView for Claude terminals
  claudeTerminalsProvider = new ClaudeTerminalsProvider();
  const treeView = vscode.window.createTreeView("claudeTerminals", {
    treeDataProvider: claudeTerminalsProvider,
    showCollapseAll: false,
    dragAndDropController: claudeTerminalsProvider,
    canSelectMany: false,
  });
  context.subscriptions.push(treeView);

  // Focus terminal command (for tree item click)
  const focusTerminalCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.focusTerminal",
    (tracked: TrackedTerminal) => {
      tracked.terminal.show();
    },
  );
  context.subscriptions.push(focusTerminalCmd);

  // Close terminal command
  const closeTerminalCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.closeTerminal",
    (tracked: TrackedTerminal) => {
      tracked.terminal.dispose();
      // Cleanup happens via onDidCloseTerminal handler
    },
  );
  context.subscriptions.push(closeTerminalCmd);

  // Rename terminal command
  const renameTerminalCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.renameTerminal",
    async (tracked: TrackedTerminal) => {
      const name = await vscode.window.showInputBox({
        prompt: "Enter a name for this Claude terminal",
        value: tracked.customName || "",
      });
      if (name !== undefined) {
        tracked.customName = name || undefined;
        // If remote control is on, rename the Claude session to match
        if (
          name &&
          vscode.workspace
            .getConfiguration("claudeCodeStatus")
            .get<boolean>("remoteControl", false)
        ) {
          tracked.terminal.sendText(`/rename ${name}`);
        }
        claudeTerminalsProvider.refresh();
        saveState();
      }
    },
  );
  context.subscriptions.push(renameTerminalCmd);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "claudeCodeStatus.showTerminals";
  context.subscriptions.push(statusBarItem);

  // New Claude Code terminal
  const createTerminalCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.newTerminal",
    () => {
      const tracked = createClaudeTerminal();
      if (tracked) {
        tracked.terminal.show();
        updateStatusBar();
      }
    },
  );
  context.subscriptions.push(createTerminalCmd);

  // New terminal with --resume
  const resumeTerminalCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.newTerminalResume",
    () => {
      const tracked = createClaudeTerminal(["--resume"]);
      if (tracked) {
        tracked.terminal.show();
        updateStatusBar();
      }
    },
  );
  context.subscriptions.push(resumeTerminalCmd);

  // Terminal picker - shows ALL terminals, tracked ones have state info
  const showTerminalsCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.showTerminals",
    async () => {
      const allTerminals = vscode.window.terminals;

      if (allTerminals.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "No terminals open. Create a Claude Code terminal?",
          "New Terminal",
          "New (Resume)",
        );
        if (choice === "New Terminal") {
          vscode.commands.executeCommand("claudeCodeStatus.newTerminal");
        } else if (choice === "New (Resume)") {
          vscode.commands.executeCommand("claudeCodeStatus.newTerminalResume");
        }
        return;
      }

      // Build items for all terminals
      interface TerminalPickItem extends vscode.QuickPickItem {
        terminal?: vscode.Terminal;
        tracked?: TrackedTerminal;
        isAdoptable: boolean;
        isNewTerminal?: boolean;
      }

      const items: TerminalPickItem[] = [];

      // Add "New Terminal" options at the top
      items.push({
        label: "$(plus) New Claude Terminal",
        description: "Create new tracked terminal",
        isAdoptable: false,
        isNewTerminal: true,
      });

      // Add existing terminals
      allTerminals.forEach((terminal) => {
        // Check if this terminal is tracked
        const tracked = Array.from(trackedTerminals.values()).find(
          (t) => t.terminal === terminal,
        );

        if (tracked) {
          const config = STATE_CONFIG[tracked.state];
          const needsAttention = tracked.state === ClaudeState.Permissions;
          items.push({
            label: `${needsAttention ? "$(alert) " : "$(terminal) "}${terminal.name}`,
            description: config.label,
            detail: needsAttention ? "Needs attention!" : undefined,
            terminal,
            tracked,
            isAdoptable: false,
          });
        } else {
          // Untracked terminal - might be Claude, might not
          items.push({
            label: `$(terminal) ${terminal.name}`,
            description: "untracked",
            detail: "Select to adopt as Claude terminal",
            terminal,
            isAdoptable: true,
          });
        }
      });

      // Sort: New Terminal first, then PERMS, then tracked by priority, then untracked
      items.sort((a, b) => {
        // New Terminal always first
        if (a.isNewTerminal) return -1;
        if (b.isNewTerminal) return 1;
        // Then by state priority
        const aPriority = a.tracked
          ? STATE_CONFIG[a.tracked.state].priority
          : -1;
        const bPriority = b.tracked
          ? STATE_CONFIG[b.tracked.state].priority
          : -1;
        return bPriority - aPriority;
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a terminal (untracked terminals can be adopted)",
      });

      if (selected) {
        if (selected.isNewTerminal) {
          // Create new tracked terminal
          vscode.commands.executeCommand("claudeCodeStatus.newTerminal");
        } else if (selected.isAdoptable && selected.terminal) {
          // Offer to adopt this terminal
          const adopt = await vscode.window.showInformationMessage(
            `Adopt "${selected.terminal.name}" as a Claude Code terminal?`,
            "Adopt",
            "Just Show",
          );
          if (adopt === "Adopt") {
            adoptTerminal(selected.terminal);
          } else {
            selected.terminal.show();
          }
        } else if (selected.terminal) {
          selected.terminal.show();
        }
      }
    },
  );
  context.subscriptions.push(showTerminalsCmd);

  // Show setup instructions
  const showSetupCmd = vscode.commands.registerCommand(
    "claudeCodeStatus.showSetup",
    () => {
      outputChannel.show();
      outputChannel.appendLine("\n=== SETUP INSTRUCTIONS ===");
      outputChannel.appendLine("Add this to your ~/.claude/settings.json:");
      outputChannel.appendLine(
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [{ type: "command", command: getHookScriptPath() }],
              PostToolUse: [{ type: "command", command: getHookScriptPath() }],
              PermissionRequest: [
                { type: "command", command: getHookScriptPath() },
              ],
              Stop: [{ type: "command", command: getHookScriptPath() }],
              UserPromptSubmit: [
                { type: "command", command: getHookScriptPath() },
              ],
              SessionStart: [{ type: "command", command: getHookScriptPath() }],
              SessionEnd: [{ type: "command", command: getHookScriptPath() }],
            },
          },
          null,
          2,
        ),
      );
    },
  );
  context.subscriptions.push(showSetupCmd);

  // Terminal lifecycle
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      // Find and remove tracked terminal
      for (const [key, tracked] of trackedTerminals.entries()) {
        if (tracked.terminal === terminal) {
          // Cleanup
          if (tracked.pollInterval) {
            clearInterval(tracked.pollInterval);
          }
          try {
            fs.unlinkSync(tracked.stateFile);
          } catch (e) {
            // Ignore cleanup errors
          }
          trackedTerminals.delete(key);
          log(`Removed terminal: ${key}`);
          updateStatusBar();
          saveState();
          break;
        }
      }
    }),
  );

  outputChannel.appendLine("All commands registered successfully");
}

function getHookScriptPath(): string {
  // Return the path to the hook script
  // Users should update this to match their installation
  return path.join(
    os.homedir(),
    "src",
    "vscode-claude-status",
    "scripts",
    "cc-status-hook.sh",
  );
}

export function deactivate() {
  // Stop polling but DON'T delete state files - they're needed for restore after reload
  for (const tracked of trackedTerminals.values()) {
    if (tracked.pollInterval) {
      clearInterval(tracked.pollInterval);
    }
  }
}
