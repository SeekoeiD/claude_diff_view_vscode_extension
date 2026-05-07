import * as vscode from 'vscode';
import { DiffManager } from './diff/diffManager';
import { IAiRunner } from './claude/aiRunner';
import { WorkspaceWatcher } from './watcher/workspaceWatcher';
import { SessionPanelProvider } from './views/sessionPanel';
import { registerAllCommands } from './commands/commandsRegistry';
import { NavigationManager } from './diff/navigationManager';
import { NavBarPanel } from './views/navBarPanel';
import { DiffFileDecorationProvider } from './diff/diffFileDecorationProvider';

export function activate(context: vscode.ExtensionContext): void {
  const diffManager       = new DiffManager(context);
  const sessionPanel      = new SessionPanelProvider(diffManager, context);
  const workspaceWatcher  = new WorkspaceWatcher(diffManager);
  const navigationManager = new NavigationManager(diffManager);

  diffManager.renderer.setNavigationManager(navigationManager);

  const navBarPanel = new NavBarPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NavBarPanel.viewType, navBarPanel)
  );
  diffManager.renderer.setNavUpdateCallback(() => {
    updateNavBarState();
  });

  let activeRunner: IAiRunner | undefined;

  context.subscriptions.push(
    { dispose: () => diffManager.disposeAll() },
    { dispose: () => workspaceWatcher.dispose() },
    { dispose: () => sessionPanel.dispose() }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionPanelProvider.viewType, sessionPanel)
  );

  const fileDecorationProvider = new DiffFileDecorationProvider(diffManager);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(fileDecorationProvider)
  );

  workspaceWatcher.start();

  registerAllCommands({
    diffManager,
    sessionPanel,
    context,
    getRunner: () => activeRunner,
    setRunner: (r) => { activeRunner = r; },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('out-of-band-diffs.nextFile', () => navigationManager.nextFile()),
    vscode.commands.registerCommand('out-of-band-diffs.prevFile', () => navigationManager.prevFile())
  );

  function updateNavBarState(): void {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;
    const pendingFiles = diffManager.getPendingFiles();

    if (pendingFiles.length === 0) {
      navBarPanel.setActiveFile(undefined);
      navBarPanel.update(undefined);
      return;
    }

    if (filePath && diffManager.renderer.hasPending(filePath)) {
      navBarPanel.setActiveFile(filePath);
    } else {
      navBarPanel.setActiveFile(undefined);
    }

    const navAnchor = filePath ?? pendingFiles[0];
    navBarPanel.update(navigationManager.getNavigationInfo(navAnchor));
  }

  let isOpeningDiff = false;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      updateNavBarState();
      if (!editor || editor.document.uri.scheme !== 'file') { return; }
      const filePath = editor.document.uri.fsPath;
      if (diffManager.renderer.hasPending(filePath)) {
        if (!diffManager.renderer.isEditorInDiffView(editor) && !isOpeningDiff) {
          isOpeningDiff = true;
          try {
            // takeFocus=false: this handler fires both for genuine user nav
            // and as a side effect of our own preserveFocus=true opens from
            // the watcher / Claude runner. In the user-nav case focus is
            // already on the editor so preserveFocus is a no-op; in the
            // watcher case it prevents a re-entrant focus steal.
            await diffManager.openDiff(filePath, false);
          } finally {
            setTimeout(() => { isOpeningDiff = false; }, 500);
          }
          return;
        }
        diffManager.renderer.applyDecorations(filePath);
      }
    })
  );

  context.subscriptions.push(
    diffManager.onDidChangeDiffs(() => {
      updateNavBarState();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const filePath = e.document.uri.fsPath;
      if (diffManager.renderer.hasPending(filePath)) {
        diffManager.renderer.applyDecorations(filePath);
      }
    })
  );
}

export function deactivate(): void {}
