/**
 * aiRunner.ts
 *
 * Common interface for all AI CLI runners (Claude, ...).
 * Lets the extension work with multiple tools without changing core logic.
 */

import { DiffManager } from '../diff/diffManager';

export type StatusCallback = (
  status: 'running' | 'idle' | 'error',
  message?: string
) => void;

export type ProgressCallback = (step: string) => void;

export interface IAiRunner {
  /** Tool name for display in the UI ("claude") */
  readonly toolName: string;

  /**
   * Runs an AI session with the given prompt.
   * Calls onStatus when state changes, onProgress to update the UI.
   */
  run(
    prompt: string,
    workingDir: string,
    onStatus: StatusCallback,
    onProgress?: ProgressCallback
  ): Promise<void>;

  /**
   * Returns the path to this tool's settings.json file.
   * Used by the installHooks feature.
   */
  getSettingsFilePath(): string;

  /**
   * Returns the file-editing tool names this CLI uses.
   * Used for the hook matcher.
   */
  getFileEditToolNames(): string[];
}
