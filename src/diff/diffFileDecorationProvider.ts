/**
 * diffFileDecorationProvider.ts
 *
 * Decorates files in the explorer that have a pending out-of-band diff and tints
 * every ancestor folder so changes are visible at any level of nesting.
 * Mirrors the way Git surfaces modified files (file-level badge, parent-folder
 * color tint, no badge on folders).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from './diffManager';

export class DiffFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** Normalized fsPaths of files with a pending diff. */
  private pending = new Set<string>();
  /** Cached set of ancestor folder paths that contain at least one pending file. */
  private pendingAncestors = new Set<string>();

  constructor(private readonly diffManager: DiffManager) {
    this.refresh();
    diffManager.onDidChangeDiffs(() => this.refresh());
  }

  private refresh(): void {
    const next = new Set(
      this.diffManager.getPendingFiles().map(p => this.normalize(p))
    );
    const nextAncestors = this.computeAncestors(next);

    // Union of every URI whose decoration may have flipped: files that
    // entered or left the pending set, plus folders that gained or lost
    // a pending descendant.
    const changed = new Set<string>();
    for (const p of this.pending) { if (!next.has(p)) { changed.add(p); } }
    for (const p of next) { if (!this.pending.has(p)) { changed.add(p); } }
    for (const p of this.pendingAncestors) { if (!nextAncestors.has(p)) { changed.add(p); } }
    for (const p of nextAncestors) { if (!this.pendingAncestors.has(p)) { changed.add(p); } }

    this.pending = next;
    this.pendingAncestors = nextAncestors;

    if (changed.size > 0) {
      this._onDidChange.fire(Array.from(changed, p => vscode.Uri.file(p)));
    }
  }

  private computeAncestors(files: Set<string>): Set<string> {
    const ancestors = new Set<string>();
    for (const file of files) {
      let parent = path.dirname(file);
      while (parent && parent !== path.dirname(parent)) {
        ancestors.add(parent);
        parent = path.dirname(parent);
      }
    }
    return ancestors;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    const fsPath = this.normalize(uri.fsPath);

    if (this.pending.has(fsPath)) {
      return {
        badge: '●',
        tooltip: 'Out-of-band diffs: pending change',
        color: new vscode.ThemeColor('outOfBandDiffs.pendingFileForeground'),
      };
    }

    if (this.pendingAncestors.has(fsPath)) {
      return {
        tooltip: 'Out-of-band diffs: contains pending change',
        color: new vscode.ThemeColor('outOfBandDiffs.pendingFileForeground'),
      };
    }

    return undefined;
  }

  private normalize(filePath: string): string {
    const fsPath = vscode.Uri.file(filePath).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }
}
