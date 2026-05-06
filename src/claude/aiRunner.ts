/**
 * aiRunner.ts
 *
 * Interface for the in-IDE Claude runner.
 */

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
}
