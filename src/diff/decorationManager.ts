/**
 * decorationManager.ts
 *
 * Manages TextEditorDecorationType instances and the rendering of decorations
 * (added lines highlight, removed lines ghost text, gutter icons) onto the editor.
 */

import * as vscode from 'vscode';
import { Hunk } from './hunkCalculator';
import { InsetManager } from './insetManager';

export class DecorationManager {
  private readonly addedLineDecor: vscode.TextEditorDecorationType;
  /** Kept for compatibility — no real icon used since we have CodeLens */
  private readonly acceptGutterDecor: vscode.TextEditorDecorationType;
  private readonly revertGutterDecor: vscode.TextEditorDecorationType;
  private readonly navigationBarDecor: vscode.TextEditorDecorationType;
  /** Renders removed-line phantom rows via the editorInsets proposed API. */
  private readonly insets = new InsetManager();

  constructor() {
    this.addedLineDecor = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(46, 160, 67, 0.15)', // soft pastel green instead of a strong blue
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    // Gutter decorations — kept empty since CodeLens already covers this
    this.acceptGutterDecor = vscode.window.createTextEditorDecorationType({});
    this.revertGutterDecor = vscode.window.createTextEditorDecorationType({});

    // Floating navigation bar at the bottom of the editor.
    // Uses aggressive CSS position: fixed to pin it to the bottom of the view.
    this.navigationBarDecor = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 0',
        textDecoration: `
          none;
          position: fixed;
          bottom: 20px;
          right: 50%;
          transform: translateX(50%);
          z-index: 1000;
        `
      }
    });
  }

  /**
   * Applies decorations to a specific editor based on the given hunks list.
   */

  applyToEditor(editor: vscode.TextEditor, hunks: Hunk[], filePath: string): void {
    const addedRanges: vscode.Range[] = [];
    const acceptGutterRanges: vscode.DecorationOptions[] = [];
    const revertGutterRanges: vscode.DecorationOptions[] = [];

    for (const hunk of hunks) {
      // Added line — paint the background green
      for (const addedLine of hunk.addedLines) {
        const lineIdx = addedLine.modifiedLineIndex;
        addedRanges.push(
          new vscode.Range(
            new vscode.Position(lineIdx, 0),
            new vscode.Position(lineIdx, Number.MAX_SAFE_INTEGER)
          )
        );
      }

      // Gutter hover — attached to the first line of the hunk
      const gutterLine = hunk.modifiedStart;
      const gutterRange = new vscode.Range(
        new vscode.Position(gutterLine, 0),
        new vscode.Position(gutterLine, 0)
      );
      acceptGutterRanges.push({
        range: gutterRange,
        hoverMessage: new vscode.MarkdownString(
          `**Accept hunk** (ID: \`${hunk.id}\`)\n\nRun command \`AI CLI Diff: Accept Hunk\``
        ),
      });
      revertGutterRanges.push({
        range: gutterRange,
        hoverMessage: new vscode.MarkdownString(
          `**Revert hunk** (ID: \`${hunk.id}\`)\n\nRun command \`AI CLI Diff: Revert Hunk\``
        ),
      });
    }

    editor.setDecorations(this.addedLineDecor, addedRanges);
    editor.setDecorations(this.acceptGutterDecor, acceptGutterRanges);
    editor.setDecorations(this.revertGutterDecor, revertGutterRanges);
    editor.setDecorations(this.navigationBarDecor, []);

    // Removed lines + per-hunk Accept/Revert controls render as real phantom
    // rows via the editorInsets webview API.
    this.insets.applyToEditor(editor, hunks, filePath);
  }

  private renderNavigationBar(editor: vscode.TextEditor, info: any, ranges: vscode.DecorationOptions[]): void {
    const { currentIdx, total, prevName, nextName } = info;

    // Build an HTML-like string using aggressive CSS inside textDecoration
    const navContent = ` < Alt+H ${prevName}  |  View ${total} edited files (${currentIdx}/${total})  |  ${nextName} Alt+L > `;

    // Use the last visible line as the decoration anchor
    const lastLine = editor.document.lineCount - 1;
    const range = new vscode.Range(lastLine, 0, lastLine, 0);

    ranges.push({
      range,
      renderOptions: {
        after: {
          contentText: navContent,
          color: new vscode.ThemeColor('editor.foreground'),
          backgroundColor: new vscode.ThemeColor('editor.background'),
          border: '1px solid rgba(128, 128, 128, 0.4)',
          textDecoration: `
            none;
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            padding: 10px 20px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            font-size: 13px;
            font-weight: 500;
            white-space: pre;
            pointer-events: none;
            z-index: 9999;
            display: flex;
            align-items: center;
            letter-spacing: 0.5px;
            backdrop-filter: blur(8px);
            border: 1px solid rgba(128, 128, 128, 0.2);
          `
        }
      }
    });

    editor.setDecorations(this.navigationBarDecor, ranges);
  }

  /**
   * Removes all decorations from an editor.
   */
  clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedLineDecor, []);
    editor.setDecorations(this.acceptGutterDecor, []);
    editor.setDecorations(this.revertGutterDecor, []);
    editor.setDecorations(this.navigationBarDecor, []);
    this.insets.clearEditor(editor);
  }

  /** Dispose all decoration types on deactivate. */
  disposeAll(): void {
    this.addedLineDecor.dispose();
    this.acceptGutterDecor.dispose();
    this.revertGutterDecor.dispose();
    this.navigationBarDecor.dispose();
    this.insets.disposeAll();
  }
}
