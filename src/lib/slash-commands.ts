function closingTicks(text: string, start: number, length: number): number {
  for (let index = start; index < text.length;) {
    if (text[index] !== '`' || (index > 0 && text[index - 1] === '\\')) {
      index++;
      continue;
    }
    let end = index + 1;
    while (text[end] === '`') end++;
    if (end - index === length) return index;
    index = end;
  }
  return -1;
}

export function visibleCommandText(text: string): string {
  let fence: { marker: string; length: number } | null = null;
  const unfenced = text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || (marker[0] === fence.marker && marker.length >= fence.length))) {
        fence = fence ? null : { marker: marker[0], length: marker.length };
        return ' '.repeat(line.length);
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return ' '.repeat(line.length);
      return line;
    })
    .join('\n');

  let visible = '';
  for (let index = 0; index < unfenced.length;) {
    if (unfenced[index] !== '`' || (index > 0 && unfenced[index - 1] === '\\')) {
      visible += unfenced[index];
      index++;
      continue;
    }
    let end = index + 1;
    while (unfenced[end] === '`') end++;
    const close = closingTicks(unfenced, end, end - index);
    if (close < 0) {
      visible += unfenced.slice(index, end);
      index = end;
    } else {
      const after = close + end - index;
      visible += ' '.repeat(after - index);
      index = after;
    }
  }
  return visible;
}

export function slashCommands(text: string): { name: string; end: number }[] {
  return [...visibleCommandText(text).matchAll(/(?:^|\s)\/([^\s/]+)(?=\s|$)/g)].map((match) => ({
    name: match[1],
    end: match.index + match[0].length,
  }));
}
