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
  let fence: { marker: string; length: number; contentIndent: number } | null = null;
  let quote = false;
  const listIndents: number[] = [];
  const unfenced = text
    .split('\n')
    .map((line) => {
      if (fence) {
        const indentation = /^ */.exec(line)![0].length;
        if (line.trim() && indentation < fence.contentIndent) {
          fence = null;
        } else {
          const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.slice(fence.contentIndent))?.[1];
          if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = null;
          return ' '.repeat(line.length);
        }
      }
      if (!line.trim()) quote = false;
      if (/^ {0,3}>/.test(line)) quote = true;
      if (quote) return ' '.repeat(line.length);

      const indentation = /^ */.exec(line)![0].length;
      const listMarker = /^( *)(?:[-+*]|\d{1,9}[.)])([ \t]{1,4})/.exec(line);
      const list = listMarker && indentation <= (listIndents.at(-1) ?? 0) + 3 ? listMarker : null;
      if (list) {
        while (listIndents.at(-1) && indentation < listIndents.at(-1)!) listIndents.pop();
        listIndents.push(list[0].length);
      } else if (line.trim()) {
        while (listIndents.at(-1) && indentation < listIndents.at(-1)!) listIndents.pop();
      }
      const contentIndent = list ? list[0].length : (listIndents.at(-1) ?? 0);
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line.slice(contentIndent))?.[1];
      if (opening) {
        fence = { marker: opening[0], length: opening.length, contentIndent };
        return ' '.repeat(line.length);
      }
      if (indentation >= contentIndent + 4 || line.startsWith('\t')) return ' '.repeat(line.length);
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
