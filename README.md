# Out-of-band diffs (VS Code)

VS Code extension for reviewing **out-of-band file edits** as inline diffs
inside the editor. "Out-of-band" means any write to a file in the workspace
that did not come from your VS Code buffer — Notepad, a shell script, an AI
CLI running in a terminal, a code formatter, anything.

When such a write is detected, the extension shows a per-file inline review
with red phantom rows (the deleted text) above green added lines, plus
per-hunk **Accept** / **Revert** controls between them. Phantom rows on the
live file are rendered through the `editorInsets` proposed API, the same
mechanism Copilot uses for its edit previews.

A built-in **Claude Code** session launcher (`Ctrl+Shift+A`) is included as an
optional convenience — it runs `claude --output-format stream-json` and feeds
the same review pipeline — but the extension is not Claude-specific. Any
external process that writes to your workspace will surface a diff.

Originally based on
[konan-1947/claude_diff_view_vscode_extension](https://github.com/konan-1947/claude_diff_view_vscode_extension);
since rewritten around `editorInsets` and reframed around generic
out-of-band edit review.

## Usage

The primary flow is just: edit a workspace file from outside VS Code (or have
some other process do it), and review the resulting diff inside VS Code.

Optional Claude session launcher:

1. Press `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS).
2. Enter your prompt.
3. Review pending diffs as Claude writes files, accepting or reverting each hunk.

## Requirements

- VS Code 1.85+.
- For the optional Claude session launcher: the `claude` CLI on your `PATH`
  (see [Claude Code](https://claude.ai/code)). Not needed for any other
  out-of-band workflow.

## Quick setup

The extension uses the `editorInsets` proposed API, so it has to be sideloaded
— the VS Code Marketplace blocks proposed-API extensions.

```powershell
npm install
npm run compile
npx vsce package
code --install-extension out-of-band-diffs-1.0.9.vsix --force
```

Then run `Preferences: Configure Runtime Arguments` in VS Code and add this
entry to the opened `argv.json`:

```jsonc
"enable-proposed-api": ["SeekoeiD.out-of-band-diffs"]
```

Fully restart VS Code — close every window. `Developer: Reload Window` is not
enough; `argv.json` is only read on process startup.

### Iterating

`F5` from this repo launches an Extension Development Host with proposed APIs
already granted — that's the fastest dev loop. To refresh the installed copy
after code changes:

```powershell
npm run compile && npx vsce package && code --install-extension out-of-band-diffs-1.0.9.vsix --force
```

Then `Developer: Reload Window`.

---

<img alt="Screenshot 2026-03-29 160654" src="https://github.com/user-attachments/assets/d8c894fe-d4b6-4f17-bbdc-7274f849830a" />

---

<img alt="Screenshot 2026-03-29 160727" src="https://github.com/user-attachments/assets/a0305d90-2f11-4ecf-8f90-ac88c7c0916d" />
