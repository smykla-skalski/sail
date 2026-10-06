export function branchSlug(value: string, maxLength = 64): string {
  return value
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ø/gi, 'o')
    .replace(/ß/g, 'ss')
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\p{L}\p{N}]/gu, (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 127 ? `u${codePoint.toString(16)}-` : character;
    })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/g, '');
}

export function worktreeBranchName(value: string): string {
  const name = value.trim();
  return name !== 'HEAD' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(name)
    ? name
    : branchSlug(name);
}

export function issueBranch(issue: { number: number; title: string }): string {
  const prefix = `issue-${issue.number}`;
  const available = 64 - prefix.length - 1;
  const slug = branchSlug(issue.title, available);
  return slug && available > 0 ? `${prefix}-${slug}` : prefix;
}

export type GitHubIssueLink = { owner: string; repository: string; number: number };

export function parseGitHubIssueLink(value: string): GitHubIssueLink | null {
  const match = value
    .trim()
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i);
  if (!match) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0
    ? { owner: match[1], repository: match[2], number }
    : null;
}
