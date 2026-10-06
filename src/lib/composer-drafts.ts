export type ComposerDraft = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

const drafts = new Map<string, ComposerDraft>();

export function composerDraftKey(
  directory: string,
  agent: string,
  sessionId: string | null,
): string {
  return JSON.stringify([directory, agent, sessionId ?? 'new']);
}

export function rememberComposerDraft(key: string, draft: ComposerDraft): void {
  if (!draft.text) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, {
    text: draft.text,
    selectionStart: Math.max(0, Math.min(draft.selectionStart, draft.text.length)),
    selectionEnd: Math.max(0, Math.min(draft.selectionEnd, draft.text.length)),
  });
}

export function recallComposerDraft(key: string): ComposerDraft | null {
  const draft = drafts.get(key);
  return draft ? { ...draft } : null;
}
