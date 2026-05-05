/**
 * claudeLocator.ts
 *
 * Shared logic for locating the `claude` CLI executable.
 * Used both for availability detection and for launching the runner,
 * so they can never disagree.
 */

import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Returns the path (or bare name) of the claude CLI if it can be found,
 * otherwise null. Tries PATH first, then falls back to the known
 * `%USERPROFILE%/.local/bin/claude(.exe)` install location, which is
 * where the official Windows installer drops the binary even though
 * that directory is not on PATH by default.
 */
export function findClaudeCli(): string | null {
  const candidates = ['claude', 'claude.cmd', 'claude.exe'];

  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of candidates) {
    try {
      const result = cp.spawnSync(
        lookupCmd,
        [candidate.replace(/\.(cmd|exe)$/, '')],
        { encoding: 'utf8', timeout: 3000 }
      );
      if (result.status === 0 && result.stdout.trim()) {
        return candidate;
      }
    } catch {
      // ignore — try next candidate
    }
  }

  const homeDir = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  if (homeDir) {
    const exe = path.join(homeDir, '.local', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) { return exe; }
    const noExt = path.join(homeDir, '.local', 'bin', 'claude');
    if (fs.existsSync(noExt)) { return noExt; }
  }

  return null;
}

export function isClaudeAvailable(): boolean {
  return findClaudeCli() !== null;
}
