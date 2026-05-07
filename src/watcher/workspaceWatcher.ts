/**
 * workspaceWatcher.ts
 *
 * Watches for file changes in the workspace via the VS Code API and fs.watch.
 * Whenever any file is written (by Claude or any other tool), the extension
 * automatically snapshots it and shows the inline diff.
 *
 * Flow:
 *   1. onDidSaveTextDocument → sync the snapshot so fs.watch doesn't trigger a false diff
 *   2. fs.watch workspace folders → also catches files written by external processes
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiffManager } from '../diff/diffManager';
import { FileSnapshotStore, isTextFile } from './fileSnapshotStore';
import { isExcludedPathSegment } from './pathExclusions';

export class WorkspaceWatcher {
  private disposables: vscode.Disposable[] = [];
  /** Debounce: timestamp of the last processed event per file */
  private lastProcessed = new Map<string, number>();
  /** Tracks when VS Code last saved a file (so we can ignore fs.watch events from VS Code itself) */
  private savedFilesByVsCode = new Map<string, number>();
  /** Tracks paths involved in a recent VS Code rename so the resulting fs.watch event is skipped */
  private recentlyRenamed = new Map<string, number>();
  private readonly snapshots: FileSnapshotStore;

  constructor(private readonly diffManager: DiffManager) {
    this.snapshots = new FileSnapshotStore();
  }

  start(): void {
    this.watchVscodeEvents();
    this.watchWorkspaceFolders();
  }

  private normalizePath(p: string): string {
    const fsPath = vscode.Uri.file(path.resolve(p)).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  private normalizeContent(content: string): string {
    return content.trim().replace(/\r\n/g, '\n');
  }

  /**
   * Sync the snapshot on a VS Code save — ensures fs.watch doesn't fire a false diff.
   * (onDidSaveTextDocument always fires before fs.watch)
   */
  private watchVscodeEvents(): void {
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
      const filePath = this.normalizePath(doc.uri.fsPath);
      this.snapshots.set(filePath, doc.getText());
      this.savedFilesByVsCode.set(filePath, Date.now());

      if (this.diffManager.hasPendingDiff(filePath)) {
        this.diffManager.renderer.applyDecorations(filePath);
      }
    });
    this.disposables.push(saveDisposable);

    // Renames within VS Code (drag in explorer, F2, Move To...) trigger a
    // create+delete pair on the file watcher. Without this hook the new
    // location has no baseline snapshot, so handleExternalWrite treats it
    // as a brand-new file and fires a bogus pending diff.
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldPath = this.normalizePath(oldUri.fsPath);
        const newPath = this.normalizePath(newUri.fsPath);
        const baseline = this.snapshots.get(oldPath);
        if (baseline !== undefined) {
          this.snapshots.set(newPath, baseline);
        }
        // Suppress fs.watch follow-up events for both paths briefly.
        const now = Date.now();
        this.recentlyRenamed.set(newPath, now);
        this.recentlyRenamed.set(oldPath, now);
      }
    });
    this.disposables.push(renameDisposable);
  }

  private watchWorkspaceFolders(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    for (const folder of folders) {
      this.watchFolder(folder.uri.fsPath);
    }

    const d = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        this.watchFolder(added.uri.fsPath);
      }
    });
    this.disposables.push(d);

    // Use VS Code's native FileSystemWatcher instead of fs.watch to avoid stalling the event loop
    // when a new project has thousands of files (e.g. node_modules in Next.js).
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    const handleUri = (uri: vscode.Uri) => {
      this.handleExternalWrite(uri.fsPath);
    };
    
    fileWatcher.onDidChange(handleUri);
    fileWatcher.onDidCreate(handleUri);
    
    this.disposables.push(fileWatcher);
  }

  private watchFolder(folderPath: string): void {
    try {
      this.snapshots.buildInitialSnapshots(folderPath);
    } catch (err) {
      console.error('[out-of-band-diffs] workspaceWatcher buildInitialSnapshots error:', err);
    }
  }

  private handleExternalWrite(filePath: string): void {
    const absPath = this.normalizePath(filePath);

    // Skip dependency / build output / tooling (dotnet bin/obj, node_modules, …)
    if (isExcludedPathSegment(absPath)) {
      return;
    }

    const now = Date.now();

    // 0. Skip if this path was just involved in a VS Code rename. The fs
    // watcher fires a delayed create event for the new location even though
    // nothing actually changed — we only need to honor the renamed baseline.
    const renameTime = this.recentlyRenamed.get(absPath) ?? 0;
    if (now - renameTime < 3000) {
      return;
    }

    // 1. Check whether this file was just saved by VS Code itself
    const lastVsCodeSave = this.savedFilesByVsCode.get(absPath) ?? 0;
    if (now - lastVsCodeSave < 2000) {
      // Skip — this write came from the VS Code editor itself
      return;
    }

    // 2. Debounce: skip if we processed this file within the last 500ms
    const lastTime = this.lastProcessed.get(absPath) ?? 0;
    if (now - lastTime < 500) { return; }
    this.lastProcessed.set(absPath, now);

    if (!isTextFile(path.basename(absPath))) { return; }
    if (!this.isInWorkspace(absPath)) { return; }

    // Read the new content from disk after a short delay to make sure the write has finished
    setTimeout(() => {
      // Re-check after timeout in case VS Code onDidSaveTextDocument fired during the 200ms delay
      const lastVsCodeSaveAfterTimeout = this.savedFilesByVsCode.get(absPath) ?? 0;
      if (Date.now() - lastVsCodeSaveAfterTimeout < 2000) {
        return;
      }

      try {
        if (!fs.existsSync(absPath)) { return; }

        const newContentRaw = fs.readFileSync(absPath, 'utf8');
        const oldContentRaw = this.snapshots.get(absPath);

        const newContent = this.normalizeContent(newContentRaw);
        const oldContent = oldContentRaw !== undefined ? this.normalizeContent(oldContentRaw) : undefined;

        if (oldContent === undefined) {
          this.snapshots.set(absPath, newContentRaw);
          if (newContent.trim()) {
            this.triggerDiff(absPath, '', newContentRaw, false);
          }
          return;
        }

        if (oldContent === newContent) { return; }

        // Before triggering a new diff, update the watcher's snapshot baseline
        // so the next save doesn't trigger again.
        this.snapshots.set(absPath, newContentRaw);

        if (!this.diffManager.hasPendingDiff(absPath)) {
          this.triggerDiff(absPath, oldContentRaw!, newContentRaw, true);
        }
      } catch {
        // file is locked or deleted — skip
      }
    }, 200);
  }

  private triggerDiff(filePath: string, originalContent: string, newContent: string, fileExistedBefore: boolean): void {
    this.diffManager.loadSnapshot(filePath, originalContent, fileExistedBefore);
    this.diffManager.openDiff(filePath, false).catch((err: unknown) => {
      console.error('[out-of-band-diffs] workspaceWatcher openDiff failed:', err);
    });
  }

  private isInWorkspace(filePath: string): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return false; }
    const normalizedPath = this.normalizePath(filePath);
    return folders.some(f => normalizedPath.startsWith(this.normalizePath(f.uri.fsPath)));
  }

  /** Update the snapshot when the user edits a file directly (so the baseline stays accurate) */
  updateSnapshot(filePath: string, content: string): void {
    this.snapshots.set(this.normalizePath(filePath), content);
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

