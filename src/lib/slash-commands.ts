function closingTicks(text: string, start: number, length: number): number {
  for (let index = start; index < text.length;) {
    if (text[index] !== '`') {
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

function escapedTick(text: string, index: number): boolean {
  let slashes = 0;
  for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) slashes++;
  return slashes % 2 === 1;
}

export function visibleCommandText(text: string): string {
  let fence: { marker: string; length: number } | null = null;
  let quote = false;
  const unfenced = text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      const closesFence =
        fence &&
        marker?.[0] === fence.marker &&
        marker.length >= fence.length &&
        line.slice(line.indexOf(marker) + marker.length).trim() === '';
      if (fence) {
        if (closesFence) fence = null;
        return ' '.repeat(line.length);
      }
      if (!line.trim()) quote = false;
      if (/^ {0,3}>/.test(line)) quote = true;
      if (quote) return ' '.repeat(line.length);
      if (marker) {
        fence = { marker: marker[0], length: marker.length };
        return ' '.repeat(line.length);
      }
      if (/^(?: {4}|\t)/.test(line)) return ' '.repeat(line.length);
      return line;
    })
    .join('\n');

  let visible = '';
  for (let index = 0; index < unfenced.length;) {
    if (unfenced[index] !== '`' || escapedTick(unfenced, index)) {
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
