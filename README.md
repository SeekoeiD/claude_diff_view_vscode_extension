# AI CLI diff view

VS Code extension for reviewing **Claude Code** edits as inline diffs inside the editor.

Sessions are launched from inside VS Code via the built-in runner (`Ctrl+Shift+A`).
The extension spawns `claude` and tracks every Write/Edit/MultiEdit tool call so you
can review changes as red phantom rows above the green added lines, hunk by hunk.

## Usage

1. Press `Ctrl+Shift+A` (`Cmd+Shift+A` on macOS) to start a Claude session.
2. Enter your prompt.
3. Review pending diffs directly inside VS Code, accepting or reverting each hunk.

## Requirements

- The `claude` CLI must be on your `PATH` (see [Claude Code](https://claude.ai/code)).

## Install into your real VS Code

The extension uses the `editorInsets` proposed API to render the red phantom
rows on a live file. The Marketplace rejects extensions that depend on proposed
APIs, so you sideload a local VSIX and persistently grant the proposed API to
this extension via `argv.json`.

### 1. Build and install the VSIX

```powershell
npm install
npm run compile
npx vsce package
code --install-extension ai-cli-diff-view-1.0.9.vsix --force
```

`vsce package` will warn that `enabledApiProposals` is set — that is expected
and the `.vsix` is still produced. If `code` is not on your `PATH`, use the
absolute path to the CLI shim, e.g. on Windows:

```powershell
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension "$PWD\ai-cli-diff-view-1.0.9.vsix" --force
```

### 2. Persist the proposed-API grant

Open the runtime arguments file via the command palette:
`Preferences: Configure Runtime Arguments`. VS Code opens `argv.json`. Add an
`enable-proposed-api` key listing this extension's id (`<publisher>.<name>`):

```jsonc
{
  // ...existing entries...
  "enable-proposed-api": ["SeekoeiD.ai-cli-diff-view"]
}
```

### 3. Fully restart VS Code

`argv.json` is read once on process startup, so close every VS Code window and
reopen. `Developer: Reload Window` is not enough.

### Iterating on the extension

For day-to-day development, just press `F5` from this repo to launch the
Extension Development Host — proposed APIs are granted automatically there.

When you want to refresh the installed copy after code changes:

```powershell
npm run compile
npx vsce package
code --install-extension ai-cli-diff-view-1.0.9.vsix --force
```

Then `Developer: Reload Window` (a full restart is only needed if `argv.json`
itself changed).

---

<img alt="Screenshot 2026-03-29 160654" src="https://github.com/user-attachments/assets/d8c894fe-d4b6-4f17-bbdc-7274f849830a" />

---

<img alt="Screenshot 2026-03-29 160727" src="https://github.com/user-attachments/assets/a0305d90-2f11-4ecf-8f90-ac88c7c0916d" />
