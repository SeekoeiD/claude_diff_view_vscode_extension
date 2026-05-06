# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Extension Does

This is a VS Code extension for reviewing **out-of-band file edits** as inline diffs. "Out-of-band" means any write to a workspace file that did not come from your VS Code buffer — an external editor like Notepad, a shell script, a code formatter, or an AI CLI running in a terminal. When such a write is detected, the extension opens a per-file inline review with red phantom rows above green added lines and per-hunk Accept/Revert controls embedded between them.

A built-in **Claude Code** session launcher (`Ctrl+Shift+A`) is included as an optional convenience: it spawns `claude --output-format stream-json --verbose -p <prompt>`, parses tool-use events, and feeds the same review pipeline. The extension is not Claude-specific — any external writer surfaces a diff via the workspace watcher path.

Earlier multi-agent (Codex/Qwen) hook integration has been removed. The extension is VS Code IDE only.

## Commands

```bash
npm install
npm run compile
npm run watch
npx vsce package
```

- `npm install` installs dependencies.
- `npm run compile` is the main build command and writes compiled output to `out/`.
- `npm run watch` is the normal development loop; keep it running while using the Extension Development Host.
- Press `F5` in VS Code to launch the Extension Development Host using `.vscode/launch.json`.
- Reload the extension host after TypeScript recompiles.
- There is currently no dedicated lint script and no test script in `package.json`.

## Architecture

### Runtime shape

`src/extension.ts` is the entry point. On `onStartupFinished`, it creates the central `DiffManager`, the session and navigation webviews, and the command registrations.

The extension has one core responsibility: capture a before-image of a file, detect the after-image once Claude writes it, then render a reviewable inline diff while keeping enough per-file state to accept or reject hunks.

### Edit-detection pipelines

There are two paths that can open a diff:

**Built-in Claude runner**

1. `src/claude/runnerFactory.ts` detects whether `claude` is available on PATH.
2. `src/claude/claudeRunner.ts` spawns `claude --output-format stream-json --verbose -p <prompt>`.
3. While parsing the NDJSON stream, it snapshots files before `Write`/`Edit`/`MultiEdit` tool calls and opens diffs when tool results arrive.

**Workspace watcher**

`src/watcher/workspaceWatcher.ts` combines `onDidSaveTextDocument` events with an `fs.watch` over each workspace folder. It uses `src/watcher/fileSnapshotStore.ts` to track a per-file baseline so any out-of-band write (manual edit, external script, anything that isn't the in-IDE Claude runner) can still produce a reviewable diff. The watcher ignores excluded paths via `src/watcher/pathExclusions.ts`.

### Diff state model

`src/diff/diffManager.ts` is the center of the extension. It owns:

- the original-content snapshot map
- the stable per-file query IDs used to reuse diff tabs
- persistence in workspace state under `ai-cli-diff.snapshots`
- the public accept/revert operations used by commands and inset buttons

The left side of the diff is served through a `TextDocumentContentProvider` on the custom `ai-cli-diff` URI scheme, backed by the stored snapshot. The right side is the live workspace file.

`src/diff/inlineDiffRenderer.ts` holds the per-file hunk state computed by `src/diff/hunkCalculator.ts`. It drives `DecorationManager` for added-line highlighting and `InsetManager` for the phantom red rows + Accept/Revert action bar.

### Inline diff rendering

`src/diff/decorationManager.ts` paints the green background on added lines and forwards each hunk to `InsetManager`.

`src/diff/insetManager.ts` uses the proposed `editorInsets` API (`vscode.window.createWebviewTextEditorInset`) to render true phantom rows above the change. Each per-hunk inset is a small webview that contains the deleted lines (red) plus a final action row with `✓ Accept Hunk N/M` and `↶ Revert Hunk N/M` buttons. Button clicks post messages back to the extension and dispatch the existing `ai-cli-diff-view.acceptHunk` / `ai-cli-diff-view.revertHunk` commands.

Because `editorInsets` is a proposed API, `package.json` declares `enabledApiProposals: ["editorInsets"]` and the typings live at `src/vscode.proposed.editorInsets.d.ts`. The extension can only run in an Extension Development Host (F5) or with `--enable-proposed-api SeekoeiD.ai-cli-diff-view`; the marketplace rejects published extensions that depend on proposed APIs.

### Review and resolution flow

Accept and revert are intentionally asymmetric:

- Accepting a hunk edits the in-memory snapshot so the accepted change becomes part of the new baseline on the left side of the diff.
- Reverting a hunk edits the real file on disk with `WorkspaceEdit`.
- Accepting a whole file clears pending state and closes the diff; if other files are still pending, navigation moves directly to the next one.
- Reverting a whole file replaces the entire document with the original snapshot.

When the last hunk for a file is resolved, `DiffManager.cleanup()` removes the snapshot, clears decorations and insets, closes the diff tab, and optionally reopens the file as a normal editor while preserving cursor and scroll position.

### UI composition

There are two persistent webview surfaces:

- `src/views/sessionPanel.ts` shows built-in runner status and the pending-files tree, plus Accept All / Reject All bulk actions.
- `src/views/navBarPanel.ts` shows accept/reject controls plus previous/next pending-file navigation.

Pending-file navigation itself lives in `src/diff/navigationManager.ts`, but the navigation UI is updated indirectly through callbacks fired by `InlineDiffRenderer` and `DiffManager` state changes.

### Important implementation constraints

- Path normalization is load-bearing across the codebase: paths are resolved through `vscode.Uri.file(...).fsPath` and lowercased on Windows before comparisons.
- Snapshot persistence is designed to survive VS Code restarts, so changes to snapshot shape or cleanup behavior affect restore logic as well as live diffing.

## Registered Commands and Keybindings

| Command | Keybinding | Purpose |
| --- | --- | --- |
| `ai-cli-diff-view.startSession` | `Ctrl+Shift+A` | Start a Claude session |
| `ai-cli-diff-view.acceptAllHunks` | `Ctrl+Shift+Y` | Accept all changes in the active file |
| `ai-cli-diff-view.revertAllHunks` | `Ctrl+Shift+Z` | Revert all changes in the active file |
| `ai-cli-diff-view.acceptAllChanges` | — | Accept all pending changes across files |
| `ai-cli-diff-view.revertAllChanges` | — | Revert all pending changes across files |
| `ai-cli-diff-view.acceptHunk` | — | Accept one hunk (used by the inset buttons) |
| `ai-cli-diff-view.revertHunk` | — | Revert one hunk (used by the inset buttons) |
| `ai-cli-diff-view.prevFile` | `Alt+H` | Go to previous pending file |
| `ai-cli-diff-view.nextFile` | `Alt+L` | Go to next pending file |

The when-clause context key `ai-cli-diff-view.hasPendingDiff` controls editor-title actions and pending-file navigation keybinding visibility.
