import { parsePatch, type DiffLine, type FileDiffInfo } from './diff.ts';

export type DiffComment = {
  id: string;
  file: string;
  side: 'old' | 'new';
  start: number;
  sourceStart: number;
  end: number;
  lines: string[];
  deletedLines: number[];
  snapshot: string[] | null;
  duplicateStarts: number[];
  before: string | null;
  after: string | null;
  text: string;
  outdated: boolean;
};

function numberOn(line: DiffLine, side: DiffComment['side']): number | undefined {
  return side === 'old' ? line.oldLine : line.newLine;
}

function content(line: DiffLine): string {
  return line.text.slice(1).replace(/\r$/, '');
}

export function commentRange(
  file: string,
  patch: DiffLine[],
  first: number,
  last: number,
  text: string,
): DiffComment | null {
  const selected = patch.slice(Math.min(first, last), Math.max(first, last) + 1);
  const side: DiffComment['side'] = selected.some((line) => line.kind === 'deleted')
    ? 'old'
    : 'new';
  const numbered = selected.map((line) => numberOn(line, side));
  if (
    !selected.length ||
    numbered.some((number, index) => number === undefined || number !== numbered[0]! + index)
  )
    return null;
  const start = numbered[0]!;
  const end = numbered.at(-1)!;
  const before = patch.findLast((line) => numberOn(line, side) === start - 1);
  const after = patch.find((line) => numberOn(line, side) === end + 1);
  return {
    id: crypto.randomUUID(),
    file,
    side,
    start,
    sourceStart: start,
    end,
    lines: selected.map(content),
    deletedLines: selected.flatMap((line, index) =>
      line.kind === 'deleted' ? [start + index] : [],
    ),
    snapshot: null,
    duplicateStarts: patch.flatMap((line) =>
      numberOn(line, side) !== undefined && content(line) === content(selected[0])
        ? [numberOn(line, side)!]
        : [],
    ),
    before: before ? content(before) : null,
    after: after ? content(after) : null,
    text: text.trim(),
    outdated: false,
  };
}

export function fileLines(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function withSnapshot(comment: DiffComment, contents: string): DiffComment {
  const snapshot = fileLines(contents);
  if (!comment.lines.every((line, offset) => snapshot[comment.sourceStart - 1 + offset] === line))
    throw new Error('The file changed. Refresh the diff and select the line again.');
  return { ...comment, snapshot };
}

function snapshotCandidates(comment: DiffComment, contents: string | null) {
  if (!comment.snapshot || contents === null) return null;
  const current = fileLines(contents);
  const source = comment.snapshot;
  if (current.length === source.length && current.every((line, index) => line === source[index]))
    return [{ index: comment.sourceStart - 1, score: Number.POSITIVE_INFINITY }];
  const span = comment.lines.length;
  const sameRange = (lines: string[], index: number) =>
    comment.lines.every((line, offset) => lines[index + offset] === line);
  const originals = source.flatMap((_, index) => (sameRange(source, index) ? [index] : []));
  const candidates = current.flatMap((_, index) => (sameRange(current, index) ? [index] : []));
  const score = (original: number, candidate: number) => {
    let total = 0;
    for (let distance = 1; distance <= 8; distance++) {
      for (const [oldIndex, newIndex] of [
        [original - distance, candidate - distance],
        [original + span - 1 + distance, candidate + span - 1 + distance],
      ]) {
        if (oldIndex < 0 || newIndex < 0 || oldIndex >= source.length || newIndex >= current.length)
          continue;
        if (source[oldIndex] === current[newIndex]) total += 9 - distance;
      }
    }
    return total;
  };
  const original = comment.sourceStart - 1;
  return candidates
    .filter((candidate) => {
      const ownScore = score(original, candidate);
      return originals.every((other) => other === original || ownScore > score(other, candidate));
    })
    .map((index) => ({ index, score: score(original, index) }))
    .toSorted((a, b) => b.score - a.score);
}

export function reconcileComments(
  comments: DiffComment[],
  files: FileDiffInfo[],
  contents: Record<string, string | null> = {},
): DiffComment[] {
  return comments.map((comment) => {
    const key = `${comment.file}\0${comment.side}`;
    if (key in contents && comment.snapshot) {
      if (contents[key] === null) return { ...comment, outdated: true };
      const matches = snapshotCandidates(comment, contents[key]);
      if (matches === null) return comment;
      const best = matches[0];
      if (!best || matches[1]?.score === best.score) return { ...comment, outdated: true };
      if (comment.side === 'old') {
        const oldPatch = parsePatch(files.find((file) => file.file === comment.file)?.patch ?? '');
        if (
          !oldPatch ||
          !comment.deletedLines.every((number) =>
            oldPatch.some(
              (item) =>
                item.kind === 'deleted' &&
                item.oldLine === best.index + 1 + number - comment.sourceStart &&
                content(item) === comment.lines[number - comment.sourceStart],
            ),
          )
        )
          return { ...comment, outdated: true };
      }
      return {
        ...comment,
        start: best.index + 1,
        end: best.index + comment.lines.length,
        outdated: false,
      };
    }
    const patch = parsePatch(files.find((file) => file.file === comment.file)?.patch ?? '');
    if (!patch) return { ...comment, outdated: true };
    const candidates = patch.flatMap((line, index) => {
      const start = numberOn(line, comment.side);
      if (start === undefined || content(line) !== comment.lines[0]) return [];
      const span = patch.slice(index, index + comment.lines.length);
      if (
        span.length !== comment.lines.length ||
        span.some(
          (item, offset) =>
            numberOn(item, comment.side) !== start + offset ||
            content(item) !== comment.lines[offset],
        )
      )
        return [];
      const before = patch.findLast((item) => numberOn(item, comment.side) === start - 1);
      const after = patch.find(
        (item) => numberOn(item, comment.side) === start + comment.lines.length,
      );
      const context =
        Number(!!before && content(before) === comment.before) +
        Number(!!after && content(after) === comment.after);
      return [{ start, context, distance: Math.abs(start - comment.start) }];
    });
    candidates.sort((a, b) => b.context - a.context || a.distance - b.distance);
    const best = candidates[0];
    if (!best) {
      const neighborhoodVisible = patch.some(
        (line) =>
          (comment.before !== null && content(line) === comment.before) ||
          (comment.after !== null && content(line) === comment.after),
      );
      return { ...comment, outdated: neighborhoodVisible };
    }
    if (
      (comment.duplicateStarts.length > 1 &&
        comment.duplicateStarts.some(
          (start) =>
            start !== comment.start &&
            Math.abs(best.start - start) <= Math.abs(best.start - comment.start),
        )) ||
      (candidates.length > 1 && candidates[1]?.context === best.context) ||
      (best.context === 0 &&
        best.start !== comment.start &&
        (comment.before !== null || comment.after !== null))
    )
      return { ...comment, outdated: true };
    return {
      ...comment,
      start: best.start,
      end: best.start + comment.lines.length - 1,
      duplicateStarts: candidates.map((candidate) => candidate.start),
      outdated: false,
    };
  });
}

export function formatComments(comments: DiffComment[]): string {
  return [
    'Please address these comments on the Changes diff:',
    ...comments.map((comment, index) => {
      const range =
        comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
      const location = `${comment.file}:${range} (${comment.side === 'old' ? 'old' : 'new'} lines${comment.outdated ? ', outdated' : ''})`;
      return `${index + 1}. ${location}\n${comment.text}`;
    }),
  ].join('\n\n');
}
