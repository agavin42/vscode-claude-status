import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import {
  GithubFacts,
  PrCheckpoint,
  PrStatus,
  SessionPr,
  SessionStatus,
} from "./pr/types";
import { isTerminalForPolling } from "./pr/status";
import {
  DetectedPr,
  extractPrUrls,
  scanTranscriptForCreatedPrs,
} from "./pr/detect";
import { GH_PR_VIEW_FIELDS, mapGhJsonToFacts } from "./pr/github";
import {
  applyGithubFactsToMap,
  GithubFactsUpdate,
  upsertPrCheckpoint,
} from "./pr/apply";

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

// Persisted Session record — what survives across VSC reloads
interface PersistedSession {
  id: string; // ccId (cc-{ts}-{rand}), stable for lifetime of session
  displayName: string; // "s:HH:MM:SS" generated at creation
  customName?: string; // user-assigned via rename
  directory: string; // absolute cwd; auto-updated from hook .cwd
  claudeSessionId?: string; // Claude Code's UUID (pre-generated, refreshed from hook)
  claudeVersion?: string; // from hook .version
  parentSessionId?: string; // for forked sessions (Phase 7)
  parentDisplayName?: string;
  createdAt: number; // epoch ms
  sessionStatus?: SessionStatus; // manual lifecycle phase; shown only when no PRs
  // Snapshot of the last transcript path the hook reported. Persisted (unlike
  // the transient transcriptPath) so the retroactive PR scanner can reach a
  // cold session's transcript without re-deriving the path from the launch cwd.
  lastTranscriptPath?: string;
}

// Runtime Session — persistent fields plus transient state. The terminal field
// is optional: undefined = cold. Phase 3 surfaces cold sessions in the tree;
// Phase 4 keeps them across reload.
interface Session extends PersistedSession {
  terminal?: vscode.Terminal;
  state: ClaudeState;
  lastPrompt?: string;
  permsEnteredAt?: number; // ms timestamp when entered PERMS/WAITING
  pollInterval?: NodeJS.Timeout;
  hasUserInput: boolean; // suppresses startup-BUSY noise
  transcriptPath?: string; // from hook .tx (transient — re-derived each run)
  subagentCount: number; // from hook .subagents
  // Live cwd from hook. NOT persisted. session.directory stays as the
  // original launch cwd (where the transcript lives — needed for --resume).
  // currentCwd tracks where Claude is actually operating right now, for
  // display purposes only.
  currentCwd?: string;
  // Set true for the brief window during remake() so handleTerminalClose
  // knows the old-terminal dispose belongs to a remake, not a suspend.
  _remaking?: boolean;
}

// Legacy persisted shape — what shipped before Phase 2. Used only by the
// migration path on restore; future writes always use PersistedSession.
interface LegacyPersistedTerminal {
  ccId: string;
  customName?: string;
  displayName?: string;
}

// SessionStore — single owner of the session map + order. Every mutation
// saves atomically so the on-disk shape never diverges from in-memory state.
// Reads are pure (getChildren / all() never mutate).
class SessionStore {
  private sessions = new Map<string, Session>();
  private order: string[] = [];
  // PR records keyed by owning ccId. Source of truth (persisted); the
  // .prs.log / .prs.scanned sidecars are reconstructable caches.
  private prs = new Map<string, SessionPr[]>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  // ----- queries (pure) -----

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  all(): Session[] {
    return this.order
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  warmOnly(): Session[] {
    return this.all().filter((s) => s.terminal !== undefined);
  }

  // ----- mutations (always save) -----

  create(
    args: {
      resume?: boolean;
      dir?: string;
      forkFrom?: string;
      customName?: string;
      parentDisplayName?: string;
    } = {},
  ): Session | undefined {
    ensureStateDir();

    const ccId = generateCcId();
    const stateFile = path.join(STATE_DIR, `${ccId}.state`);

    // Pre-generate the Claude session id (UUID). Passing --session-id at
    // launch lets us know it before the first hook event fires. The hook
    // keeps refreshing the .session sidecar so fork/compact-time id changes
    // are followed automatically.
    const claudeSessionId = crypto.randomUUID();

    fs.writeFileSync(stateFile, "IDLE\n");

    const workspaceFolder =
      args.dir ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      os.homedir();

    const config = vscode.workspace.getConfiguration("claudeCodeStatus");
    const command = config.get<string>("command", "claude");
    const extraArgs = config.get<string[]>("extraArgs", []);
    const remoteControl = config.get<boolean>("remoteControl", false);

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const displayName = `s:${hh}:${mm}:${ss}`;

    // If a customName was supplied (sibling/fork pre-named), pass it to
    // claude via -n at startup so the Claude Code app sees the right name
    // from the first frame — no /rename round-trip needed.
    const sessionName = args.customName || displayName;

    // Build launch command. --session-id only applies on cold start (no
    // --resume); fork takes precedence over --session-id because
    // --fork-session generates its own new id.
    const launchArgs: string[] = [];
    if (args.forkFrom) {
      launchArgs.push("--resume", args.forkFrom, "--fork-session");
    } else if (args.resume) {
      launchArgs.push("--resume");
    } else {
      launchArgs.push("--session-id", claudeSessionId);
    }
    launchArgs.push(...extraArgs);
    if (remoteControl) {
      launchArgs.push("--remote-control", "-n", `"${sessionName}"`);
    }

    const terminal = vscode.window.createTerminal({
      name: `CC: idle [${displayName}]`,
      cwd: workspaceFolder,
      env: { VSCODE_CC_ID: ccId },
    });

    const session: Session = {
      id: ccId,
      displayName,
      customName: args.customName,
      directory: workspaceFolder,
      claudeSessionId,
      parentSessionId: args.forkFrom,
      parentDisplayName: args.parentDisplayName,
      createdAt: Date.now(),
      terminal,
      state: ClaudeState.Idle,
      hasUserInput: false,
      subagentCount: 0,
    };

    this.sessions.set(ccId, session);
    this.order.push(ccId);
    this.watchSession(session);
    this.save();
    this.emitter.fire();

    terminal.sendText(`${command} ${launchArgs.join(" ")}`);

    log(
      `Created session ${ccId} (claudeSessionId=${claudeSessionId}, dir=${workspaceFolder}, name=${sessionName}, forkFrom=${args.forkFrom ?? "none"})`,
    );
    return session;
  }

  // New sibling — fresh Claude conversation in the source session's directory.
  // Allowed on warm AND cold sources (directory is on the persisted record).
  newSibling(sourceId: string, name?: string): Session | undefined {
    const src = this.sessions.get(sourceId);
    if (!src) return undefined;
    return this.create({
      dir: src.directory,
      customName: name,
    });
  }

  // Fork — new session that inherits the source's conversation via
  // `claude --resume <id> --fork-session`. Source untouched.
  fork(sourceId: string, name?: string): Session | undefined {
    const src = this.sessions.get(sourceId);
    if (!src) return undefined;
    if (!src.claudeSessionId) {
      vscode.window.showWarningMessage(
        `Cannot fork "${src.customName || src.displayName}" — no Claude session id captured yet. Type something in it first.`,
      );
      return undefined;
    }
    return this.create({
      dir: src.directory,
      forkFrom: src.claudeSessionId,
      customName: name,
      parentDisplayName: src.customName || src.displayName,
    });
  }

  // Reconnect remote-control — sends /remote-control to a warm terminal.
  // No-op for cold sessions (nothing to send to).
  reconnectRemoteControl(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.terminal) return;
    s.terminal.sendText("/remote-control");
    log(`Sent /remote-control to ${id}`);
  }

  adopt(terminal: vscode.Terminal): Session {
    ensureStateDir();

    const ccId = generateCcId();
    const stateFile = path.join(STATE_DIR, `${ccId}.state`);
    fs.writeFileSync(stateFile, "IDLE\n");

    // No --session-id for adoption (the already-running claude has its own
    // id); rely on the hook to populate .session on next event.
    terminal.sendText(`export VSCODE_CC_ID=${ccId}`, true);

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const displayName = `s:${hh}:${mm}:${ss}`;

    const session: Session = {
      id: ccId,
      displayName,
      directory:
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
      createdAt: Date.now(),
      terminal,
      state: ClaudeState.Idle,
      hasUserInput: false,
      subagentCount: 0,
    };

    this.sessions.set(ccId, session);
    this.order.push(ccId);
    this.watchSession(session);
    this.save();
    this.emitter.fire();

    log(`Adopted terminal "${terminal.name}" as session ${ccId}`);
    return session;
  }

  // Suspend — terminal dies, session record stays as cold. Reachable via the
  // inline pause button or right-click. Reversible via Remake.
  suspend(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.terminal) return; // already cold or unknown
    // The terminal dispose triggers handleTerminalClose, which (since
    // _remaking is not set) marks the session cold for us.
    s.terminal.dispose();
  }

  // Remake — recreate the terminal in the same directory, resume the same
  // Claude conversation, reuse the same ccId. Works on both warm and cold
  // sessions. Requires claudeSessionId; refuses if unknown.
  remake(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (!s.claudeSessionId) {
      vscode.window.showWarningMessage(
        `Cannot remake "${s.customName || s.displayName}" — no Claude session id captured yet. Type something in the session first so the hook populates it.`,
      );
      return;
    }

    ensureStateDir();
    const stateFile = path.join(STATE_DIR, `${s.id}.state`);

    // Flag for the close handler. Cleared after the new terminal is bound.
    s._remaking = true;

    // Stop the existing poll so it can't race with the new terminal's poll.
    this.stopWatching(s);

    // Dispose the old terminal (if any). The close handler runs async; it
    // sees _remaking and no-ops.
    if (s.terminal) {
      s.terminal.dispose();
    }

    // Reset transient sidecars. .session stays — --resume reads from the
    // existing transcript identified by claudeSessionId. .cwd / .tx will
    // be rewritten by the hook on first event.
    try {
      fs.writeFileSync(stateFile, "IDLE\n");
    } catch (e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(path.join(STATE_DIR, `${s.id}.prompt`));
    } catch (e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(path.join(STATE_DIR, `${s.id}.version`));
    } catch (e) {
      /* ignore */
    }

    // Reset runtime state — re-arm startup-BUSY suppression for the new claude.
    s.state = ClaudeState.Idle;
    s.lastPrompt = undefined;
    s.hasUserInput = false;
    s.permsEnteredAt = undefined;
    s.subagentCount = 0;
    s.transcriptPath = undefined;

    const config = vscode.workspace.getConfiguration("claudeCodeStatus");
    const command = config.get<string>("command", "claude");
    const extraArgs = config.get<string[]>("extraArgs", []);
    const remoteControl = config.get<boolean>("remoteControl", false);

    // Preserve the user-assigned name across remake. If the user previously
    // ran `/rename` on this session (via the panel rename), customName is
    // what the Claude Code app showed it as — use that for -n so the
    // resumed session keeps the same identity. Falls back to displayName
    // for sessions that were never renamed.
    const sessionName = s.customName || s.displayName;

    const launchArgs: string[] = ["--resume", s.claudeSessionId];
    launchArgs.push(...extraArgs);
    if (remoteControl) {
      launchArgs.push("--remote-control", "-n", `"${sessionName}"`);
    }

    const newTerminal = vscode.window.createTerminal({
      name: `CC: idle [${s.displayName}]`,
      cwd: s.directory,
      env: { VSCODE_CC_ID: s.id },
    });

    s.terminal = newTerminal;
    s._remaking = false;

    this.watchSession(s);
    this.save();
    this.emitter.fire();

    newTerminal.sendText(`${command} ${launchArgs.join(" ")}`);
    newTerminal.show();

    log(
      `Remade session ${s.id} (--resume ${s.claudeSessionId}, name=${sessionName}, dir=${s.directory})`,
    );
  }

  // Delete — destructive. Drops the session record and unlinks all sidecar
  // files. Caller (the command handler) shows the confirmation dialog;
  // the store assumes the caller already confirmed.
  delete(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.stopWatching(s);
    const terminal = s.terminal;
    // Remove from store BEFORE disposing the terminal — handleTerminalClose
    // looks up by terminal and will find nothing, no-op.
    this.sessions.delete(id);
    this.order = this.order.filter((x) => x !== id);
    // delete() is the ONLY purge point for PR data. markCold/SessionEnd
    // preserve it (a cold session still shows what it shipped).
    this.prs.delete(id);
    if (terminal) {
      terminal.dispose();
    }
    // Unlink every sidecar Phase 1 may have written, plus the PR caches.
    for (const ext of [
      "state",
      "session",
      "cwd",
      "tx",
      "version",
      "prompt",
      "subagents",
      "prs.log",
      "prs.scanned",
    ]) {
      try {
        fs.unlinkSync(path.join(STATE_DIR, `${id}.${ext}`));
      } catch (e) {
        /* ignore */
      }
    }
    this.save();
    this.emitter.fire();
    log(`Deleted session ${id}`);
  }

  update(id: string, patch: Partial<PersistedSession>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    Object.assign(s, patch);
    this.save();
    this.emitter.fire();
  }

  // ----- PR queries (pure) -----

  prsFor(id: string): SessionPr[] {
    return this.prs.get(id) ?? [];
  }

  // All PR records across sessions, paired with their owning ccId. Used by the
  // poller to select non-terminal PRs to refresh.
  allPrs(): { ccId: string; pr: SessionPr }[] {
    const out: { ccId: string; pr: SessionPr }[] = [];
    for (const [ccId, list] of this.prs) {
      for (const pr of list) out.push({ ccId, pr });
    }
    return out;
  }

  // ----- PR mutations (always save) -----

  setSessionStatus(id: string, status: SessionStatus | undefined): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.sessionStatus = status;
    this.save();
    this.emitter.fire();
  }

  // Insert a PR tied to a session if not already present (dedup by canonical
  // URL). Returns the record (existing or new).
  addPr(
    id: string,
    detected: DetectedPr,
    origin: "auto" | "manual",
  ): SessionPr | undefined {
    if (!this.sessions.has(id)) return undefined;
    const list = this.prs.get(id) ?? [];
    const existing = list.find((p) => p.url === detected.url);
    if (existing) return existing;
    const pr: SessionPr = {
      url: detected.url,
      repo: detected.repo,
      number: detected.number,
      sessionId: id,
      origin,
      checkpoint: PrCheckpoint.Drafting,
      addedAt: Date.now(),
    };
    list.push(pr);
    this.prs.set(id, list);
    this.save();
    this.emitter.fire();
    log(`Tied PR ${detected.url} to ${id} (${origin})`);
    return pr;
  }

  detachPr(id: string, url: string): void {
    const list = this.prs.get(id);
    if (!list) return;
    const next = list.filter((p) => p.url !== url);
    if (next.length === list.length) return;
    this.prs.set(id, next);
    this.save();
    this.emitter.fire();
    log(`Detached PR ${url} from ${id}`);
  }

  // Set a PR's checkpoint (+ optional shipit stage). Tolerantly creates the
  // record if the PR isn't tied yet — shipit may report a stage before the
  // create-hook detection has landed, and the stage shouldn't be lost.
  setPrCheckpoint(
    id: string,
    url: string,
    checkpoint: PrCheckpoint,
    stage?: number,
  ): SessionPr | undefined {
    if (!this.sessions.has(id)) return undefined;
    const pr = upsertPrCheckpoint(
      this.prs,
      id,
      url,
      checkpoint,
      stage,
      Date.now(),
    );
    if (!pr) return undefined;
    this.save();
    this.emitter.fire();
    log(
      `PR ${pr.url} checkpoint → ${checkpoint}${stage !== undefined ? ` (stage ${stage})` : ""}`,
    );
    return pr;
  }

  // Record who was asked to review this PR. Pass undefined/empty to clear.
  setPrReviewer(id: string, url: string, reviewer: string | undefined): void {
    const pr = this.prs.get(id)?.find((p) => p.url === url);
    if (!pr) return;
    pr.reviewer = reviewer && reviewer.trim() ? reviewer.trim() : undefined;
    this.save();
    this.emitter.fire();
  }

  // Pin (or clear) a PR's displayed status. undefined returns it to automatic
  // resolution. An invalid value is treated as a clear.
  setPrStatusOverride(
    id: string,
    url: string,
    status: PrStatus | undefined,
  ): void {
    const pr = this.prs.get(id)?.find((p) => p.url === url);
    if (!pr) return;
    const valid =
      status && (Object.values(PrStatus) as string[]).includes(status);
    pr.statusOverride = valid ? status : undefined;
    this.save();
    this.emitter.fire();
  }

  // Apply a batch of freshly-polled GitHub facts in ONE save + ONE fire. Each
  // update re-looks-up its PR by (ccId, url) so a record detached/mutated
  // mid-poll is dropped, not resurrected.
  applyGithubFacts(updates: GithubFactsUpdate[]): void {
    if (!applyGithubFactsToMap(this.prs, updates)) return;
    this.save();
    this.emitter.fire();
  }

  // Reconcile auto-detected PRs into the store for one session: drain the
  // forward-detection .prs.log and scan the transcript for created PRs. Dedups
  // against existing records. One save + fire if anything was added.
  reconcilePrs(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;

    const detected: DetectedPr[] = [];
    const logRaw = readSidecar(id, "prs.log");
    if (logRaw) detected.push(...extractPrUrls(logRaw));

    const txPath =
      s.lastTranscriptPath ||
      s.transcriptPath ||
      (s.claudeSessionId
        ? deriveTranscriptPath(s.directory, s.claudeSessionId)
        : undefined);
    if (txPath) detected.push(...this.scanTranscriptIfStale(id, txPath));

    if (detected.length === 0) return;

    const list = this.prs.get(id) ?? [];
    let added = false;
    for (const d of detected) {
      if (list.some((p) => p.url === d.url)) continue;
      list.push({
        url: d.url,
        repo: d.repo,
        number: d.number,
        sessionId: id,
        origin: "auto",
        checkpoint: PrCheckpoint.Drafting,
        addedAt: Date.now(),
      });
      added = true;
    }
    if (!added) return;
    this.prs.set(id, list);
    this.save();
    this.emitter.fire();
    log(`Reconciled PRs for ${id}: now ${list.length}`);
  }

  // Scan the transcript only when its (path, mtime) differs from the marker.
  // The marker is dropped on remake() so a resumed transcript re-scans.
  private scanTranscriptIfStale(id: string, txPath: string): DetectedPr[] {
    let mtime = 0;
    try {
      mtime = Math.floor(fs.statSync(txPath).mtimeMs);
    } catch (e) {
      return [];
    }
    const markerPath = path.join(STATE_DIR, `${id}.prs.scanned`);
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
        path?: string;
        mtime?: number;
      };
      if (m.path === txPath && m.mtime === mtime) return [];
    } catch (e) {
      /* no/invalid marker — scan */
    }
    let found: DetectedPr[] = [];
    try {
      found = scanTranscriptForCreatedPrs(fs.readFileSync(txPath, "utf-8"));
    } catch (e) {
      return [];
    }
    try {
      fs.writeFileSync(markerPath, JSON.stringify({ path: txPath, mtime }));
    } catch (e) {
      /* ignore */
    }
    return found;
  }

  // Reconcile every known session (dashboard open / low-freq timer).
  reconcileAllPrs(): void {
    for (const id of this.sessions.keys()) this.reconcilePrs(id);
  }

  // Fire the change event without a state mutation (e.g. the poller's
  // gh-unavailable banner).
  notifyChanged(): void {
    this.emitter.fire();
  }

  reorder(draggedId: string, targetId: string | undefined): void {
    this.order = this.order.filter((id) => id !== draggedId);
    if (targetId) {
      const targetIndex = this.order.indexOf(targetId);
      if (targetIndex >= 0) {
        this.order.splice(targetIndex, 0, draggedId);
      } else {
        this.order.push(draggedId);
      }
    } else {
      this.order.push(draggedId);
    }
    this.save();
    this.emitter.fire();
  }

  // ----- persistence -----

  save(): void {
    // Write both `id` (new shape) and `ccId` (legacy field name) so an
    // older extension binary can still parse this on rollback.
    const persisted = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      ccId: s.id,
      displayName: s.displayName,
      customName: s.customName,
      directory: s.directory,
      claudeSessionId: s.claudeSessionId,
      claudeVersion: s.claudeVersion,
      parentSessionId: s.parentSessionId,
      parentDisplayName: s.parentDisplayName,
      createdAt: s.createdAt,
      sessionStatus: s.sessionStatus,
      lastTranscriptPath: s.lastTranscriptPath,
    }));
    // PR records as a plain ccId→SessionPr[] record. An older binary on
    // rollback simply ignores this unknown key (no legacy mirror needed).
    const prsObj: Record<string, SessionPr[]> = {};
    for (const [ccId, list] of this.prs) {
      if (list.length > 0) prsObj[ccId] = list;
    }
    this.ctx.workspaceState.update("trackedTerminals", persisted);
    this.ctx.workspaceState.update("terminalOrder", this.order);
    this.ctx.workspaceState.update("sessionPrs", prsObj);
    log(
      `Saved state: ${persisted.length} sessions, order=${this.order.length}, prSessions=${Object.keys(prsObj).length}`,
    );
  }

  restore(): void {
    // Read both new and legacy shapes from the same key. We can tell which
    // we got by checking for the new "directory" field — legacy entries
    // don't have it.
    const persistedRaw = this.ctx.workspaceState.get<
      (PersistedSession | LegacyPersistedTerminal)[]
    >("trackedTerminals", []);
    const savedOrder = this.ctx.workspaceState.get<string[]>(
      "terminalOrder",
      [],
    );

    // PR records rehydrate independently of sessions.
    const prsObj = this.ctx.workspaceState.get<Record<string, SessionPr[]>>(
      "sessionPrs",
      {},
    );
    this.prs = new Map(Object.entries(prsObj));

    if (persistedRaw.length === 0) {
      log("No saved state to restore");
      return;
    }

    log(
      `Restoring state: ${persistedRaw.length} persisted entries, ${savedOrder.length} order entries`,
    );

    // Migrate any legacy entries up to the new shape. Sidecar files written
    // by Phase 1's hook may already carry session id, version — read them so
    // existing sessions get their fields populated immediately. Note:
    // sidecar .cwd is NO LONGER used to set .directory because directory is
    // supposed to be the immutable launch cwd, and sidecar tracks the live
    // cwd which may have drifted (worktree moves, etc.).
    const migrated: PersistedSession[] = persistedRaw.map((p) => {
      const ccId = "id" in p ? p.id : p.ccId;
      const sidecarSession = readSidecar(ccId, "session");
      const sidecarVersion = readSidecar(ccId, "version");

      if ("directory" in p) {
        // Already new shape. Auto-repair the historical drift bug where
        // hook .cwd overwrote session.directory whenever Claude `cd`'d
        // into a worktree, breaking --resume on Remake. If the stored
        // directory contains a `/.claude/worktrees/<name>` segment, strip
        // back to the project root.
        const repaired = repairWorktreeDrift(p.directory);
        if (repaired !== p.directory) {
          log(`Auto-repairing ${ccId} directory: ${p.directory} → ${repaired}`);
        }
        return {
          ...p,
          directory: repaired,
          claudeSessionId: sidecarSession || p.claudeSessionId,
          claudeVersion: sidecarVersion || p.claudeVersion,
        };
      }
      // Legacy entry — migrate up. Fill defaults for new fields.
      const sidecarCwd = readSidecar(ccId, "cwd");
      const seedDirectory =
        sidecarCwd ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        os.homedir();
      return {
        id: p.ccId,
        displayName: p.displayName || `s:${p.ccId.slice(-6)}`,
        customName: p.customName,
        directory: repairWorktreeDrift(seedDirectory),
        claudeSessionId: sidecarSession || undefined,
        claudeVersion: sidecarVersion || undefined,
        createdAt: Date.now(), // unknown for legacy — use now as a placeholder
      };
    });

    const persistedById = new Map<string, PersistedSession>();
    for (const p of migrated) {
      persistedById.set(p.id, p);
    }

    // Diagnostic: dump each terminal's name + whether its creationOptions
    // still carries our VSCODE_CC_ID env var after reload. This is how we
    // learn whether the env-var signal survives window reload.
    for (const t of vscode.window.terminals) {
      const opts = t.creationOptions as vscode.TerminalOptions;
      const envId = opts?.env
        ? (opts.env as Record<string, string>)["VSCODE_CC_ID"]
        : undefined;
      log(
        `  terminal "${t.name}" — creationOptions.env.VSCODE_CC_ID=${envId ?? "(none)"}`,
      );
    }

    const boundTerminals = new Set<vscode.Terminal>();

    // Pass 1 — match by VSCODE_CC_ID in creationOptions.env. This is the
    // robust signal: it survives Claude retitling the terminal (which
    // breaks name matching) because it's set once at creation and never
    // changes. Only works if VS Code preserves creationOptions across
    // reload (the diagnostic log above tells us).
    for (const terminal of vscode.window.terminals) {
      if (boundTerminals.has(terminal)) continue;
      const opts = terminal.creationOptions as vscode.TerminalOptions;
      const envId = opts?.env
        ? (opts.env as Record<string, string>)["VSCODE_CC_ID"]
        : undefined;
      if (envId && persistedById.has(envId)) {
        this.bindLegacyMatchedTerminal(persistedById.get(envId)!, terminal);
        persistedById.delete(envId);
        boundTerminals.add(terminal);
        log(`Matched ${envId} by creationOptions env var`);
      }
    }

    // Pass 2 — match by the highly-specific signals in terminal.name:
    // the displayName (an "s:HH:MM:SS" timestamp, effectively unique) or
    // the ccId / its tail. These survive only if Claude hasn't retitled.
    for (const terminal of vscode.window.terminals) {
      if (boundTerminals.has(terminal)) continue;
      for (const [ccId, data] of persistedById) {
        if (
          terminal.name.includes(data.displayName) ||
          terminal.name.includes(ccId) ||
          terminal.name.includes(ccId.slice(-6))
        ) {
          this.bindLegacyMatchedTerminal(data, terminal);
          persistedById.delete(ccId);
          boundTerminals.add(terminal);
          log(`Matched ${ccId} by name "${terminal.name}"`);
          break;
        }
      }
    }

    // Pass 3 — match by customName. When a session is launched/renamed with
    // --remote-control -n "<name>", Claude sets the terminal title to that
    // name, so terminal.name becomes the customName (sometimes with a status
    // prefix/suffix). Exact match first, then a contains check. Exact-first
    // avoids a short name like "pr" grabbing "pr-tools".
    const remaining = Array.from(persistedById.values()).filter(
      (d) => d.customName,
    );
    for (const data of remaining) {
      // exact
      const exact = vscode.window.terminals.find(
        (t) => !boundTerminals.has(t) && t.name === data.customName,
      );
      const hit =
        exact ||
        vscode.window.terminals.find(
          (t) =>
            !boundTerminals.has(t) &&
            data.customName !== undefined &&
            t.name.includes(data.customName),
        );
      if (hit) {
        this.bindLegacyMatchedTerminal(data, hit);
        persistedById.delete(data.id);
        boundTerminals.add(hit);
        log(
          `Matched ${data.id} by customName "${data.customName}" → "${hit.name}"`,
        );
      }
    }

    // No fallback. Persisted entries that don't match a terminal by name
    // become cold (Phase 4). The old promiscuous fallback — "grab any
    // unmatched CC: terminal for any unmatched persisted entry" — caused
    // wrong-binding when an orphan terminal from a dead session was still
    // around (e.g. claude exited but the shell stayed). Phase 2's retry
    // loop in tryRestore handles the original race (terminal names not
    // yet populated on reload), so this fallback is no longer earning
    // its keep.

    // Phase 4: persisted entries without a matching terminal survive as
    // cold sessions. They render with ❄️ and can be remade.
    for (const [, data] of persistedById) {
      const cold: Session = {
        ...data,
        terminal: undefined,
        state: ClaudeState.Idle,
        hasUserInput: true, // restored, has had user input
        subagentCount: 0,
      };
      this.sessions.set(data.id, cold);
      log(`Restored ${data.id} as cold (no live terminal)`);
    }

    // Order: restore from saved, filtered to sessions we actually have.
    // New entries (somehow not in saved order) get appended.
    const orderedKnown = savedOrder.filter((id) => this.sessions.has(id));
    const unordered = Array.from(this.sessions.keys()).filter(
      (id) => !orderedKnown.includes(id),
    );
    this.order = [...orderedKnown, ...unordered];

    // Flush reconciled state immediately so disk reflects what we loaded.
    this.save();
    this.emitter.fire();
  }

  // Binds a persisted entry to a terminal during restore. Robust to a
  // missing state file: recreates it as IDLE rather than dropping the
  // session. Previously, a missing state file caused a silent drop —
  // mole-sync vanished this way on 2026-05-24 after its remake failed
  // (claude --resume errored, fired SessionEnd, hook unlinked all sidecars,
  // restore couldn't find them, session removed from workspaceState).
  private bindLegacyMatchedTerminal(
    data: PersistedSession,
    terminal: vscode.Terminal,
  ): void {
    const stateFile = path.join(STATE_DIR, `${data.id}.state`);
    // Always (re)write IDLE — stale BUSY from before reload is meaningless,
    // and a missing file would otherwise drop the session.
    try {
      fs.writeFileSync(stateFile, "IDLE\n");
    } catch (e) {
      /* ignore */
    }
    const session: Session = {
      ...data,
      terminal,
      state: ClaudeState.Idle,
      hasUserInput: true, // restored sessions have already had user input
      subagentCount: 0,
    };
    this.sessions.set(data.id, session);
    this.watchSession(session);
    log(`Restored session ${data.id} -> "${terminal.name}"`);
  }

  // Phase 3: terminal disposal => mark session cold (keep record). The
  // user-visible "X" button on a terminal pane, our Suspend command, and
  // any other terminal-close path all funnel through here.
  // Exception: when _remaking is set we ignore the close — remake() is
  // about to bind a fresh terminal to the same session.
  // Real deletion happens via store.delete() called from the Delete command.
  handleTerminalClose(terminal: vscode.Terminal): void {
    for (const s of this.sessions.values()) {
      if (s._remaking) continue;
      if (s.terminal === terminal) {
        this.markCold(s);
        return;
      }
    }
  }

  private markCold(s: Session): void {
    this.stopWatching(s);
    s.terminal = undefined;
    s.lastPrompt = undefined;
    s.permsEnteredAt = undefined;
    s.transcriptPath = undefined;
    s.subagentCount = 0;
    // Leave .session / .version / .cwd sidecars in place — they're the
    // memory of what this session was, useful for Remake. .state and
    // .prompt are transient and would lie now; reset .state and unlink
    // .prompt so cold sessions don't show stale data.
    try {
      fs.writeFileSync(path.join(STATE_DIR, `${s.id}.state`), "IDLE\n");
    } catch (e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(path.join(STATE_DIR, `${s.id}.prompt`));
    } catch (e) {
      /* ignore */
    }
    this.save();
    this.emitter.fire();
    log(`Marked session ${s.id} cold`);
  }

  // ----- polling -----

  private watchSession(session: Session): void {
    const stateFile = path.join(STATE_DIR, `${session.id}.state`);
    const pollInterval = setInterval(() => {
      if (!this.sessions.has(session.id)) {
        clearInterval(pollInterval);
        return;
      }

      const newState = parseStateFile(stateFile);
      const newPrompt = readSidecar(session.id, "prompt");
      const newSessionId = readSidecar(session.id, "session");
      const newCwd = readSidecar(session.id, "cwd");
      const newTranscript = readSidecar(session.id, "tx");
      const newVersion = readSidecar(session.id, "version");
      const newSubagents = readSidecar(session.id, "subagents");
      const now = Date.now();

      let mutated = false;

      // Prompt: signal of "user has typed something" (suppresses startup BUSY)
      if (newPrompt && newPrompt !== session.lastPrompt) {
        session.lastPrompt = newPrompt;
        session.hasUserInput = true;
      }

      // Persistent fields populated by hook — only save if changed (cheap diff)
      if (newSessionId && newSessionId !== session.claudeSessionId) {
        session.claudeSessionId = newSessionId;
        mutated = true;
      }
      // session.directory stays as the LAUNCH cwd (where transcripts live).
      // newCwd from the hook tracks where Claude has wandered to via `cd` or
      // worktree moves — useful for display, but never used to overwrite the
      // launch cwd. Routing it through directory broke --resume across
      // worktrees because transcripts are keyed by project hash of launch cwd.
      if (newCwd && newCwd !== session.currentCwd) {
        session.currentCwd = newCwd; // transient, no save
      }
      if (newTranscript && newTranscript !== session.transcriptPath) {
        session.transcriptPath = newTranscript; // transient, no save
      }
      // Persist a snapshot of the transcript path so the retroactive PR
      // scanner can reach this session's transcript after it goes cold.
      if (newTranscript && newTranscript !== session.lastTranscriptPath) {
        session.lastTranscriptPath = newTranscript;
        mutated = true;
      }
      if (newVersion && newVersion !== session.claudeVersion) {
        session.claudeVersion = newVersion;
        mutated = true;
      }
      if (newSubagents !== undefined) {
        const n = parseInt(newSubagents, 10);
        if (!isNaN(n) && n !== session.subagentCount) {
          session.subagentCount = n; // transient — count not persisted
        }
      }

      // PERMS/WAITING timeout
      if (
        session.state === ClaudeState.Permissions ||
        session.state === ClaudeState.Waiting
      ) {
        const timeoutSeconds = vscode.workspace
          .getConfiguration("claudeCodeStatus")
          .get<number>("permsTimeout", 60);
        if (
          session.permsEnteredAt &&
          now - session.permsEnteredAt > timeoutSeconds * 1000
        ) {
          const wasPerms = session.state === ClaudeState.Permissions;
          const transitionTo = wasPerms
            ? ClaudeState.TimedOutPerms
            : ClaudeState.TimedOutWaiting;
          const stateToken = wasPerms ? "TIMEDOUT-PERMS" : "TIMEDOUT-WAITING";
          log(
            `${session.state} timeout for ${session.id} after ${timeoutSeconds}s, marking ${stateToken}`,
          );
          session.state = transitionTo;
          session.permsEnteredAt = undefined;
          try {
            fs.writeFileSync(stateFile, `${stateToken}\n`);
          } catch (e) {
            /* ignore */
          }
          this.emitter.fire();
          updateStatusBar();
          return;
        }
      }

      if (newState !== session.state) {
        // Suppress startup BUSY (git status, glob, etc. before user typed)
        if (!session.hasUserInput && newState === ClaudeState.Busy) {
          log(`Ignoring BUSY before user input for ${session.id}`);
          return;
        }

        log(`State change ${session.id}: ${session.state} -> ${newState}`);
        if (
          newState === ClaudeState.Permissions ||
          newState === ClaudeState.Waiting
        ) {
          session.permsEnteredAt = now;
        } else {
          session.permsEnteredAt = undefined;
        }
        session.state = newState;
        this.emitter.fire();
        updateStatusBar();
      } else if (mutated) {
        // Persistent field changed but state didn't — still save (cheap)
        this.save();
      }
    }, 100);

    session.pollInterval = pollInterval;
  }

  private stopWatching(session: Session): void {
    if (session.pollInterval) {
      clearInterval(session.pollInterval);
      session.pollInterval = undefined;
    }
  }

  // Called from deactivate() — stop polling but DO NOT delete state files,
  // they're needed for restore after reload.
  stopAllPolling(): void {
    for (const s of this.sessions.values()) {
      this.stopWatching(s);
    }
  }
}

// CommandChannel — file-RPC for the cc-status CLI and /cc slash command.
// Polls $TMPDIR/claude-code-status/cmd/*.req at 200ms, atomic-renames each
// to .taken before processing (prevents double-fire across VS Code windows),
// dispatches to SessionStore methods, writes .res with the outcome.
class CommandChannel {
  private interval?: NodeJS.Timeout;
  private readonly cmdDir = path.join(STATE_DIR, "cmd");

  constructor(private readonly store: SessionStore) {}

  start(): void {
    try {
      fs.mkdirSync(this.cmdDir, { recursive: true });
    } catch (e) {
      /* ignore */
    }
    this.interval = setInterval(() => this.poll(), 200);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private poll(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cmdDir);
    } catch (e) {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".req")) continue;
      const reqPath = path.join(this.cmdDir, name);
      const takenPath = reqPath.replace(/\.req$/, ".taken");
      // Atomic claim: rename wins across processes on POSIX. If two windows
      // race, only one rename succeeds; the loser sees ENOENT next time.
      try {
        fs.renameSync(reqPath, takenPath);
      } catch (e) {
        continue;
      }
      this.handle(takenPath);
    }
  }

  private handle(takenPath: string): void {
    const nonce = path.basename(takenPath).replace(/\.taken$/, "");
    const resPath = path.join(this.cmdDir, `${nonce}.res`);

    let raw: string;
    try {
      raw = fs.readFileSync(takenPath, "utf-8");
    } catch (e) {
      writeRes(resPath, { ok: false, error: `read failed: ${e}` });
      cleanupTaken(takenPath);
      return;
    }

    let req: { cmd?: string; from?: string; args?: Record<string, unknown> };
    try {
      req = JSON.parse(raw);
    } catch (e) {
      writeRes(resPath, { ok: false, error: `bad JSON: ${e}` });
      cleanupTaken(takenPath);
      return;
    }

    const cmd = req.cmd;
    const args = req.args || {};
    const from = req.from;
    log(`CommandChannel: cmd=${cmd} from=${from} args=${JSON.stringify(args)}`);

    let result: Record<string, unknown> = {};
    try {
      switch (cmd) {
        case "sibling":
          result = this.dispatchSibling(from, args);
          break;
        case "fork":
          result = this.dispatchFork(from, args);
          break;
        case "heal":
          result = this.dispatchHeal(from, args);
          break;
        case "remake":
          result = this.dispatchRemake(from, args);
          break;
        case "rename":
          result = this.dispatchRename(from, args);
          break;
        case "list":
          result = this.dispatchList();
          break;
        case "get":
          result = this.dispatchGet(from, args);
          break;
        default:
          writeRes(resPath, { ok: false, error: `unknown cmd: ${cmd}` });
          cleanupTaken(takenPath);
          return;
      }
      writeRes(resPath, { ok: true, result });
    } catch (e) {
      writeRes(resPath, { ok: false, error: String(e) });
    }
    cleanupTaken(takenPath);
  }

  // Resolves a source session reference: explicit --id wins, then --name,
  // then "from" (the env-injected caller ccId) as a self-targeting default.
  private resolveSource(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Session | undefined {
    const explicitId = typeof args.id === "string" ? args.id : undefined;
    const byName = typeof args.name === "string" ? args.name : undefined;
    if (explicitId) return this.store.get(explicitId);
    if (byName) {
      return this.store
        .all()
        .find(
          (s) =>
            s.customName === byName ||
            s.displayName === byName ||
            s.id === byName,
        );
    }
    return from ? this.store.get(from) : undefined;
  }

  private dispatchSibling(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const src = this.resolveSource(from, args);
    if (!src) throw new Error("source session not found in this window");
    const name = typeof args.new_name === "string" ? args.new_name : undefined;
    const newSess = this.store.newSibling(src.id, name);
    if (!newSess) throw new Error("sibling creation failed");
    return sessionSummary(newSess);
  }

  private dispatchFork(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const src = this.resolveSource(from, args);
    if (!src) throw new Error("source session not found in this window");
    const name = typeof args.new_name === "string" ? args.new_name : undefined;
    const newSess = this.store.fork(src.id, name);
    if (!newSess) throw new Error("fork failed (missing claudeSessionId?)");
    return sessionSummary(newSess);
  }

  private dispatchHeal(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const target = this.resolveSource(from, args);
    if (!target) throw new Error("target session not found in this window");
    if (!target.terminal) throw new Error("target is cold; remake first");
    this.store.reconnectRemoteControl(target.id);
    return sessionSummary(target);
  }

  private dispatchRemake(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const target = this.resolveSource(from, args);
    if (!target) throw new Error("target session not found in this window");
    this.store.remake(target.id);
    return sessionSummary(target);
  }

  private dispatchRename(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const target = this.resolveSource(from, args);
    if (!target) throw new Error("target session not found in this window");
    const newName =
      typeof args.new_name === "string" ? args.new_name : undefined;
    if (!newName) throw new Error("missing --name");
    this.store.update(target.id, { customName: newName });
    if (
      target.terminal &&
      vscode.workspace
        .getConfiguration("claudeCodeStatus")
        .get<boolean>("remoteControl", false)
    ) {
      target.terminal.sendText(`/rename ${newName}`);
    }
    return sessionSummary(target);
  }

  private dispatchList(): Record<string, unknown> {
    return {
      sessions: this.store.all().map(sessionSummary),
    };
  }

  private dispatchGet(
    from: string | undefined,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const target = this.resolveSource(from, args);
    if (!target) throw new Error("session not found in this window");
    return sessionSummary(target);
  }
}

// Dashboard refresh cadence + freshness window. STALE_AFTER drives the dimming
// in the render model; the poller runs at POLL_INTERVAL while the dashboard is
// visible and the window is focused.
const POLL_INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = POLL_INTERVAL_MS * 3;
const POLL_CONCURRENCY = 4;

// PrPoller — refreshes non-terminal PRs' GitHub facts via `gh pr view`.
// Lifecycle mirrors CommandChannel (start/stop owned by activate/deactivate),
// but it only does work while the dashboard is active AND the window focused.
class PrPoller {
  private interval?: NodeJS.Timeout;
  private active = false; // dashboard panel visible
  private polling = false; // re-entrancy guard
  private ghPath: string | undefined | null = undefined;
  private _ghUnavailable = false;

  constructor(private readonly store: SessionStore) {}

  get ghUnavailable(): boolean {
    return this._ghUnavailable;
  }

  start(): void {
    this.interval = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  // Called by the dashboard on open/visibility change. Setting active true
  // triggers an immediate refresh so the tab isn't stale on open.
  setActive(active: boolean): void {
    this.active = active;
    if (active) void this.poll();
  }

  private shouldPoll(): boolean {
    return this.active && vscode.window.state.focused && !this.polling;
  }

  // Resolve `gh` once via a login shell so we inherit the user's PATH/auth
  // (the extension host does NOT inherit the interactive shell environment).
  private async resolveGh(): Promise<string | null> {
    if (this.ghPath !== undefined) return this.ghPath;
    const configured = vscode.workspace
      .getConfiguration("claudeCodeStatus")
      .get<string>("ghPath", "gh");
    if (configured && configured.includes("/")) {
      this.ghPath = configured;
      return this.ghPath;
    }
    const shell = process.env.SHELL || "/bin/bash";
    try {
      const out = await execFileP(shell, ["-lc", `command -v ${configured}`]);
      this.ghPath = out.stdout.trim() || null;
    } catch (e) {
      this.ghPath = null;
    }
    return this.ghPath;
  }

  async poll(): Promise<void> {
    if (!this.shouldPoll()) return;
    this.polling = true;
    try {
      const gh = await this.resolveGh();
      if (!gh) {
        this._ghUnavailable = true;
        this.store.notifyChanged();
        return;
      }
      this._ghUnavailable = false;

      const targets = this.store
        .allPrs()
        .filter(({ pr }) => !isTerminalForPolling(pr));
      if (targets.length === 0) return;

      const updates: GithubFactsUpdate[] = [];
      const now = Date.now();
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const { ccId, pr } = targets[cursor++];
          try {
            const { stdout } = await execFileP(gh, [
              "pr",
              "view",
              pr.url,
              "--json",
              GH_PR_VIEW_FIELDS.join(","),
            ]);
            const json = JSON.parse(stdout) as Record<string, unknown>;
            updates.push({
              ccId,
              url: pr.url,
              facts: mapGhJsonToFacts(json, now),
            });
          } catch (e) {
            // Transient failure — leave the last facts; the row dims via STALE.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(POLL_CONCURRENCY, targets.length) }, () =>
          worker(),
        ),
      );
      this.store.applyGithubFacts(updates);
    } finally {
      this.polling = false;
    }
  }
}

// Promisified execFile returning {stdout, stderr}.
function execFileP(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function sessionSummary(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    displayName: s.displayName,
    customName: s.customName,
    directory: s.directory,
    currentCwd: s.currentCwd,
    claudeSessionId: s.claudeSessionId,
    claudeVersion: s.claudeVersion,
    parentSessionId: s.parentSessionId,
    state: s.terminal ? s.state : "cold",
    subagentCount: s.subagentCount,
    lastPrompt: s.lastPrompt,
  };
}

function writeRes(resPath: string, body: Record<string, unknown>): void {
  try {
    fs.writeFileSync(resPath, JSON.stringify(body));
  } catch (e) {
    /* ignore */
  }
}

function cleanupTaken(takenPath: string): void {
  try {
    fs.unlinkSync(takenPath);
  } catch (e) {
    /* ignore */
  }
}

// ----- module-level helpers -----

function generateCcId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureStateDir(): void {
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

    // TIMEDOUT-* must come before PERMS/WAITING since they contain substrings
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

// One-time repair for sessions whose directory got overwritten by the hook
// to a `.claude/worktrees/<name>` path. Strips back to the project root so
// Remake can find the transcript (Claude indexes by launch cwd's project
// hash). Idempotent — safe to apply on every restore.
function repairWorktreeDrift(directory: string): string {
  const marker = "/.claude/worktrees/";
  const idx = directory.indexOf(marker);
  if (idx < 0) return directory;
  return directory.slice(0, idx);
}

// Re-derive a session's transcript path from its launch cwd + claudeSessionId,
// the way Claude Code lays out ~/.claude/projects/<encoded-cwd>/<id>.jsonl
// (the cwd is encoded by replacing path separators and dots with '-'). FALLBACK
// only — the persisted lastTranscriptPath is preferred (the encoding depends on
// the launch cwd, which the worktree-drift bug could corrupt; hence the repair).
function deriveTranscriptPath(
  directory: string,
  claudeSessionId: string,
): string {
  const encoded = repairWorktreeDrift(directory).replace(/[/.]/g, "-");
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encoded,
    `${claudeSessionId}.jsonl`,
  );
}

// Generic sidecar reader. Returns undefined if the file doesn't exist or
// can't be read. Caller decides how to interpret the trimmed content.
function readSidecar(ccId: string, suffix: string): string | undefined {
  const filePath = path.join(STATE_DIR, `${ccId}.${suffix}`);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch (e) {
    return undefined;
  }
}

// TreeView provider — talks to the store, never mutates it. Drag-drop calls
// store.reorder which handles persistence.
class ClaudeTerminalsProvider
  implements
    vscode.TreeDataProvider<Session>,
    vscode.TreeDragAndDropController<Session>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<Session | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dropMimeTypes = ["application/vnd.code.tree.claudeterminals"];
  readonly dragMimeTypes = ["application/vnd.code.tree.claudeterminals"];

  constructor(private readonly store: SessionStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  handleDrag(
    source: readonly Session[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    dataTransfer.set(
      "application/vnd.code.tree.claudeterminals",
      new vscode.DataTransferItem(source.map((t) => t.id)),
    );
  }

  handleDrop(
    target: Session | undefined,
    dataTransfer: vscode.DataTransfer,
  ): void {
    const transferItem = dataTransfer.get(
      "application/vnd.code.tree.claudeterminals",
    );
    if (!transferItem) return;
    const draggedIds: string[] = transferItem.value;
    if (!draggedIds || draggedIds.length === 0) return;
    this.store.reorder(draggedIds[0], target?.id);
  }

  getTreeItem(session: Session): vscode.TreeItem {
    const label =
      session.customName ||
      session.displayName ||
      `Claude ${session.id.slice(-6)}`;

    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
    );

    const isCold = session.terminal === undefined;
    let statePrefix = "";

    if (isCold) {
      item.iconPath = new vscode.ThemeIcon(
        "archive",
        new vscode.ThemeColor("descriptionForeground"),
      );
      statePrefix = "❄️ cold";
      item.contextValue = "terminal-cold";
    } else {
      switch (session.state) {
        case ClaudeState.Permissions:
          item.iconPath = new vscode.ThemeIcon(
            "alert",
            new vscode.ThemeColor("errorForeground"),
          );
          statePrefix = "🔴 PERMS";
          item.contextValue = "terminal-perms";
          break;
        case ClaudeState.TimedOutPerms:
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("editorWarning.foreground"),
          );
          statePrefix = "🟠 TIMED OUT (P)";
          item.contextValue = "terminal-warm";
          break;
        case ClaudeState.TimedOutWaiting:
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("editorWarning.foreground"),
          );
          statePrefix = "🟠 TIMED OUT (Q)";
          item.contextValue = "terminal-warm";
          break;
        case ClaudeState.Busy:
          item.iconPath = new vscode.ThemeIcon(
            "sync~spin",
            new vscode.ThemeColor("warningForeground"),
          );
          statePrefix = "🟡 BUSY";
          item.contextValue = "terminal-warm";
          break;
        case ClaudeState.Waiting:
          item.iconPath = new vscode.ThemeIcon(
            "comment-discussion",
            new vscode.ThemeColor("notificationsInfoIcon.foreground"),
          );
          statePrefix = "🔵 WAITING";
          item.contextValue = "terminal-warm";
          break;
        case ClaudeState.Idle:
          item.iconPath = new vscode.ThemeIcon(
            "circle-outline",
            new vscode.ThemeColor("testing.iconPassed"),
          );
          statePrefix = "🟢 idle";
          item.contextValue = "terminal-warm";
          break;
        default:
          item.iconPath = new vscode.ThemeIcon("question");
          statePrefix = "⚪ ?";
          item.contextValue = "terminal-warm";
      }
    }

    const promptPreview =
      !isCold && session.lastPrompt
        ? session.lastPrompt.slice(0, 50) +
          (session.lastPrompt.length > 50 ? "..." : "")
        : "";
    const subagentBadge =
      !isCold && session.subagentCount > 0
        ? ` · ${session.subagentCount} sub`
        : "";
    item.description = `${statePrefix}${subagentBadge}${promptPreview ? " · " + promptPreview : ""}`;

    // Tooltip — markdown, one piece of info per line. Cold rendering omits
    // live fields (state already shows "❄️ cold").
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${label}**\n\n`);
    md.appendMarkdown(`**State:** ${statePrefix}`);
    if (!isCold && session.subagentCount > 0) {
      md.appendMarkdown(
        ` · ${session.subagentCount} subagent${session.subagentCount === 1 ? "" : "s"}`,
      );
    }
    md.appendMarkdown(`\n\n`);
    md.appendMarkdown(`**Directory:** \`${session.directory}\`\n\n`);
    if (
      !isCold &&
      session.currentCwd &&
      session.currentCwd !== session.directory
    ) {
      md.appendMarkdown(`**Now in:** \`${session.currentCwd}\`\n\n`);
    }
    if (session.claudeSessionId || session.claudeVersion) {
      const v = session.claudeVersion
        ? session.claudeVersion.replace(/\s*\(Claude Code\)\s*$/, "")
        : undefined;
      const sidTail = session.claudeSessionId
        ? session.claudeSessionId.slice(-8)
        : undefined;
      const claudeParts: string[] = [];
      if (v) claudeParts.push(v);
      if (sidTail) claudeParts.push(`session …${sidTail}`);
      md.appendMarkdown(`**Claude:** ${claudeParts.join(" · ")}\n\n`);
    }
    if (session.parentDisplayName) {
      md.appendMarkdown(`**Forked from:** ${session.parentDisplayName}\n\n`);
    }
    if (!isCold && session.lastPrompt) {
      md.appendMarkdown(`**Last prompt:** ${session.lastPrompt}\n\n`);
    }
    md.appendMarkdown(
      isCold
        ? `*Right-click → Remake to revive*`
        : `*Click to focus · right-click for actions*`,
    );
    item.tooltip = md;

    // Always wire the click to focusTerminal. For cold sessions it's a
    // no-op (session.terminal?.show() short-circuits on undefined); the
    // important effect is overriding VS Code's default tree-click handler
    // which otherwise focuses whatever terminal happened to be active.
    item.command = {
      command: "claudeCodeStatus.focusTerminal",
      title: "Focus Terminal",
      arguments: [session],
    };

    return item;
  }

  // Phase 3: tree shows all sessions including cold.
  getChildren(): Session[] {
    return store.all();
  }
}

// SessionEditorPanel — webview dialog for editing a session's name and
// directory together, with read-only context (ccId, Claude session id,
// version, lineage, createdAt) visible alongside. Replaces the
// single-field rename input box.
//
// Singleton: at most one panel open at a time. Re-invoking on a different
// session updates the existing panel.
class SessionEditorPanel {
  private static currentPanel: SessionEditorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private session: Session;
  private disposed = false;

  static show(store: SessionStore, session: Session): void {
    if (SessionEditorPanel.currentPanel) {
      SessionEditorPanel.currentPanel.update(session);
      SessionEditorPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudeSessionEditor",
      "Edit Session",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SessionEditorPanel.currentPanel = new SessionEditorPanel(
      panel,
      store,
      session,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly store: SessionStore,
    session: Session,
  ) {
    this.panel = panel;
    this.session = session;
    this.panel.title = `Edit: ${session.customName || session.displayName}`;
    this.panel.webview.html = this.renderHtml();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (this.disposed) return;
      switch (msg.type) {
        case "browse":
          await this.handleBrowse();
          break;
        case "save":
          this.applyPatch(msg.patch || {});
          this.panel.dispose();
          break;
        case "saveAndRemake":
          this.applyPatch(msg.patch || {});
          this.store.remake(this.session.id);
          this.panel.dispose();
          break;
        case "cancel":
          this.panel.dispose();
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      SessionEditorPanel.currentPanel = undefined;
    });
  }

  private update(session: Session): void {
    this.session = session;
    this.panel.title = `Edit: ${session.customName || session.displayName}`;
    this.panel.webview.html = this.renderHtml();
  }

  private async handleBrowse(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this.session.directory),
      openLabel: "Select directory",
    });
    if (result && result[0]) {
      this.panel.webview.postMessage({
        type: "dirSelected",
        dir: result[0].fsPath,
      });
    }
  }

  private applyPatch(patch: { customName?: string; directory?: string }): void {
    const update: Partial<PersistedSession> = {};
    const newName = (patch.customName ?? "").trim();
    if (newName !== (this.session.customName || "")) {
      update.customName = newName || undefined;
    }
    if (patch.directory && patch.directory !== this.session.directory) {
      update.directory = patch.directory;
    }
    if (Object.keys(update).length > 0) {
      this.store.update(this.session.id, update);
    }
    // Send /rename to the live terminal if remote-control is on and the
    // name actually changed. Same behavior as the legacy rename command.
    if (
      update.customName !== undefined &&
      this.session.terminal &&
      vscode.workspace
        .getConfiguration("claudeCodeStatus")
        .get<boolean>("remoteControl", false)
    ) {
      this.session.terminal.sendText(`/rename ${update.customName}`);
    }
  }

  private renderHtml(): string {
    const s = this.session;
    const cs = s.claudeSessionId || "";
    const cv = (s.claudeVersion || "").replace(/\s*\(Claude Code\)\s*$/, "");
    const created = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
    const parent = s.parentDisplayName || "";
    const esc = htmlEscape;

    const optionalRow = (label: string, value: string): string =>
      value
        ? `<div class="form-row">
             <label>${esc(label)}</label>
             <div class="readonly">${esc(value)}</div>
             <span></span>
           </div>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px;
    max-width: 640px;
  }
  h2 { margin-top: 0; font-weight: 400; }
  .form-row {
    display: grid;
    grid-template-columns: 140px 1fr auto;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }
  .form-row label { color: var(--vscode-descriptionForeground); }
  input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  input[type="text"]:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 6px 14px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  hr {
    border: 0;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 20px 0;
  }
  .readonly {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    user-select: all;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 28px;
  }
  .actions .left { margin-right: auto; }
</style>
</head>
<body>
  <h2>Edit Session</h2>

  <div class="form-row">
    <label for="name">Name</label>
    <input id="name" type="text" value="${esc(s.customName || "")}" placeholder="${esc(s.displayName)}" autofocus />
    <span></span>
  </div>

  <div class="form-row">
    <label for="dir">Directory</label>
    <input id="dir" type="text" value="${esc(s.directory)}" />
    <button class="secondary" onclick="browse()">Browse…</button>
  </div>

  <hr/>

  <div class="form-row">
    <label>ccId</label>
    <div class="readonly">${esc(s.id)}</div>
    <span></span>
  </div>
  ${optionalRow("Claude session", cs)}
  ${optionalRow("Claude version", cv)}
  ${optionalRow("Forked from", parent)}
  <div class="form-row">
    <label>Created</label>
    <div class="readonly">${esc(created)}</div>
    <span></span>
  </div>

  <div class="actions">
    <button class="secondary left" onclick="cancel()">Cancel</button>
    <button onclick="save(false)">Save</button>
    <button onclick="save(true)">Save &amp; Remake</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function patch() {
      return {
        customName: document.getElementById('name').value,
        directory: document.getElementById('dir').value,
      };
    }
    function save(remake) {
      vscode.postMessage({ type: remake ? 'saveAndRemake' : 'save', patch: patch() });
    }
    function browse() { vscode.postMessage({ type: 'browse' }); }
    function cancel() { vscode.postMessage({ type: 'cancel' }); }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel();
      // Plain Enter in either text field saves — the common rename flow is
      // "type name, hit return". Cmd/Ctrl+Enter also works from anywhere.
      if (e.key === 'Enter') {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          save(false);
        }
      }
    });
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'dirSelected') {
        document.getElementById('dir').value = msg.dir;
      }
    });
  </script>
</body>
</html>`;
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ----- module globals -----

let store: SessionStore;
let claudeTerminalsProvider: ClaudeTerminalsProvider;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let commandChannel: CommandChannel;
let prPoller: PrPoller;

function log(msg: string): void {
  const debug = vscode.workspace
    .getConfiguration("claudeCodeStatus")
    .get("debug");
  if (debug && outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }
}

function updateStatusBar(): void {
  if (!statusBarItem) return;

  const all = store.all();
  const warm = all.filter((s) => s.terminal !== undefined);
  const coldCount = all.length - warm.length;

  if (warm.length === 0 && coldCount === 0) {
    statusBarItem.hide();
    return;
  }

  const stateCounts: Record<string, number> = {};
  for (const s of warm) {
    const config = STATE_CONFIG[s.state];
    stateCounts[config.label] = (stateCounts[config.label] || 0) + 1;
  }

  const parts = Object.entries(stateCounts).map(([label, count]) =>
    count > 1 ? `${label}(${count})` : label,
  );
  // Cold sessions get their own count, separate from warm-state aggregation.
  // They don't drive the urgency color below.
  if (coldCount > 0) {
    parts.push(`❄️(${coldCount})`);
  }

  const hasPerms = warm.some((s) => s.state === ClaudeState.Permissions);
  const hasBusy = warm.some((s) => s.state === ClaudeState.Busy);

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
  const tooltipLine =
    coldCount > 0
      ? `${warm.length} warm + ${coldCount} cold`
      : `${warm.length} terminal(s)`;
  statusBarItem.tooltip = `Claude Code: ${tooltipLine}\nClick to show`;
  statusBarItem.show();
}

// ----- activation / deactivation -----

export function activate(context: vscode.ExtensionContext): void {
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

  store = new SessionStore(context);

  try {
    ensureStateDir();

    // Restore — retry up to 5x500ms since terminal names take a moment to
    // populate after reload.
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
        store.restore();
        updateStatusBar();
      } catch (e) {
        outputChannel.appendLine(`Error during restore: ${e}`);
      }
    };
    setTimeout(() => tryRestore(1), 500);
  } catch (e) {
    outputChannel.appendLine(`Error during initialization: ${e}`);
  }

  claudeTerminalsProvider = new ClaudeTerminalsProvider(store);
  const treeView = vscode.window.createTreeView("claudeTerminals", {
    treeDataProvider: claudeTerminalsProvider,
    showCollapseAll: false,
    dragAndDropController: claudeTerminalsProvider,
    canSelectMany: false,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.focusTerminal",
      (session: Session) => {
        session.terminal?.show();
      },
    ),
  );

  // Suspend — terminal dies, session record stays as cold. The inline
  // "pause" icon and right-click "Suspend" both call this. The legacy
  // closeTerminal command id is kept as an alias for backwards compat
  // (any keybinding the user set up still works).
  const suspendHandler = (session: Session) => {
    store.suspend(session.id);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCodeStatus.suspend", suspendHandler),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.closeTerminal",
      suspendHandler,
    ),
  );

  // Remake — kill the old terminal, start a fresh claude with --resume
  // pointing at the same conversation. Works on warm AND cold sessions.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.remakeTerminal",
      (session: Session) => {
        store.remake(session.id);
        updateStatusBar();
      },
    ),
  );

  // Delete — drops the panel record + all sidecars. The Claude transcript
  // file stays on disk (reachable by `claude --resume <id>` if you have
  // the id). Modal confirmation by default; flip claudeCodeStatus.confirmDelete
  // off to one-click delete.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.delete",
      async (session: Session) => {
        const confirm = vscode.workspace
          .getConfiguration("claudeCodeStatus")
          .get<boolean>("confirmDelete", true);
        if (confirm) {
          const name = session.customName || session.displayName;
          const choice = await vscode.window.showWarningMessage(
            `Delete session "${name}"?`,
            {
              modal: true,
              detail:
                "Removes the panel record and sidecar files. The Claude conversation transcript stays on disk.",
            },
            "Delete",
          );
          if (choice !== "Delete") return;
        }
        store.delete(session.id);
        updateStatusBar();
      },
    ),
  );

  // Edit Session — opens the SessionEditorPanel webview. Replaces the
  // single-field rename input box; renameTerminal is kept as an alias so
  // any existing custom keybindings keep working.
  const openEditor = (session: Session) =>
    SessionEditorPanel.show(store, session);
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCodeStatus.editSession", openEditor),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.renameTerminal",
      openEditor,
    ),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "claudeCodeStatus.showTerminals";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCodeStatus.newTerminal", () => {
      const session = store.create();
      session?.terminal?.show();
      updateStatusBar();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.newTerminalResume",
      () => {
        const session = store.create({ resume: true });
        session?.terminal?.show();
        updateStatusBar();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
            vscode.commands.executeCommand(
              "claudeCodeStatus.newTerminalResume",
            );
          }
          return;
        }

        interface TerminalPickItem extends vscode.QuickPickItem {
          terminal?: vscode.Terminal;
          session?: Session;
          isAdoptable: boolean;
          isNewTerminal?: boolean;
        }

        const items: TerminalPickItem[] = [];

        items.push({
          label: "$(plus) New Claude Terminal",
          description: "Create new tracked terminal",
          isAdoptable: false,
          isNewTerminal: true,
        });

        allTerminals.forEach((terminal) => {
          const session = store.all().find((s) => s.terminal === terminal);
          if (session) {
            const config = STATE_CONFIG[session.state];
            const needsAttention = session.state === ClaudeState.Permissions;
            items.push({
              label: `${needsAttention ? "$(alert) " : "$(terminal) "}${terminal.name}`,
              description: config.label,
              detail: needsAttention ? "Needs attention!" : undefined,
              terminal,
              session,
              isAdoptable: false,
            });
          } else {
            items.push({
              label: `$(terminal) ${terminal.name}`,
              description: "untracked",
              detail: "Select to adopt as Claude terminal",
              terminal,
              isAdoptable: true,
            });
          }
        });

        items.sort((a, b) => {
          if (a.isNewTerminal) return -1;
          if (b.isNewTerminal) return 1;
          const aPriority = a.session
            ? STATE_CONFIG[a.session.state].priority
            : -1;
          const bPriority = b.session
            ? STATE_CONFIG[b.session.state].priority
            : -1;
          return bPriority - aPriority;
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a terminal (untracked terminals can be adopted)",
        });

        if (!selected) return;
        if (selected.isNewTerminal) {
          vscode.commands.executeCommand("claudeCodeStatus.newTerminal");
        } else if (selected.isAdoptable && selected.terminal) {
          const adopt = await vscode.window.showInformationMessage(
            `Adopt "${selected.terminal.name}" as a Claude Code terminal?`,
            "Adopt",
            "Just Show",
          );
          if (adopt === "Adopt") {
            const adopted = store.adopt(selected.terminal);
            adopted.terminal?.show();
            updateStatusBar();
          } else {
            selected.terminal.show();
          }
        } else if (selected.terminal) {
          selected.terminal.show();
        }
      },
    ),
  );

  // New sibling — fresh Claude in the source session's directory. The
  // name prompt is genuinely optional: Escape or empty input both proceed
  // with an auto-generated name. (Previously Escape cancelled, which was
  // surprising — you'd click New Sibling, see a prompt, dismiss it
  // expecting "default name" semantics, and get nothing.)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.newSibling",
      async (session: Session) => {
        const dirName = path.basename(session.directory);
        const name = await vscode.window.showInputBox({
          prompt: `New sibling in ${dirName} — name (optional, Escape to use auto-name)`,
          placeHolder: "Leave blank for an auto-generated name",
        });
        const newSess = store.newSibling(session.id, name || undefined);
        newSess?.terminal?.show();
        updateStatusBar();
      },
    ),
  );

  // Fork — new session resuming source's conversation via --fork-session.
  // Busy confirm is the real commitment gate. The follow-up name prompt
  // is genuinely optional — Escape proceeds with auto-name.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.fork",
      async (session: Session) => {
        if (!session.claudeSessionId) {
          vscode.window.showWarningMessage(
            `Cannot fork "${session.customName || session.displayName}" — no Claude session id captured yet.`,
          );
          return;
        }
        if (session.state === ClaudeState.Busy) {
          const confirm = await vscode.window.showWarningMessage(
            `Source session is busy — fork now anyway? The fork resumes from whatever's on disk at this moment.`,
            "Fork",
            "Cancel",
          );
          if (confirm !== "Fork") return;
        }
        const sourceLabel = session.customName || session.displayName;
        const name = await vscode.window.showInputBox({
          prompt: `Fork from "${sourceLabel}" — name (optional, Escape to use auto-name)`,
          placeHolder: "Leave blank for an auto-generated name",
        });
        const newSess = store.fork(session.id, name || undefined);
        newSess?.terminal?.show();
        updateStatusBar();
      },
    ),
  );

  // Reconnect remote-control — for sessions whose --remote-control link
  // dropped (Claude Code app disconnects, network blips). Sends /remote-control
  // into the live terminal, which re-establishes the link.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeCodeStatus.reconnectRemoteControl",
      (session: Session) => {
        store.reconnectRemoteControl(session.id);
      },
    ),
  );

  // Set/update the remote-control context key so package.json menus can
  // hide the Reconnect item when the user doesn't have remote-control on.
  const updateRemoteControlContext = () => {
    const enabled = vscode.workspace
      .getConfiguration("claudeCodeStatus")
      .get<boolean>("remoteControl", false);
    vscode.commands.executeCommand(
      "setContext",
      "claudeCodeStatus.remoteControlEnabled",
      enabled,
    );
  };
  updateRemoteControlContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeCodeStatus.remoteControl")) {
        updateRemoteControlContext();
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      store.handleTerminalClose(terminal);
      updateStatusBar();
    }),
  );

  // Start the callback channel — accepts requests from the cc-status CLI
  // (and therefore from the /cc slash command).
  commandChannel = new CommandChannel(store);
  commandChannel.start();

  // PR poller — idle until a dashboard activates it (setActive). Created here
  // so the machinery exists; the dashboard UI drives it.
  prPoller = new PrPoller(store);
  prPoller.start();

  outputChannel.appendLine("All commands registered successfully");
}

export function deactivate(): void {
  // Stop polling but preserve state files — they're needed for reload restore.
  store?.stopAllPolling();
  commandChannel?.stop();
  prPoller?.stop();
}
