import { coveredFile, type Plan } from './plan.ts';

export type DiffLine = {
  kind: 'added' | 'deleted' | 'hunk' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
};
export type FileDiffInfo = {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
};
export type DiffAnnotation = { steps: string[]; drift: string[]; unattributed: boolean };
export type WorkingDiffInfo = FileDiffInfo & {
  stagedPatch: string;
  unstagedPatch: string;
  untracked: boolean;
};

export function repoPath(file: string, directory: string): string | null {
  const target = file.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  const root = directory.replaceAll('\\', '/').replaceAll(/\/+/g, '/').replace(/\/$/, '');
  const absolute = target.startsWith('/') || /^[A-Za-z]:\//.test(target);
  const relative = absolute
    ? /^[A-Za-z]:\//.test(target)
      ? target.toLowerCase().startsWith(`${root.toLowerCase()}/`)
        ? target.slice(root.length + 1)
        : null
      : target.startsWith(`${root}/`)
        ? target.slice(root.length + 1)
        : null
    : target;
  if (!relative) return null;
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/') || null;
}

export function selectedDiffFile(
  files: FileDiffInfo[],
  selected: string | null,
  directory: string,
): string | null {
  const key = selected ? repoPath(selected, directory) : null;
  return (
    (key ? files.find((file) => repoPath(file.file, directory) === key)?.file : undefined) ??
    files[0]?.file ??
    null
  );
}

export function annotateDiffs(
  files: FileDiffInfo[],
  plan: Plan | null,
  directory: string,
): Record<string, DiffAnnotation> {
  if (!plan) return {};
  const touched = new Map<string, string[]>();
  for (const step of plan.steps)
    for (const file of step.touched) {
      const key = repoPath(file, directory);
      if (key) touched.set(key, [...(touched.get(key) ?? []), step.title]);
    }
  const outside = new Set(plan.outside.map((file) => repoPath(file, directory)));
  return Object.fromEntries(
    files.map((file) => {
      const key = repoPath(file.file, directory);
      return [
        file.file,
        {
          steps: key ? [...new Set(touched.get(key) ?? [])] : [],
          drift: key
            ? plan.steps
                .filter((step) => step.touched.some((item) => repoPath(item, directory) === key))
                .filter((step) => !coveredFile(file.file, step.files, directory))
                .map((step) => step.title)
            : [],
          unattributed: !!key && outside.has(key),
        },
      ];
    }),
  );
}

export function patchUnavailableReason(patch: string): 'empty' | 'binary' | 'large' | null {
  if (!patch) return 'empty';
  if (patch.length > 250_000) return 'large';
  if (/^(Binary files .* differ|GIT binary patch)$/m.test(patch)) return 'binary';
  if (patch.split('\n').length > 4_000) return 'large';
  return null;
}

export function parsePatch(patch: string): DiffLine[] | null {
  if (patchUnavailableReason(patch)) return null;
  const lines = patch.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return lines.map((text) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (!inHunk || (!text.startsWith(' ') && !text.startsWith('+') && !text.startsWith('-')))
      return { kind: 'context', text };
    if (text.startsWith('+')) return { kind: 'added', text, newLine: newLine++ };
    if (text.startsWith('-')) return { kind: 'deleted', text, oldLine: oldLine++ };
    return { kind: 'context', text, oldLine: oldLine++, newLine: newLine++ };
  });
}
