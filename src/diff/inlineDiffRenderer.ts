/**
 * inlineDiffRenderer.ts
 *
 * Manages inline-diff state for open files.
 * Delegates decoration rendering to DecorationManager.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { calculateHunks, Hunk } from './hunkCalculator';
import { DecorationManager } from './decorationManager';
import { NavigationManager } from './navigationManager';
import { DiffManager } from './diffManager';

/** State of a file that currently has an inline diff */
interface FileDiffState {
  originalContent: string;
  hunks: Hunk[];
}

export class InlineDiffRenderer {
  /** Map filePath -> current diff state */
  private fileStates = new Map<string, FileDiffState>();
  private readonly decorations: DecorationManager;
  private navigationManager?: NavigationManager;
  private onNavUpdate?: (navInfo?: {
    currentIdx: number;
    total: number;
    prevName: string;
    nextName: string;
    canPrev: boolean;
    canNext: boolean;
  }) => void;

  constructor(_extensionUri: vscode.Uri) {
    this.decorations = new DecorationManager();
  }

  setNavigationManager(nav: NavigationManager): void {
    this.navigationManager = nav;
  }

  setNavUpdateCallback(cb: (navInfo?: {
    currentIdx: number;
    total: number;
    prevName: string;
    nextName: string;
    canPrev: boolean;
    canNext: boolean;
  }) => void): void {
    this.onNavUpdate = cb;
  }

  /**
   * Shows the inline diff for a file currently open in an editor.
   */
  show(filePath: string, originalContent: string, modifiedContent: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const hunks = calculateHunks(originalContent, modifiedContent);
    this.fileStates.set(normalizedPath, { originalContent, hunks });
    this.applyDecorations(normalizedPath);
  }


  /**
   * Reverts a specific hunk (restoring its original content).
   * Returns true if no pending diff remains.
   */
  async revertHunk(filePath: string, hunkId: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(filePath);
    const state = this.fileStates.get(normalizedPath);
    if (!state) { return true; }

    const hunk = state.hunks.find(h => h.id === hunkId);
    if (!hunk) { return state.hunks.length === 0; }

    const document = this.findDocument(filePath);
    if (!document) { return false; }

    const wsEdit = new vscode.WorkspaceEdit();

    if (hunk.addedLines.length > 0) {
      const firstAdded = hunk.addedLines[0]!;
      const lastAdded  = hunk.addedLines[hunk.addedLines.length - 1]!;
      const startPos   = new vscode.Position(firstAdded.modifiedLineIndex, 0);
      const endLine    = lastAdded.modifiedLineIndex;
      const endPos     = new vscode.Position(
        endLine,
        document.lineAt(Math.min(endLine, document.lineCount - 1)).text.length
      );

      if (hunk.removedLines.length === 0) {
        // Pure insert — remove the added lines
        wsEdit.delete(document.uri, new vscode.Range(
          new vscode.Position(firstAdded.modifiedLineIndex, 0),
          new vscode.Position(lastAdded.modifiedLineIndex + 1, 0)
        ));
      } else {
        const replacementText = hunk.removedLines.map(r => r.text).join('\n');
        wsEdit.replace(document.uri, new vscode.Range(startPos, endPos), replacementText);
      }
    } else if (hunk.removedLines.length > 0) {
      // Pure delete — re-insert the removed lines
      const insertPos  = new vscode.Position(hunk.modifiedStart, 0);
      const insertText = hunk.removedLines.map(r => r.text).join('\n') + '\n';
      wsEdit.insert(document.uri, insertPos, insertText);
    }

    await vscode.workspace.applyEdit(wsEdit);

    // Update hunks and adjust the offset of subsequent hunks
    const delta = hunk.removedLines.length - hunk.addedLines.length;
    state.hunks = state.hunks.filter(h => h.id !== hunkId);

    for (const laterHunk of state.hunks) {
      if (laterHunk.modifiedStart > hunk.modifiedStart) {
        laterHunk.modifiedStart += delta;
        for (const line of laterHunk.addedLines) {
          line.modifiedLineIndex += delta;
        }
      }
    }

    if (state.hunks.length === 0) {
      this.clear(normalizedPath);
      return true;
    }
    this.applyDecorations(normalizedPath);
    return false;
  }

  /** Accepts every change in the file. */
  acceptAll(filePath: string): void {
    this.clear(this.normalizePath(filePath));
  }

  /** Reverts everything back to the original content. */
  async revertAll(filePath: string): Promise<void> {
    const normalizedPath = this.normalizePath(filePath);
    const state = this.fileStates.get(normalizedPath);
    if (!state) { return; }

    const document = this.findDocument(filePath);
    if (!document) { return; }

    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.lineAt(document.lineCount - 1).range.end
    );
    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.replace(document.uri, fullRange, state.originalContent);
    await vscode.workspace.applyEdit(wsEdit);

    this.clear(normalizedPath);
  }

  /** Returns the list of hunks for a file. */
  getHunks(filePath: string): Hunk[] {
    return this.fileStates.get(this.normalizePath(filePath))?.hunks ?? [];
  }

  /** Returns whether the file currently has a pending diff. */
  hasPending(filePath: string): boolean {
    const state = this.fileStates.get(this.normalizePath(filePath));
    return (state?.hunks.length ?? 0) > 0;
  }

  /** Clears all decorations for the file and removes it from state. */
  clear(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const isActiveEditor = activeFsPath
      ? this.normalizePath(activeFsPath) === normalizedPath
      : false;

    // If the state was already cleared earlier (e.g. DiffManager called acceptAll -> clear, then cleanup),
    // we still need to refresh the nav UI when the active file no longer has pending changes.
    if (!this.fileStates.has(normalizedPath)) {
      if (isActiveEditor) {
        const navInfo = this.navigationManager?.getNavigationInfo(normalizedPath);
        this.onNavUpdate?.(navInfo);
      }
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (
        this.normalizePath(editor.document.uri.fsPath) === normalizedPath &&
        !this.isEditorInDiffView(editor)
      ) {
        this.decorations.clearEditor(editor);
      }
    }

    this.fileStates.delete(normalizedPath);

    // When the active file is removed from state, update the nav UI immediately,
    // even if other pending files are still open.
    if (isActiveEditor) {
      const navInfo = this.navigationManager?.getNavigationInfo(normalizedPath);
      this.onNavUpdate?.(navInfo);
      return;
    }

    if (this.fileStates.size === 0) {
      this.onNavUpdate?.(undefined);
    }
  }

  /** Clear everything on deactivate. */
  disposeAll(): void {
    for (const filePath of Array.from(this.fileStates.keys())) {
      this.clear(filePath);
    }
    this.decorations.disposeAll();
  }

  /** Re-applies decorations to every editor currently showing the file. */
  applyDecorations(filePath: string): void {
    const normalizedPath = this.normalizePath(filePath);
    const state = this.fileStates.get(normalizedPath);
    if (!state) { return; }

    const navInfo = this.navigationManager?.getNavigationInfo(normalizedPath);
    this.onNavUpdate?.(navInfo);

    for (const editor of vscode.window.visibleTextEditors) {
      if (this.normalizePath(editor.document.uri.fsPath) === normalizedPath) {
        const isDiffView = this.isEditorInDiffView(editor);
        this.decorations.applyToEditor(editor, isDiffView ? [] : state.hunks, filePath);
      }
    }
  }

  /**
   * Returns true if the editor is part of a diff view.
   * Uses the Tab API (VSCode 1.71+).
   */
  public isEditorInDiffView(editor: vscode.TextEditor): boolean {
    if (editor.viewColumn === undefined) { return true; }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.isActive && tab.input instanceof vscode.TabInputTextDiff) {
          if (
            this.normalizePath(tab.input.original.fsPath) === this.normalizePath(editor.document.uri.fsPath) ||
            this.normalizePath(tab.input.modified.fsPath) === this.normalizePath(editor.document.uri.fsPath)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ---- Private helpers ----

  private normalizePath(p: string): string {
    const fsPath = vscode.Uri.file(path.resolve(p)).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  private findDocument(filePath: string): vscode.TextDocument | undefined {
    const normalized = this.normalizePath(filePath);
    return vscode.workspace.textDocuments.find(
      d => this.normalizePath(d.uri.fsPath) === normalized
    );
  }
}
