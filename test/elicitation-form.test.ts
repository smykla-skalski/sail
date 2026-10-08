import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elicitationContent,
  elicitationDefaults,
  elicitationFields,
  elicitationSummary,
  missingRequired,
  optionPreviewMetaKey,
} from '../src/lib/elicitation-form.ts';

const askUserQuestions = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string',
      title: 'Database',
      description: 'Which database should we use?',
      oneOf: [
        {
          const: 'Postgres',
          title: 'Postgres (Recommended)',
          description: 'Relational and battle tested',
          _meta: { [optionPreviewMetaKey]: { preview: 'CREATE TABLE users ();' } },
        },
        { const: 'SQLite', title: 'SQLite' },
      ],
    },
    question_0_custom: {
      type: 'string',
      title: 'Other',
      description: 'Type your own answer, or add a note to the option you chose above (optional).',
    },
    question_1: {
      type: 'array',
      title: 'Features',
      description: 'Which features should ship?',
      items: {
        anyOf: [
          { const: 'Search', title: 'Search', description: 'Full text' },
          { const: 'Export', title: 'Export' },
          { const: 'Sync, offline', title: 'Sync, offline' },
        ],
      },
    },
    question_1_custom: { type: 'string', title: 'Other' },
  },
};

await test('parses AskUserQuestion choices and attaches Other companions', () => {
  const fields = elicitationFields(askUserQuestions);
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind]),
    [
      ['question_0', 'single'],
      ['question_1', 'multi'],
    ],
  );
  const [single, multi] = fields;
  assert.ok(single.kind === 'single' && multi.kind === 'multi');
  assert.equal(single.title, 'Database');
  assert.equal(single.description, 'Which database should we use?');
  assert.deepEqual(single.options[0], {
    value: 'Postgres',
    title: 'Postgres (Recommended)',
    description: 'Relational and battle tested',
    preview: 'CREATE TABLE users ();',
  });
  assert.deepEqual(single.options[1], {
    value: 'SQLite',
    title: 'SQLite',
    description: undefined,
    preview: undefined,
  });
  assert.equal(single.other?.key, 'question_0_custom');
  assert.equal(single.other?.kind, 'text');
  assert.deepEqual(
    multi.options.map((option) => option.value),
    ['Search', 'Export', 'Sync, offline'],
  );
  assert.equal(multi.other?.key, 'question_1_custom');
});

await test('keeps plain enum, boolean, number and orphan custom fields as fields', () => {
  const fields = elicitationFields({
    type: 'object',
    properties: {
      approach: { type: 'string', enum: ['safe', 'fast'], default: 'safe' },
      confirm: { type: 'boolean' },
      count: { type: 'integer' },
      note_custom: { type: 'string' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      broken: 'not a property',
    },
    required: ['approach'],
  });
  assert.deepEqual(
    fields.map((field) => [field.key, field.kind, field.required]),
    [
      ['approach', 'enum', true],
      ['confirm', 'boolean', false],
      ['count', 'number', false],
      ['note_custom', 'text', false],
      ['tags', 'multi', false],
    ],
  );
  const [approach] = fields;
  assert.ok(approach.kind === 'enum');
  assert.deepEqual(approach.options, ['safe', 'fast']);
  assert.deepEqual(
    elicitationDefaults({ properties: { approach: { enum: ['safe'], default: 'safe' } } }),
    { approach: 'safe' },
  );
});

await test('builds the content shape claude-agent-acp reads back', () => {
  const fields = elicitationFields(askUserQuestions);
  assert.deepEqual(
    elicitationContent(fields, {
      question_0: 'Postgres',
      question_0_custom: 'keep it boring',
      question_1: ['Sync, offline', 'Search', 'Unknown'],
      question_1_custom: '   ',
    }),
    {
      question_0: 'Postgres',
      question_0_custom: 'keep it boring',
      question_1: ['Search', 'Sync, offline'],
    },
  );
  assert.deepEqual(elicitationContent(fields, { question_1: [], question_0_custom: 'Redis' }), {
    question_0_custom: 'Redis',
  });
  assert.deepEqual(
    elicitationContent(
      elicitationFields({ properties: { approach: { enum: ['safe', 'fast'] } } }),
      {
        approach: 'fast',
      },
    ),
    { approach: 'fast' },
  );
});

await test('reports required fields left blank', () => {
  const fields = elicitationFields({
    properties: { approach: { enum: ['safe'] }, reason: { type: 'string' } },
    required: ['approach', 'reason'],
  });
  assert.deepEqual(
    missingRequired(fields, elicitationContent(fields, { approach: 'safe', reason: ' ' })).map(
      (field) => field.key,
    ),
    ['reason'],
  );
});

await test('summarizes questions for the Inbox', () => {
  assert.equal(
    elicitationSummary('Please answer the following questions.', askUserQuestions),
    '2 questions: Which database should we use? · Which features should ship?',
  );
  assert.equal(
    elicitationSummary('Which database?', {
      properties: { question_0: { type: 'string', title: 'DB', oneOf: [{ const: 'a' }] } },
    }),
    'Which database?',
  );
  assert.equal(elicitationSummary(undefined, null), 'Agent question');
  assert.equal(
    elicitationSummary('Configure deploy', {
      properties: { name: { type: 'string', title: 'Name' }, region: { title: 'Region' } },
    }),
    'Configure deploy',
  );
});
