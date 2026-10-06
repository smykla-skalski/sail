export function visibleCommandText(text: string): string {
  let fence: { marker: string; length: number } | null = null;
  let inlineTicks = 0;
  return text
    .split('\n')
    .map((line) => {
      const marker = inlineTicks ? null : /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || (marker[0] === fence.marker && marker.length >= fence.length))) {
        fence = fence ? null : { marker: marker[0], length: marker.length };
        return ' '.repeat(line.length);
      }
      if (fence) return ' '.repeat(line.length);
      let visible = '';
      for (let index = 0; index < line.length;) {
        if (line[index] !== '`' || (index > 0 && line[index - 1] === '\\')) {
          visible += inlineTicks ? ' ' : line[index];
          index++;
          continue;
        }
        let end = index + 1;
        while (line[end] === '`') end++;
        const count = end - index;
        if (!inlineTicks) inlineTicks = count;
        else if (inlineTicks === count) inlineTicks = 0;
        visible += ' '.repeat(count);
        index = end;
      }
      return visible;
    })
    .join('\n');
}

export function slashCommands(text: string): { name: string; end: number }[] {
  return [...visibleCommandText(text).matchAll(/(?:^|\s)\/([^\s/]+)(?=\s|$)/g)].map((match) => ({
    name: match[1],
    end: match.index + match[0].length,
  }));
}
