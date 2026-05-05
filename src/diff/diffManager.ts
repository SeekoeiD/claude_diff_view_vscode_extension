/**
 * diffManager.ts (refactored)
 *
 * Manages snapshots of file content captured before Claude edits them.
 * Delegates rendering to InlineDiffRenderer.
 * No longer uses temp files or vscode.diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { InlineDiffRenderer } from './inlineDiffRenderer';
import { calculateHunks } from './hunkCalculator';
import { isExcludedPathSegment } from '../watcher/pathExclusions';

const STATE_KEY = 'ai-cli-diff.snapshots';

interface SnapshotState {
  content: string;
  fileExistedBefore: boolean;
}

/** Normalize to the same format that vscode.Uri.fsPath uses. */
function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

export class DiffManager {
  private _onDidChangeDiffs = new vscode.EventEmitter<void>();
  public readonly onDidChangeDiffs = this._onDidChangeDiffs.event;

  public readonly contentProviderEventEmitter = new vscode.EventEmitter<vscode.Uri>();

  /** Stores the original content BEFORE the edit (used to compute the diff) */
  private snapshots: Map<string, SnapshotState> = new Map();
  private snapshotQueries: Map<string, string> = new Map();

  public readonly renderer: InlineDiffRenderer;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.renderer = new InlineDiffRenderer(context.extensionUri);
    this.restoreState();

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('ai-cli-diff', {
        onDidChange: this.contentProviderEventEmitter.event,
        provideTextDocumentContent: (uri: vscode.Uri) => {
          // Strip the query (timestamp) so we resolve to the real file path
          const realFileUri = uri.with({ scheme: 'file', query: '' });
          const originalPath = normalizePath(realFileUri.fsPath);
          return this.getSnapshot(originalPath) || '';
        }
      })
    );
  }

  // ---- State persistence (only paths are persisted, so we can restore after VS Code restarts) ----

  private restoreState(): void {
    const saved = this.context.workspaceState.get<Record<string, string | SnapshotState>>(STATE_KEY, {});
    let pruned = false;
    for (const [absPath, savedSnapshot] of Object.entries(saved)) {
      if (!fs.existsSync(absPath)) { continue; }
      // Drop any persisted entries for hardcoded-ignored paths (e.g. .claude/codediff.txt)
      // that may have been saved before exclusion was enforced at entry points.
      if (isExcludedPathSegment(absPath)) { pruned = true; continue; }
      this.snapshots.set(absPath, this.normalizeSavedSnapshot(savedSnapshot));
      this.snapshotQueries.set(absPath, Date.now().toString());
    }
    if (pruned) { this.persistState(); }
  }

  private persistState(): void {
    const obj: Record<string, SnapshotState> = {};
    for (const [absPath, snapshot] of this.snapshots.entries()) {
      obj[absPath] = snapshot;
    }
    this.context.workspaceState.update(STATE_KEY, obj);
  }

  private normalizeSavedSnapshot(savedSnapshot: string | SnapshotState): SnapshotState {
    if (typeof savedSnapshot === 'string') {
      return { content: savedSnapshot, fileExistedBefore: true };
    }
    return {
      content: savedSnapshot.content,
      fileExistedBefore: savedSnapshot.fileExistedBefore === false ? false : true,
    };
  }

  // ---- Public API ----

  /**
   * Call BEFORE Claude edits a file.
   * Reads the current content and stores it as the "before" snapshot.
   */
  async snapshotBefore(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (isExcludedPathSegment(absPath)) { return; }
    if (this.snapshots.has(absPath)) {
      // Snapshot already exists — keep the original, don't overwrite
      return;
    }
    const fileExistedBefore = fs.existsSync(absPath);
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      this.snapshots.set(absPath, { content, fileExistedBefore });
      this.snapshotQueries.set(absPath, Date.now().toString());
    } catch {
      // File doesn't exist yet (Claude is creating a new file)
      this.snapshots.set(absPath, { content: '', fileExistedBefore: false });
      this.snapshotQueries.set(absPath, Date.now().toString());
    }
    this.persistState();
  }

  /**
   * Call AFTER Claude has finished editing the file.
   * Opens the editor and renders the inline diff.
   */
  async openDiff(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (snapshot === undefined) { return; }

    // Read the new content from disk
    let modifiedContent: string;
    try {
      modifiedContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return;
    }

    // If there is no real difference (hunks = 0), avoid creating/keeping a stale pending state.
    // This commonly happens when Claude "edits" but the final result matches the original,
    // or when a path-resolution bug causes the snapshot to mismatch.
    const hunks = calculateHunks(snapshot.content, modifiedContent);
    if (hunks.length === 0) {
      this.snapshots.delete(absPath);
      this.snapshotQueries.delete(absPath);
      this.persistState();

      // Still call the renderer so it clears decorations/nav for the current editor.
      this.renderer.show(absPath, snapshot.content, modifiedContent);
      // No pending diff remains, so clear the inline diff state to avoid leaving stale state behind.
      this.renderer.clear(absPath);
      this._onDidChangeDiffs.fire();
      return;
    }

    // Open the real file directly so accept/revert hunk CodeLens shows
    // inline in the normal editor instead of a side-by-side diff tab.
    const modifiedUri = vscode.Uri.file(absPath);
    await vscode.window.showTextDocument(modifiedUri, { preview: false });

    // Renderer computes hunks and applies inline decorations / CodeLens.
    this.renderer.show(absPath, snapshot.content, modifiedContent);
    this._onDidChangeDiffs.fire();
  }

  /**
   * Inject a snapshot from outside (used by HookWatcher or WorkspaceWatcher).
   */
  loadSnapshot(filePath: string, content: string, fileExistedBefore = true): void {
    const absPath = normalizePath(filePath);
    if (isExcludedPathSegment(absPath)) { return; }
    if (!this.snapshots.has(absPath)) {
      this.snapshots.set(absPath, { content, fileExistedBefore });
      this.snapshotQueries.set(absPath, Date.now().toString());
      this.persistState();
      this._onDidChangeDiffs.fire();
    }
  }

  async acceptHunk(filePath: string, hunkId: string): Promise<void> {
    const absPath = normalizePath(filePath);

    const hunks = this.renderer.getHunks(absPath);
    const hunk = hunks.find(h => h.id === hunkId);
    let oldSnapshot = this.snapshots.get(absPath);

    if (hunk && oldSnapshot !== undefined) {
      // Patch the original snapshot with the content of the accepted Hunk
      const lines = oldSnapshot.content.split('\n');
      const deleteCount = hunk.removedLines.length;
      const addedTexts = hunk.addedLines.map(l => l.text);
      lines.splice(hunk.originalStart, deleteCount, ...addedTexts);

      const newSnapshot = lines.join('\n');
      this.snapshots.set(absPath, { ...oldSnapshot, content: newSnapshot });
      this.persistState();

      // Tell VS Code to reload the left-hand (Original) side of the Diff view
      const queryId = this.snapshotQueries.get(absPath) || '';
      const originalUri = vscode.Uri.file(absPath).with({ scheme: 'ai-cli-diff', query: queryId });
      this.contentProviderEventEmitter.fire(originalUri);

      // Refresh the Inline Renderer and recompute CodeLenses
      let modifiedContent: string;
      try {
        modifiedContent = fs.readFileSync(absPath, 'utf8');
      } catch {
        modifiedContent = newSnapshot;
      }
      this.renderer.show(absPath, newSnapshot, modifiedContent);
    }

    // If no hunks remain, automatically clean up and close the Diff Editor
    const remainingHunks = this.renderer.getHunks(absPath);
    if (remainingHunks.length === 0) {
      await this.cleanup(absPath);
    }

    this._onDidChangeDiffs.fire();
  }

  async revertHunk(filePath: string, hunkId: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const isDone = await this.renderer.revertHunk(absPath, hunkId);
    const shouldDelete = await this.shouldDeleteRejectedNewFile(absPath);
    if (shouldDelete) {
      await this.deleteRejectedNewFile(absPath);
      await this.cleanup(absPath, { openNormalTextDocument: false });
    } else if (isDone) {
      await this.cleanup(absPath);
    }
    this._onDidChangeDiffs.fire();
  }

  /**
   * Accepts every change in the file — clears the snapshot.
   */
  async accept(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);

    // Capture the pending order before cleanup so we know what the "next file" is.
    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const hasNext = pendingBefore.length > 1 && currentIdx !== -1;
    const nextTarget = hasNext
      ? pendingBefore[(currentIdx + 1) % pendingBefore.length]!
      : undefined;

    this.renderer.acceptAll(absPath);

    // If other pending files remain, avoid "jumping back to a regular file" after closing the diff;
    // instead, switch to the next file's diff so the user can continue reviewing.
    await this.cleanup(absPath, { openNormalTextDocument: !nextTarget });

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }

    this._onDidChangeDiffs.fire();
  }

  /**
   * Reverts every change in the file back to the original content.
   */
  async revert(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (snapshot === undefined) {

      return;
    }

    const shouldDelete = !snapshot.fileExistedBefore;
    await this.renderer.revertAll(absPath);
    if (shouldDelete) {
      await this.deleteRejectedNewFile(absPath);
    }
    await this.cleanup(absPath, { openNormalTextDocument: !shouldDelete });
    this._onDidChangeDiffs.fire();
  }

  /**
   * Accepts every change across all pending files.
   */
  async acceptAllPending(): Promise<number> {
    const pendingFiles = this.getPendingFiles();
    for (const filePath of pendingFiles) {
      const absPath = normalizePath(filePath);
      this.renderer.acceptAll(absPath);
      await this.cleanup(absPath, { openNormalTextDocument: false });
    }
    this._onDidChangeDiffs.fire();
    return pendingFiles.length;
  }

  /**
   * Reverts every change across all pending files.
   */
  async revertAllPending(): Promise<number> {
    const pendingFiles = this.getPendingFiles();
    for (const filePath of pendingFiles) {
      await this.revert(filePath);
    }
    return pendingFiles.length;
  }

  /**
   * Clears the snapshot for a file (after every hunk has been accepted/reverted).
   * Used when all hunks have been resolved manually.
   */
  forgetFile(filePath: string): void {
    this.cleanup(normalizePath(filePath)).catch((err) => console.error(err));
  }

  /**
   * Returns whether the file currently has a pending diff.
   */
  hasPendingDiff(filePath: string): boolean {
    return this.snapshots.has(normalizePath(filePath));
  }

  /**
   * Returns the list of all files with a pending diff.
   */
  getPendingFiles(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /**
   * Returns the original snapshot (used for comparison after edits).
   */
  getSnapshot(filePath: string): string | undefined {
    return this.snapshots.get(normalizePath(filePath))?.content;
  }

  /**
   * Cleans up all pending diffs on deactivate.
   */
  disposeAll(): void {
    this.renderer.disposeAll();
    this.snapshots.clear();
    this.snapshotQueries.clear();
  }

  private async cleanup(
    absPath: string,
    opts?: { openNormalTextDocument?: boolean }
  ): Promise<void> {
    const openNormalTextDocument = opts?.openNormalTextDocument ?? true;

    this.snapshots.delete(absPath);
    this.snapshotQueries.delete(absPath);
    this.persistState();

    // Clear inline diff state/decorations and refresh the nav UI immediately.
    this.renderer.clear(absPath);

    // Save the current cursor and scroll position before closing the tab
    let targetSelection: vscode.Selection | undefined;
    let targetVisibleRange: vscode.Range | undefined;

    for (const editor of vscode.window.visibleTextEditors) {
      if (normalizePath(editor.document.uri.fsPath) === absPath) {
        targetSelection = editor.selection;
        if (editor.visibleRanges.length > 0) {
          targetVisibleRange = editor.visibleRanges[0];
        }
        if (editor === vscode.window.activeTextEditor) {
          break; // Prefer the editor that currently has focus
        }
      }
    }

    // Automatically close the Diff View tab once every hunk has been resolved
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const { modified } = tab.input;
          if (normalizePath(modified.fsPath) === absPath) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
    }

    // Reopen the file in a regular tab and restore the cursor/scroll position
    // (only if we're not switching to another pending diff)
    if (openNormalTextDocument) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
        const editor = await vscode.window.showTextDocument(doc, { preview: false });

        if (targetSelection) {
          editor.selection = targetSelection;
        }
        if (targetVisibleRange) {
          editor.revealRange(targetVisibleRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      } catch {}
    }
  }

  private async shouldDeleteRejectedNewFile(absPath: string): Promise<boolean> {
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot || snapshot.fileExistedBefore) {
      return false;
    }

    const doc = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === absPath);
    if (doc) {
      return doc.getText().length === 0;
    }

    try {
      return fs.readFileSync(absPath, 'utf8').length === 0;
    } catch {
      return false;
    }
  }

  private async deleteRejectedNewFile(absPath: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === absPath);
    if (doc?.isDirty) {
      await doc.save();
    }

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
    } catch (err) {
      if (fs.existsSync(absPath)) {
        throw err;
      }
    }
  }
}
