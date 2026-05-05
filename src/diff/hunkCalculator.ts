/**
 * hunkCalculator.ts
 *
 * Computes the "hunks" of change between two file-content strings.
 * Uses a simplified line-based Myers diff algorithm.
 */

export interface Hunk {
  /** Unique id for each hunk (used for lookup during accept/revert) */
  id: string;
  /** Start line in the MODIFIED content (0-indexed); anchors the gutter icon */
  modifiedStart: number;
  /** Start line in the ORIGINAL content (0-indexed); where the patch begins */
  originalStart: number;
  /** Lines that were REMOVED (from the original content) */
  removedLines: RemovedLine[];
  /** Lines that were ADDED (in the new content) */
  addedLines: AddedLine[];
}

export interface RemovedLine {
  /** Text of the removed line */
  text: string;
  /** Line position in the original file (0-indexed) */
  originalLineIndex: number;
}

export interface AddedLine {
  /** Text of the added line */
  text: string;
  /** Line position in the modified file (0-indexed) */
  modifiedLineIndex: number;
}

type DiffOp =
  | { type: 'equal'; text: string; origIdx: number; modIdx: number }
  | { type: 'delete'; text: string; origIdx: number }
  | { type: 'insert'; text: string; modIdx: number; origIdx: number };

/**
 * Computes an LCS-based diff between two arrays of lines.
 * Returns the DiffOp array in order.
 */
function computeLineDiff(origLines: string[], modLines: string[]): DiffOp[] {
  const m = origLines.length;
  const n = modLines.length;

  // LCS table: dp[i][j] = length of LCS of origLines[0..i-1] and modLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce the DiffOp list
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      ops.push({ type: 'equal', text: origLines[i - 1]!, origIdx: i - 1, modIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i][j - 1] ?? 0) >= (dp[i - 1][j] ?? 0))) {
      ops.push({ type: 'insert', text: modLines[j - 1]!, modIdx: j - 1, origIdx: i });
      j--;
    } else {
      ops.push({ type: 'delete', text: origLines[i - 1]!, origIdx: i - 1 });
      i--;
    }
  }

  return ops.reverse();
}

let hunkCounter = 0;

function makeHunkId(): string {
  return `hunk-${++hunkCounter}-${Date.now()}`;
}

/**
 * Computes the list of Hunks from the original and modified file contents.
 *
 * @param originalContent - Content before Claude's edit
 * @param modifiedContent - Content after Claude's edit
 * @returns Array of Hunks; each Hunk represents one contiguous block of change
 */
export function calculateHunks(
  originalContent: string,
  modifiedContent: string
): Hunk[] {
  const origLines = originalContent.split('\n');
  const modLines = modifiedContent.split('\n');

  const ops = computeLineDiff(origLines, modLines);

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const op of ops) {
    if (op.type === 'equal') {
      // Close the current hunk if there is one
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
    } else if (op.type === 'delete') {
      if (!currentHunk) {
        currentHunk = {
          id: makeHunkId(),
          modifiedStart: 0,
          originalStart: op.origIdx,
          removedLines: [],
          addedLines: [],
        };
      }
      if (currentHunk.removedLines.length === 0) {
        currentHunk.originalStart = op.origIdx;
      }
      currentHunk.removedLines.push({
        text: op.text,
        originalLineIndex: op.origIdx,
      });
    } else if (op.type === 'insert') {
      if (!currentHunk) {
        currentHunk = {
          id: makeHunkId(),
          modifiedStart: op.modIdx,
          originalStart: op.origIdx,
          removedLines: [],
          addedLines: [],
        };
      }
      // Anchor modifiedStart at the first inserted line
      if (currentHunk.addedLines.length === 0) {
        currentHunk.modifiedStart = op.modIdx;
      }
      currentHunk.addedLines.push({
        text: op.text,
        modifiedLineIndex: op.modIdx,
      });
    }
  }

  // Push the final hunk if any remains
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  // For pure insert/delete hunks, adjust the offset compensation
  let origOffset = 0;
  for (const hunk of hunks) {
    if (hunk.addedLines.length === 0 && hunk.removedLines.length > 0) {
      const firstOrigIdx = hunk.removedLines[0]!.originalLineIndex;
      hunk.modifiedStart = Math.max(0, firstOrigIdx + origOffset);
    }
    origOffset += hunk.addedLines.length - hunk.removedLines.length;
  }

  let modOffset = 0;
  for (const hunk of hunks) {
    if (hunk.removedLines.length === 0 && hunk.addedLines.length > 0) {
      const firstModIdx = hunk.addedLines[0]!.modifiedLineIndex;
      hunk.originalStart = Math.max(0, firstModIdx + modOffset);
    }
    modOffset += hunk.removedLines.length - hunk.addedLines.length;
  }

  return hunks;
}

