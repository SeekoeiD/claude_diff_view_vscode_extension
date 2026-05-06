import * as vscode from 'vscode';
import { DiffManager } from './diffManager';

/**
 * Provides CodeLens entries ("Accept Hunk | Revert Hunk" buttons) shown directly above each change block.
 * Works around the VS Code limitation that gutter icons can't be clicked directly.
 */
export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly diffManager: DiffManager) {}

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Returns true if the document is open in at least one regular editor
   * (not a diff editor). Uses the Tab API (VSCode 1.71+).
   */
  private hasRegularEditor(document: vscode.TextDocument): boolean {
    const fsPath = document.uri.fsPath;

    // Collect tabs that are diff editors
    const diffModifiedPaths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          diffModifiedPaths.add(tab.input.modified.fsPath);
          diffModifiedPaths.add(tab.input.original.fsPath);
        }
      }
    }

    // Check whether any regular tab has this file open
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (tab.input.uri.fsPath === fsPath) {
            return true;
          }
        }
      }
    }

    // No regular tab found → file is only present in a diff editor
    return !diffModifiedPaths.has(fsPath);
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const filePath = document.uri.fsPath;

    // Only show CodeLens if the file has a pending diff
    if (!this.diffManager.hasPendingDiff(filePath)) {
      return [];
    }

    // Skip this check so the Accept/Revert Hunk buttons also appear inside
    // the Diff Editor view (in the right-hand Modified pane).
    // if (!this.hasRegularEditor(document)) {
    //   return [];
    // }

    const hunks = this.diffManager.renderer.getHunks(filePath);
    const lenses: vscode.CodeLens[] = [];

    const totalHunks = hunks.length;
    for (let index = 0; index < hunks.length; index++) {
      const hunk = hunks[index]!;
      const hunkLabel = `Hunk ${index + 1}/${totalHunks}`;
      // Anchor the CodeLens at the hunk's starting line
      const lineIdx = Math.max(0, hunk.modifiedStart);
      const range = new vscode.Range(lineIdx, 0, lineIdx, 0);

      // Accept button
      const acceptCmd: vscode.Command = {
        title: `$(check) Accept ${hunkLabel}`,
        tooltip: 'Accept these changes',
        command: 'out-of-band-diffs.acceptHunk',
        arguments: [filePath, hunk.id],
      };
      lenses.push(new vscode.CodeLens(range, acceptCmd));

      // Revert button
      const revertCmd: vscode.Command = {
        title: `$(discard) Revert ${hunkLabel}`,
        tooltip: 'Discard the changes and restore the original',
        command: 'out-of-band-diffs.revertHunk',
        arguments: [filePath, hunk.id],
      };
      lenses.push(new vscode.CodeLens(range, revertCmd));
    }

    return lenses;
  }
}
