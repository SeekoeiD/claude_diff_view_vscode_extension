import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from './diffManager';

/** Normalize path helper */
function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

export class NavigationManager {
  constructor(private readonly diffManager: DiffManager) {}

  /**
   * Switches to the next file in the pending diffs list.
   */
  async nextFile(): Promise<void> {
    await this.navigate(1);
  }

  /**
   * Switches back to the previous file in the pending diffs list.
   */
  async prevFile(): Promise<void> {
    await this.navigate(-1);
  }

  private async navigate(direction: number): Promise<void> {
    const pendingFiles = this.diffManager.getPendingFiles();
    if (pendingFiles.length === 0) {
      vscode.window.showInformationMessage('No files with pending diffs.');
      return;
    }

    const currentEditor = vscode.window.activeTextEditor;
    const currentPath = currentEditor ? normalizePath(currentEditor.document.uri.fsPath) : '';
    
    // If only one pending file remains: if the user is on a different file, open that diff immediately.
    if (pendingFiles.length === 1) {
      if (normalizePath(pendingFiles[0]) !== currentPath) {
        await this.diffManager.openDiff(pendingFiles[0]);
      }
      return;
    }

    let currentIndex = pendingFiles.indexOf(currentPath);
    // If the current file isn't found (user is on another file with no diff),
    // pick the appropriate boundary in the navigation direction so it doesn't wrap.
    if (currentIndex === -1) {
      currentIndex = direction > 0 ? 0 : pendingFiles.length - 1;
    } else {
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= pendingFiles.length) {
        return;
      }
      currentIndex = targetIndex;
    }

    const targetPath = pendingFiles[currentIndex];
    await this.diffManager.openDiff(targetPath);
  }

  /**
   * Returns the info needed to render the navigation bar.
   */
  getNavigationInfo(currentFilePath: string) {
    const pendingFiles = this.diffManager.getPendingFiles();
    if (pendingFiles.length === 0) { return undefined; }

    if (pendingFiles.length === 1) {
      const onlyFile = pendingFiles[0]!;
      const onlyName = path.basename(onlyFile);
      return {
        currentIdx: 1,
        total: 1,
        prevName: onlyName,
        nextName: onlyName,
        canPrev: true,
        canNext: true,
      };
    }

    const currentPath = normalizePath(currentFilePath);
    const rawIndex = pendingFiles.indexOf(currentPath);

    // If the user is on a non-pending file, Next/Prev opens a boundary file:
    // - Next: opens the first pending file
    // - Prev: opens the last pending file
    if (rawIndex === -1) {
      const first = pendingFiles[0]!;
      const last = pendingFiles[pendingFiles.length - 1]!;
      return {
        currentIdx: 1,
        total: pendingFiles.length,
        prevName: path.basename(last),
        nextName: path.basename(first),
        canPrev: true,
        canNext: true,
      };
    }

    const currentIndex = rawIndex;
    const canPrev = currentIndex > 0;
    const canNext = currentIndex < pendingFiles.length - 1;
    const prevName = canPrev ? path.basename(pendingFiles[currentIndex - 1]) : '';
    const nextName = canNext ? path.basename(pendingFiles[currentIndex + 1]) : '';

    return {
      currentIdx: currentIndex + 1,
      total: pendingFiles.length,
      prevName,
      nextName,
      canPrev,
      canNext,
    };
  }
}
