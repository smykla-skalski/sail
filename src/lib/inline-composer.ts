export const imageToken = (path: string) => `\uE000${encodeURIComponent(path)}\uE001`;
export const imageTokenPattern = /\uE000([^\uE001]*)\uE001/g;

export function composerText(node: Node): string {
  if (node instanceof Text) return node.data;
  if (node instanceof HTMLElement && node.dataset.imageToken) return node.dataset.imageToken;
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes).map(composerText).join('');
}

export function renderInlineComposer(
  element: HTMLElement,
  value: string,
  attachments: { path: string; name: string; remove: () => void }[],
): void {
  element.replaceChildren();
  let previous = 0;
  for (const match of value.matchAll(imageTokenPattern)) {
    if (match.index > previous)
      element.append(document.createTextNode(value.slice(previous, match.index)));
    const path = decodeURIComponent(match[1]);
    const attachment = attachments.find((item) => item.path === path);
    if (attachment) {
      const chip = document.createElement('span');
      chip.className = 'composer-image';
      chip.contentEditable = 'false';
      chip.dataset.imageToken = match[0];
      chip.textContent = `📷 ${attachment.name}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.tabIndex = 0;
      remove.setAttribute('aria-label', `Remove ${attachment.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', attachment.remove);
      remove.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(
          element.querySelectorAll<HTMLButtonElement>('.composer-image button'),
        );
        const index = buttons.indexOf(remove);
        const next = event.shiftKey
          ? (buttons[index - 1] ?? element)
          : (buttons[index + 1] ??
            element.parentElement?.querySelector<HTMLElement>('.agent-composer-footer button'));
        if (!next) return;
        event.preventDefault();
        next.focus();
      });
      chip.append(remove);
      element.append(chip);
    } else element.append(document.createTextNode('[image]'));
    previous = match.index + match[0].length;
  }
  if (previous < value.length) element.append(document.createTextNode(value.slice(previous)));
}
