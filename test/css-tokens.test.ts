import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suiStyles = 'node_modules/@smykla-skalski/sui/dist/styles.css';
// Token files define colors as custom properties; every other style refers to them.
const tokenFiles = new Set(['src/style.css']);

// Reviewed literal colors outside token files: shadows, scrims, diff tints and the
// GitHub check dots. Counts must match exactly so new literals and stale entries both fail.
const literalAllowlist: Record<string, Record<string, number>> = {
  'src/AgentStatusBar.svelte': { '#0004': 1 },
  'src/AgentWorkspace.svelte': { '#0003': 1, '#0009': 1 },
  'src/Diagram.svelte': { 'rgb(0 0 0 / 70%)': 1 },
  'src/DiffPanel.svelte': { 'rgba(37, 153, 103, 0.13)': 1, 'rgba(213, 82, 82, 0.13)': 1 },
  'src/OptionPicker.svelte': { '#0002': 1 },
  'src/ReviewEvidencePanel.svelte': { '#111': 1, '#0008': 1 },
  'src/SkillMenu.svelte': { '#0005': 1 },
  'src/style.css': {
    '#111': 1,
    '#3fb950': 1,
    '#f85149': 1,
    '#d29922': 1,
    'rgb(0 0 0 / 16%)': 1,
    '#0004': 1,
    '#07131099': 1,
    '#0005': 2,
    '#0008': 3,
  },
};

const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue
  darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
  darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise
  darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred
  indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
  maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen accentcolor accentcolortext activetext buttonborder buttonface
  buttontext canvas canvastext field fieldtext graytext highlight highlighttext linktext mark
  marktext selecteditem selecteditemtext visitedtext`.split(/\s+/),
);

const hexLengths = new Set([4, 5, 7, 9]);

type Source = { file: string; text: string };
type Chunk = { file: string; css: string; line: number };

function walk(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : /\.(svelte|css|ts)$/.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}

const sources: Source[] = walk('src').map((file) => ({
  file: relative(root, join(root, file)),
  text: readFileSync(join(root, file), 'utf8'),
}));

function lineAt(text: string, index: number) {
  return text.slice(0, index).split('\n').length;
}

function styleChunks(source: Source): Chunk[] {
  if (source.file.endsWith('.css')) return [{ file: source.file, css: source.text, line: 1 }];
  if (!source.file.endsWith('.svelte')) return [];
  const chunks: Chunk[] = [];
  for (const match of source.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
    chunks.push({
      file: source.file,
      css: match[1],
      line: lineAt(source.text, match.index + match[0].indexOf('>') + 1),
    });
  // Svelte `{expr}` holes become a placeholder, so a dynamic value still parses and a dynamic
  // font size is reported as unresolved instead of being skipped.
  const markup = (css: string, index: number) =>
    chunks.push({
      file: source.file,
      css: `${css.replaceAll(/\{[^{}]*\}/g, 'dynamic-value')};`,
      line: lineAt(source.text, index),
    });
  for (const match of source.text.matchAll(/\sstyle=(?:"([^"]*)"|\{(['"`])([\s\S]*?)\2\})/g))
    markup(inlineExpressions(match[1] ?? match[3]), match.index);
  for (const match of source.text.matchAll(
    /\sstyle:([\w-]+)(?:\|important)?=(?:"([^"]*)"|\{(['"`])([\s\S]*?)\3\})/g,
  ))
    markup(`${match[1]}: ${inlineExpressions(match[2] ?? match[4])}`, match.index);
  for (const match of source.text.matchAll(
    /\s(fill|stroke|stop-color|flood-color|lighting-color|font-size)="([^"]*)"/g,
  ))
    markup(`${match[1]}: ${match[2]}`, match.index);
  for (const match of source.text.matchAll(/\s(?:style:)?(font-size|font)=\{(?!['"`])/g))
    markup(`${match[1]}: dynamic-value`, match.index);
  return chunks;
}

// Template expressions can hold literal colors, so keep their text without quotes.
function inlineExpressions(css: string) {
  return css.replaceAll(/\$\{([^}]*)\}/g, (_, expression: string) =>
    expression.replaceAll(/['"`]/g, ''),
  );
}

function withoutComments(text: string) {
  return text.replaceAll(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) =>
    comment.replaceAll(/[^\n]/g, ' '),
  );
}

function declarations(chunk: Chunk) {
  const css = withoutComments(chunk.css);
  return [...css.matchAll(/(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)(?=[;}])/g)].map((match) => ({
    property: match[1],
    value: match[2],
    line: chunk.line + lineAt(css, match.index) - 1,
  }));
}

function literalColors(value: string): string[] {
  const cleaned = value
    .replaceAll(/(["'])(?:(?!\1).)*\1/g, '')
    .replaceAll(/url\([^)]*\)/g, '')
    .replaceAll(/--[\w-]+/g, '');
  const literals: string[] = [];
  for (const match of cleaned.matchAll(/#[0-9a-fA-F]+\b/g))
    if (hexLengths.has(match[0].length)) literals.push(match[0]);
  for (const match of cleaned.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/g))
    literals.push(match[0]);
  for (const match of cleaned.matchAll(/\b[a-zA-Z]+\b/g))
    if (namedColors.has(match[0].toLowerCase())) literals.push(match[0]);
  return literals;
}

void test('every var() reference names a defined custom property', () => {
  const definitions = new Set<string>();
  for (const text of [
    readFileSync(join(root, suiStyles), 'utf8'),
    ...sources.map((s) => s.text),
  ].map(withoutComments)) {
    for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) definitions.add(match[1]);
    for (const match of text.matchAll(/style:(--[\w-]+)/g)) definitions.add(match[1]);
    for (const match of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g))
      definitions.add(match[1]);
  }
  const missing = sources.flatMap((source) =>
    [...source.text.matchAll(/var\(\s*(--[\w-]+)/g)]
      .filter((match) => !definitions.has(match[1]))
      .map((match) => `${source.file}:${lineAt(source.text, match.index)} ${match[1]}`),
  );
  assert.deepEqual(missing, []);
});

void test('literal colors stay in token files or the reviewed allowlist', () => {
  const found: Record<string, Record<string, number>> = {};
  const locations: string[] = [];
  for (const chunk of sources.flatMap(styleChunks)) {
    for (const declaration of declarations(chunk)) {
      if (tokenFiles.has(chunk.file) && declaration.property.startsWith('--')) continue;
      for (const literal of literalColors(declaration.value)) {
        found[chunk.file] ??= {};
        found[chunk.file][literal] = (found[chunk.file][literal] ?? 0) + 1;
        locations.push(`${chunk.file}:${declaration.line} ${literal}`);
      }
    }
  }
  const unexpected = locations.filter((location) => {
    const [file, literal] = [location.split(':')[0], location.split(' ').slice(1).join(' ')];
    return (found[file][literal] ?? 0) > (literalAllowlist[file]?.[literal] ?? 0);
  });
  assert.deepEqual(unexpected, [], 'Use a token from src/style.css or sui instead');
  const stale = Object.entries(literalAllowlist).flatMap(([file, literals]) =>
    Object.entries(literals)
      .filter(([literal, count]) => (found[file]?.[literal] ?? 0) !== count)
      .map(
        ([literal, count]) =>
          `${file} ${literal}: allowed ${count}, found ${found[file]?.[literal] ?? 0}`,
      ),
  );
  assert.deepEqual(stale, [], 'Update the literal color allowlist');
});

// Reviewed font sizes below the 12 px minimum; counts must match exactly. SpawnActivity
// uses 0 to hide a long label on narrow screens behind a readable ::after label.
const smallTypeAllowlist: Record<string, Record<string, number>> = {
  'src/SpawnActivity.svelte': { '0': 1 },
};
// Reviewed font-size values the check cannot resolve to px, with exact counts.
const unresolvedTypeAllowlist: Record<string, Record<string, number>> = {};
const minimumFontSize = 12;
// CSS-wide keywords keep the inherited size, which is checked where it is set.
const inheritedSize = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

type FontSize = { px: number } | { unresolved: string } | null;

/** Resolves a token to its value, or a `var(--x, fallback)` fallback when the token is unknown. */
function resolveVar(value: string, tokens: Theme): string | null {
  const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value);
  if (!reference) return value;
  return tokens[reference[1]] ?? reference[2]?.trim() ?? null;
}

function fontSize(property: string, raw: string, tokens: Theme, depth = 0): FontSize {
  if (property !== 'font-size' && property !== 'font') return null;
  const value = raw.replace(/\s*!\s*important\s*$/i, '').trim();
  if (inheritedSize.has(value.toLowerCase())) return null;
  const size =
    property === 'font-size'
      ? value
      : /(var\(--[\w-]+(?:\s*,[^)]*)?\)|\d*\.?\d+(?:px|rem)\b)/.exec(value)?.[1];
  if (size === undefined) return { unresolved: value };
  const resolved = resolveVar(size, tokens);
  if (resolved === null || depth > 4) return { unresolved: value };
  // clamp() never renders below its first argument, so that minimum is the size to check.
  const clamp = /^clamp\(\s*([^,]+?)\s*,/i.exec(resolved);
  if (resolved !== size || clamp) {
    const inner = fontSize('font-size', clamp ? clamp[1] : resolved, tokens, depth + 1);
    return inner && 'unresolved' in inner ? { unresolved: value } : inner;
  }
  const length = /^(\d*\.?\d+)(px|rem)?$/i.exec(size);
  if (!length || (!length[2] && Number(length[1]) !== 0)) return { unresolved: value };
  return { px: Number(length[1]) * (length[2]?.toLowerCase() === 'rem' ? 16 : 1) };
}

void test('font sizes resolve to px, or fail unless reviewed', () => {
  const tokens = themeBlocks(readFileSync(join(root, 'src/style.css'), 'utf8')).light;
  const cases: [string, string, FontSize][] = [
    ['font-size', 'var(--type-11)', { px: 11 }],
    ['font', '600 0.8125rem/1.125rem var(--sui-font)', { px: 13 }],
    ['font', 'var(--type-12)/1.5 ui-monospace, monospace', { px: 12 }],
    ['font-size', '11px !important', { px: 11 }],
    ['font-size', '11PX ! important', { px: 11 }],
    ['font-size', 'dynamic-valuepx', { unresolved: 'dynamic-valuepx' }],
    ['font-size', 'var(--undefined-size, 12px)', { px: 12 }],
    ['font-size', 'var(--undefined-size, 10px) !important', { px: 10 }],
    ['font-size', 'var(--undefined-size)', { unresolved: 'var(--undefined-size)' }],
    ['font-size', '0.9em', { unresolved: '0.9em' }],
    ['font-size', '90%', { unresolved: '90%' }],
    ['font-size', 'small', { unresolved: 'small' }],
    ['font-size', 'calc(1rem - 2px)', { unresolved: 'calc(1rem - 2px)' }],
    ['font-size', 'clamp(10px, 2vw, 14px)', { px: 10 }],
    ['font-size', 'clamp(var(--type-12), 2vw, 3rem)', { px: 12 }],
    ['font-size', 'clamp(1em, 2vw, 3rem)', { unresolved: 'clamp(1em, 2vw, 3rem)' }],
    ['font', 'menu', { unresolved: 'menu' }],
    ['font', 'inherit', null],
    ['font-size', 'inherit', null],
    ['color', '11px', null],
  ];
  for (const [property, value, expected] of cases)
    assert.deepEqual(fontSize(property, value, tokens), expected, `${property}: ${value}`);
});

void test('font sizes stay at or above 12 px outside the reviewed allowlist', () => {
  const tokens = themeBlocks(readFileSync(join(root, 'src/style.css'), 'utf8')).light;
  const small: Record<string, Record<string, number>> = {};
  const unresolved: Record<string, Record<string, number>> = {};
  const locations: string[] = [];
  const unreadable: string[] = [];
  for (const chunk of sources.flatMap(styleChunks)) {
    for (const declaration of declarations(chunk)) {
      const size = fontSize(declaration.property, declaration.value, tokens);
      if (size === null) continue;
      const where = `${chunk.file}:${declaration.line} ${declaration.value.trim()}`;
      if ('unresolved' in size) {
        unresolved[chunk.file] ??= {};
        unresolved[chunk.file][size.unresolved] =
          (unresolved[chunk.file][size.unresolved] ?? 0) + 1;
        if (
          unresolved[chunk.file][size.unresolved] >
          (unresolvedTypeAllowlist[chunk.file]?.[size.unresolved] ?? 0)
        )
          unreadable.push(where);
        continue;
      }
      if (size.px >= minimumFontSize) continue;
      const value = String(size.px);
      small[chunk.file] ??= {};
      small[chunk.file][value] = (small[chunk.file][value] ?? 0) + 1;
      if (small[chunk.file][value] > (smallTypeAllowlist[chunk.file]?.[value] ?? 0))
        locations.push(where);
    }
  }
  assert.deepEqual(locations, [], 'Use var(--type-12) or a larger type token from src/style.css');
  assert.deepEqual(
    unreadable,
    [],
    'Use a px, rem or type token size, or review the value in unresolvedTypeAllowlist',
  );
  const stale = [
    ...Object.entries(smallTypeAllowlist).flatMap(([file, sizes]) =>
      Object.entries(sizes)
        .filter(([size, count]) => (small[file]?.[size] ?? 0) !== count)
        .map(
          ([size, count]) =>
            `${file} ${size}px: allowed ${count}, found ${small[file]?.[size] ?? 0}`,
        ),
    ),
    ...Object.entries(unresolvedTypeAllowlist).flatMap(([file, values]) =>
      Object.entries(values)
        .filter(([value, count]) => (unresolved[file]?.[value] ?? 0) !== count)
        .map(
          ([value, count]) =>
            `${file} ${value}: allowed ${count}, found ${unresolved[file]?.[value] ?? 0}`,
        ),
    ),
  ];
  assert.deepEqual(stale, [], 'Update the font size allowlists');
});

type Theme = Record<string, string>;
type Rgb = [number, number, number];

function themeBlocks(css: string): { light: Theme; dark: Theme } {
  const light: Theme = {};
  const dark: Theme = {};
  for (const match of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = new Set(match[1].split(',').map((selector) => selector.trim()));
    const target = selectors.has(':root')
      ? light
      : selectors.has(":root[data-sui-theme='dark']")
        ? dark
        : null;
    if (!target) continue;
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      target[declaration[1]] = declaration[2].trim();
  }
  return { light, dark };
}

const sui = themeBlocks(readFileSync(join(root, suiStyles), 'utf8'));
const shell = themeBlocks(readFileSync(join(root, 'src/style.css'), 'utf8'));
const themes: Record<'light' | 'dark', Theme> = {
  light: { ...sui.light, ...shell.light },
  dark: { ...sui.light, ...shell.light, ...sui.dark, ...shell.dark },
};

function resolve(theme: Theme, token: string, seen = new Set<string>()): Rgb {
  const value = theme[token];
  assert.ok(value, `${token} is not defined`);
  assert.ok(!seen.has(token), `${token} refers to itself`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) return resolve(theme, reference[1], new Set([...seen, token]));
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  assert.ok(hex, `${token} must be an opaque hex color, found ${value}`);
  const full = hex[1].length === 3 ? hex[1].replaceAll(/./g, '$&$&') : hex[1];
  const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return [channel(0), channel(1), channel(2)];
}

type Color = string | { mix: string; percent: number; over: Color };

function color(theme: Theme, value: Color): Rgb {
  if (typeof value === 'string') return resolve(theme, value);
  const top = resolve(theme, value.mix);
  const base = color(theme, value.over);
  const weight = value.percent / 100;
  const blend = (index: number) => Math.round(top[index] * weight + base[index] * (1 - weight));
  return [blend(0), blend(1), blend(2)];
}

function linear(channel: number) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: Rgb) {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(first: Rgb, second: Rgb) {
  const [light, dark] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

const baseSurfaces: Color[] = [
  '--sui-canvas',
  '--sui-surface',
  '--sui-subtle',
  '--shell-sidebar',
  '--shell-selected',
  '--shell-hover',
];
// Sidebar subagent rows tint the sidebar with the primary color.
const subagentRow: Color = { mix: '--sui-primary', percent: 5, over: '--shell-sidebar' };
const surfaces: Color[] = [...baseSurfaces, subagentRow];
const textTokens = [
  '--sui-foreground',
  '--sui-muted',
  '--shell-muted',
  '--sui-primary',
  '--shell-selected-ink',
  '--sui-danger',
  '--sui-danger-ink',
  '--sui-warning-ink',
  '--sui-success-ink',
  '--activity-working',
  '--activity-waiting',
  '--activity-completed',
  '--activity-failed',
  '--activity-neutral',
];
const activityTokens = textTokens.filter((token) => token.startsWith('--activity-'));
const textPairs: [Color, Color][] = [
  ...textTokens.flatMap((token) => surfaces.map((surface): [Color, Color] => [token, surface])),
  ...activityTokens.flatMap((token) =>
    surfaces.map((surface): [Color, Color] => [token, { mix: token, percent: 8, over: surface }]),
  ),
  ['--sui-primary-foreground', '--sui-primary'],
  ['--sui-danger-foreground', '--sui-danger'],
  ['--sui-danger-ink', '--sui-danger-subtle'],
  ['--sui-warning-ink', '--sui-warning-subtle'],
  ['--sui-success-ink', '--sui-success-subtle'],
  ...[subagentRow, '--shell-selected', '--shell-hover'].map((row): [Color, Color] => [
    '--shell-selected-ink',
    { mix: '--sui-primary', percent: 12, over: row },
  ]),
];
const componentPairs: [Color, Color][] = [
  ...['--shell-control-border', '--sui-primary', '--sui-focus'].flatMap((token) =>
    baseSurfaces.map((surface): [Color, Color] => [token, surface]),
  ),
  ['--sui-danger', '--sui-surface'],
  ['--sui-danger', '--sui-canvas'],
];

function label(value: Color): string {
  return typeof value === 'string'
    ? value
    : `${value.mix} ${value.percent}% over ${label(value.over)}`;
}

void test('both token files define a dark theme that differs from light', () => {
  for (const [file, blocks] of [
    [suiStyles, sui],
    ['src/style.css', shell],
  ] as const) {
    assert.ok(Object.keys(blocks.light).length > 0, `${file} has no light tokens`);
    assert.ok(Object.keys(blocks.dark).length > 0, `${file} has no dark tokens`);
  }
  for (const token of ['--sui-canvas', '--sui-foreground', '--sui-surface'])
    assert.notDeepEqual(resolve(themes.dark, token), resolve(themes.light, token), token);
});

for (const name of ['light', 'dark'] as const) {
  void test(`${name} token pairs meet WCAG 2.2 AA contrast`, () => {
    const theme = themes[name];
    const checks: [Color, Color, number][] = [
      ...textPairs.map(([foreground, background]): [Color, Color, number] => [
        foreground,
        background,
        4.5,
      ]),
      ...componentPairs.map(([foreground, background]): [Color, Color, number] => [
        foreground,
        background,
        3,
      ]),
    ];
    const failures = checks.flatMap(([foreground, background, minimum]) => {
      const ratio = contrast(color(theme, foreground), color(theme, background));
      return ratio < minimum
        ? [`${label(foreground)} on ${label(background)}: ${ratio.toFixed(2)} < ${minimum}`]
        : [];
    });
    assert.deepEqual(failures, []);
  });
}

void test('both transcript renderers fill the width with one fixed gutter', () => {
  const style = readFileSync(join(root, 'src/style.css'), 'utf8');
  assert.match(style, /\n {2}--transcript-gutter: 20px;\n/);
  const containers: [string, RegExp][] = [
    ['src/style.css', /\n\.conversation \{([^}]*)\}/],
    ['src/AgentWorkspace.svelte', /\n {2}\.agent-conversation \{([^}]*)\}/],
  ];
  for (const [file, rule] of containers) {
    const body = rule.exec(readFileSync(join(root, file), 'utf8'))?.[1];
    assert.ok(body, file);
    assert.match(
      body,
      file === 'src/style.css'
        ? /padding: 28px var\(--transcript-gutter\);/
        : /padding-inline: var\(--transcript-gutter\);/,
      file,
    );
    assert.doesNotMatch(body, /max-width|margin[^:]*:[^;]*auto|--transcript-measure/, file);
  }
  for (const { file, text } of sources) assert.doesNotMatch(text, /--transcript-measure/, file);
  assert.doesNotMatch(
    readFileSync(join(root, 'src/style.css'), 'utf8'),
    /\.chat-area > (?:\.chat-body > )?\.conversation[^{]*\{[^}]*padding-inline/,
  );
});
