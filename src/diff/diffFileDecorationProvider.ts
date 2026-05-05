/**
 * diffFileDecorationProvider.ts
 *
 * Decorates files in the explorer that have a pending AI CLI diff,
 * mirroring the way Git surfaces modified files: a colored badge on the
 * file itself, with the color propagating up to ancestor folders so the
 * user can spot pending changes at any level of nesting.
 */

import * as vscode from 'vscode';
import { DiffManager } from './diffManager';

export class DiffFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** Normalized fsPaths of files with a pending diff. */
  private pending = new Set<string>();

  constructor(private readonly diffManager: DiffManager) {
    this.refresh();
    diffManager.onDidChangeDiffs(() => this.refresh());
  }

  /**
   * Re-read the pending set from the DiffManager and notify VS Code about
   * any URIs whose decoration may have changed.
   */
  private refresh(): void {
    const next = new Set(
      this.diffManager.getPendingFiles().map(p => this.normalize(p))
    );

    const changed: vscode.Uri[] = [];
    for (const p of this.pending) {
      if (!next.has(p)) { changed.push(vscode.Uri.file(p)); }
    }
    for (const p of next) {
      if (!this.pending.has(p)) { changed.push(vscode.Uri.file(p)); }
    }

    this.pending = next;
    if (changed.length > 0) {
      this._onDidChange.fire(changed);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    if (!this.pending.has(this.normalize(uri.fsPath))) { return undefined; }

    return {
      badge: '●',
      tooltip: 'AI CLI Diff: pending change',
      color: new vscode.ThemeColor('aiCliDiffView.pendingFileForeground'),
      propagate: true,
    };
  }

  private normalize(filePath: string): string {
    const fsPath = vscode.Uri.file(filePath).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }
}
