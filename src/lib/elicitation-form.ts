export const optionPreviewMetaKey = '_claude/askUserQuestionOption';

export type ElicitationOption = {
  value: string;
  title: string;
  description?: string;
  preview?: string;
};

type FieldBase = {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
};

export type ElicitationTextField = FieldBase & { kind: 'text' | 'number' | 'boolean' };

export type ElicitationChoiceField = FieldBase & {
  kind: 'single' | 'multi';
  options: ElicitationOption[];
  other?: ElicitationTextField;
};

export type ElicitationEnumField = FieldBase & { kind: 'enum'; options: string[] };

export type ElicitationField = ElicitationTextField | ElicitationChoiceField | ElicitationEnumField;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function choiceOptions(value: unknown): ElicitationOption[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.flatMap((entry): ElicitationOption[] => {
    const option = record(entry);
    const constant = option?.const;
    if (
      !option ||
      (typeof constant !== 'string' &&
        typeof constant !== 'number' &&
        typeof constant !== 'boolean')
    )
      return [];
    const optionValue = String(constant);
    const meta = record(record(option['_meta'])?.[optionPreviewMetaKey]);
    return [
      {
        value: optionValue,
        title: text(option.title) ?? optionValue,
        description: text(option.description),
        preview: text(meta?.preview),
      },
    ];
  });
  return options.length ? options : null;
}

function enumOptions(value: unknown): ElicitationOption[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value.map((entry) => ({ value: String(entry), title: String(entry) }));
}

function field(
  key: string,
  property: Record<string, unknown>,
  required: boolean,
): ElicitationField {
  const base: FieldBase = {
    key,
    title: text(property.title),
    description: text(property.description),
    required,
  };
  const items = record(property.items);
  if (property.type === 'array' && items) {
    const options =
      choiceOptions(items.anyOf) ?? choiceOptions(items.oneOf) ?? enumOptions(items.enum);
    if (options) return { ...base, kind: 'multi', options } satisfies ElicitationChoiceField;
  }
  const single = choiceOptions(property.oneOf) ?? choiceOptions(property.anyOf);
  if (single) return { ...base, kind: 'single', options: single } satisfies ElicitationChoiceField;
  if (Array.isArray(property.enum))
    return {
      ...base,
      kind: 'enum',
      options: property.enum.map(String),
    } satisfies ElicitationEnumField;
  const kind =
    property.type === 'boolean'
      ? 'boolean'
      : property.type === 'number' || property.type === 'integer'
        ? 'number'
        : 'text';
  return { ...base, kind } satisfies ElicitationTextField;
}

/**
 * Parses an ACP form elicitation schema. Handles the AskUserQuestion shape from
 * claude-agent-acp: `oneOf` single choice, `items.anyOf` multi-select, and a
 * `<key>_custom` free-text companion attached to its question as `other`.
 */
export function elicitationFields(schema: Record<string, unknown>): ElicitationField[] {
  const properties = record(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const parsed = Object.entries(properties).flatMap(([key, value]) => {
    const property = record(value);
    return property ? [field(key, property, required.has(key))] : [];
  });
  const choices = new Map(
    parsed.flatMap((entry) =>
      entry.kind === 'single' || entry.kind === 'multi' ? [[entry.key, entry] as const] : [],
    ),
  );
  const companions = new Set<string>();
  for (const entry of parsed) {
    if (entry.kind !== 'text' || !entry.key.endsWith('_custom')) continue;
    const parent = choices.get(entry.key.slice(0, -'_custom'.length));
    if (!parent || parent.other) continue;
    parent.other = entry;
    companions.add(entry.key);
  }
  return parsed.filter((entry) => !companions.has(entry.key));
}

export function elicitationDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = record(schema.properties) ?? {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => {
      const fallback = record(value)?.default;
      return fallback === undefined ? [] : [[key, fallback]];
    }),
  );
}

function blank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}

/** Content for an accepted elicitation; blank answers are omitted so skipped questions stay unanswered. */
export function elicitationContent(
  fields: ElicitationField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const put = (entry: ElicitationField) => {
    const value = values[entry.key];
    if (blank(value)) return;
    if (entry.kind === 'multi') {
      const picked = new Set((Array.isArray(value) ? value : [value]).map(String));
      const selected = entry.options
        .map((option) => option.value)
        .filter((option) => picked.has(option));
      if (selected.length) content[entry.key] = selected;
      return;
    }
    if (entry.kind === 'single' || entry.kind === 'enum') {
      content[entry.key] = String(value);
      return;
    }
    content[entry.key] = value;
  };
  for (const entry of fields) {
    put(entry);
    if ((entry.kind === 'single' || entry.kind === 'multi') && entry.other) put(entry.other);
  }
  return content;
}

export function missingRequired(
  fields: ElicitationField[],
  content: Record<string, unknown>,
): ElicitationField[] {
  return fields
    .flatMap((entry) =>
      (entry.kind === 'single' || entry.kind === 'multi') && entry.other
        ? [entry, entry.other]
        : [entry],
    )
    .filter((entry) => entry.required && blank(content[entry.key]));
}

/** One-line Inbox text: the message, or each question when the message only introduces several. */
export function elicitationSummary(message: unknown, schema: unknown): string {
  const questions = elicitationFields(record(schema) ?? {})
    .filter((entry) => entry.kind === 'single' || entry.kind === 'multi')
    .map((entry) => entry.description ?? entry.title)
    .filter((entry): entry is string => Boolean(entry));
  if (questions.length > 1) return `${questions.length} questions: ${questions.join(' · ')}`;
  return (typeof message === 'string' && message.trim()) || questions[0] || 'Agent question';
}
