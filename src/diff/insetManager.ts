/**
 * insetManager.ts
 *
 * Renders the "removed lines" of each hunk plus the per-hunk Accept/Revert
 * controls as true phantom rows in the editor, using the proposed
 * `editorInsets` API. Each inset is a webview that occupies
 * `removedLines.length + 1` editor lines of vertical space, anchored just
 * above the line where the change lands. Added lines stay as ordinary editor
 * lines with a green decoration applied by DecorationManager.
 *
 * The proposal: vscode.window.createWebviewTextEditorInset(editor, line, height, options)
 *   - `line` is 0-based and the inset is rendered AFTER that line (matching
 *     Monaco's view-zone `afterLineNumber` semantics). To place phantom rows
 *     directly above modifiedStart=N we anchor at N-1.
 *   - For modifiedStart=0 we clamp at 0; the inset then sits below line 0
 *     instead of above it. Acceptable edge-case visual for now.
 */

import * as vscode from 'vscode';
import { Hunk } from './hunkCalculator';

export class InsetManager {
  /** insets[key] = list of insets currently mounted on that editor */
  private insetsByEditor = new Map<string, vscode.WebviewEditorInset[]>();

  /**
   * Replace the set of insets for a given editor with insets derived from `hunks`.
   * Existing insets for this editor are disposed first.
   *
   * Each hunk gets one inset whose final row is an Accept/Revert action bar,
   * so the user always sees the controls between the red removed lines and
   * the green added lines (or, for pure-insert hunks, directly above the
   * green block).
   */
  applyToEditor(editor: vscode.TextEditor, hunks: Hunk[], filePath: string): void {
    const key = this.editorKey(editor);
    this.disposeForEditor(key);

    const created: vscode.WebviewEditorInset[] = [];
    const total = hunks.length;
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i]!;
      const line = Math.max(0, hunk.modifiedStart - 1);
      const height = hunk.removedLines.length + 1; // +1 for the action row

      let inset: vscode.WebviewEditorInset;
      try {
        inset = vscode.window.createWebviewTextEditorInset(
          editor,
          line,
          height,
          { enableScripts: true }
        );
      } catch {
        // editorInsets is a proposed API; if unavailable, skip silently.
        continue;
      }

      inset.webview.html = this.renderHtml(hunk, i + 1, total);
      inset.webview.onDidReceiveMessage((msg: { type?: string }) => {
        if (msg?.type === 'accept') {
          void vscode.commands.executeCommand('ai-cli-diff-view.acceptHunk', filePath, hunk.id);
        } else if (msg?.type === 'revert') {
          void vscode.commands.executeCommand('ai-cli-diff-view.revertHunk', filePath, hunk.id);
        }
      });
      inset.onDidDispose(() => {
        const list = this.insetsByEditor.get(key);
        if (!list) { return; }
        const idx = list.indexOf(inset);
        if (idx >= 0) { list.splice(idx, 1); }
      });
      created.push(inset);
    }

    if (created.length > 0) {
      this.insetsByEditor.set(key, created);
    }
  }

  /** Dispose all insets attached to the given editor. */
  clearEditor(editor: vscode.TextEditor): void {
    this.disposeForEditor(this.editorKey(editor));
  }

  /** Dispose every inset across every editor. */
  disposeAll(): void {
    // Snapshot before iterating: each dispose() synchronously fires
    // onDidDispose, which mutates the underlying lists.
    const allLists = Array.from(this.insetsByEditor.values()).map(l => l.slice());
    this.insetsByEditor.clear();
    for (const list of allLists) {
      for (const inset of list) {
        try { inset.dispose(); } catch { /* ignore */ }
      }
    }
  }

  private disposeForEditor(key: string): void {
    const list = this.insetsByEditor.get(key);
    if (!list) { return; }
    // Snapshot first; dispose() synchronously fires onDidDispose, which
    // splices the live list and would otherwise skip elements during iteration.
    const snapshot = list.slice();
    this.insetsByEditor.delete(key);
    for (const inset of snapshot) {
      try { inset.dispose(); } catch { /* ignore */ }
    }
  }

  private editorKey(editor: vscode.TextEditor): string {
    return `${editor.document.uri.toString()}::${editor.viewColumn ?? 'none'}`;
  }

  private renderHtml(hunk: Hunk, index: number, total: number): string {
    const removedHtml = hunk.removedLines.length > 0
      ? `<pre class="removed">${hunk.removedLines.map(r => this.escapeHtml(r.text)).join('\n')}</pre>`
      : '';

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; width: 100%; overflow: hidden; background: transparent; }
  body {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    font-weight: var(--vscode-editor-font-weight);
    color: var(--vscode-editor-foreground);
  }
  .removed {
    margin: 0;
    padding: 0;
    background-color: rgba(248, 81, 73, 0.18);
    color: rgb(248, 81, 73);
    line-height: 1.4;
    white-space: pre;
    overflow: hidden;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 8px;
    line-height: 1.4;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .actions button {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    font: inherit;
    color: inherit;
  }
  .actions .accept { color: var(--vscode-charts-green, #2ea043); }
  .actions .revert { color: var(--vscode-errorForeground, #f14c4c); }
  .actions button:hover { text-decoration: underline; }
  .label { opacity: 0.7; }
</style></head><body>
${removedHtml}
<div class="actions">
  <button type="button" class="accept" id="accept">&#10003; Accept Changes ${index}/${total}</button>
  <button type="button" class="revert" id="revert">&#8634; Revert Changes ${index}/${total}</button>
</div>
<script>
  (function () {
    const vscode = acquireVsCodeApi();
    const a = document.getElementById('accept');
    const r = document.getElementById('revert');
    if (a) a.addEventListener('click', () => vscode.postMessage({ type: 'accept' }));
    if (r) r.addEventListener('click', () => vscode.postMessage({ type: 'revert' }));
  })();
</script>
</body></html>`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
