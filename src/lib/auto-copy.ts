export type AutoCopyOptions = {
  enabled: boolean;
  /** Called once the text is on the clipboard. */
  oncopied?: () => void;
};

type AutoCopyEnvironment = {
  /** The completed selection, or null when nothing is selected. */
  readSelection: () => { text: string; editable: boolean } | null;
  writeText?: (text: string) => Promise<void>;
  execCommandCopy: () => boolean;
  now: () => number;
};

const browserEnvironment: AutoCopyEnvironment = {
  readSelection: () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const node = selection.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    return {
      text: selection.toString(),
      editable: !!element?.closest('textarea, input, [contenteditable], .xterm'),
    };
  },
  get writeText() {
    return navigator.clipboard?.writeText
      ? (text: string) => navigator.clipboard.writeText(text)
      : undefined;
  },
  execCommandCopy: () => document.execCommand('copy'),
  now: () => Date.now(),
};

// pointerup and keyup both finish a selection; one gesture must copy and announce once.
const duplicateWindowMs = 400;
let last: { text: string; at: number } | null = null;

export function resetAutoCopy(): void {
  last = null;
}

export function copyCompletedSelection(
  { enabled, oncopied }: AutoCopyOptions,
  environment: AutoCopyEnvironment = browserEnvironment,
): void {
  if (!enabled) return;
  const selection = environment.readSelection();
  if (!selection || selection.editable) return;
  const { text } = selection;
  if (!text.trim()) return;
  const at = environment.now();
  if (last && last.text === text && at - last.at < duplicateWindowMs) return;
  last = { text, at };
  if (environment.writeText) void environment.writeText(text).then(oncopied, () => {});
  else if (environment.execCommandCopy()) oncopied?.();
}
