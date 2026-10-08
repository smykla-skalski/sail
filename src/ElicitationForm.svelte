<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@smykla-skalski/sui';
  import type { StructuredQuestion } from './lib/planning-state';
  import {
    canClearChoice,
    elicitationContent,
    elicitationDefaults,
    elicitationFields,
    missingRequired,
    type ElicitationChoiceField,
    type ElicitationTextField,
  } from './lib/elicitation-form';

  export type Elicitation = StructuredQuestion;

  interface Props {
    elicitation: Elicitation;
    agent: string;
    onanswer: (
      elicitation: Elicitation,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>,
    ) => Promise<void>;
  }

  let { elicitation, agent, onanswer }: Props = $props();
  const fields = $derived(elicitationFields(elicitation.schema));
  const choiceCount = $derived(
    fields.filter((field) => field.kind === 'single' || field.kind === 'multi').length,
  );
  const formId = $derived(`elicitation-${String(elicitation.id).replace(/[^\w-]/g, '_')}`);
  let values = $state(untrack(() => elicitationDefaults(elicitation.schema)));
  let focused = $state<Record<string, string>>({});
  let error = $state('');

  function set(key: string, value: unknown) {
    values = { ...values, [key]: value };
  }

  function toggle(key: string, option: string, checked: boolean) {
    const current = Array.isArray(values[key]) ? values[key].map(String) : [];
    set(key, checked ? [...current, option] : current.filter((item) => item !== option));
  }

  function selected(field: ElicitationChoiceField, option: string): boolean {
    const value = values[field.key];
    return field.kind === 'multi'
      ? Array.isArray(value) && value.map(String).includes(option)
      : value === option;
  }

  function clear(field: ElicitationChoiceField, event: MouseEvent) {
    const group = (event.currentTarget as HTMLElement).closest('fieldset');
    set(field.key, undefined);
    group?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
  }

  function preview(field: ElicitationChoiceField) {
    const shown =
      field.options.find((option) => option.value === focused[field.key] && option.preview) ??
      field.options.find((option) => selected(field, option.value) && option.preview);
    return shown ? { title: shown.title, text: shown.preview } : null;
  }

  async function answer(action: 'accept' | 'decline' | 'cancel') {
    const content = elicitationContent(fields, values);
    if (action === 'accept' && missingRequired(fields, content).length) {
      error = 'Complete all required fields.';
      return;
    }
    error = '';
    await onanswer(elicitation, action, action === 'accept' ? content : undefined);
  }
</script>

{#snippet textInput(field: ElicitationTextField, id: string)}
  {#if field.kind === 'boolean'}
    <input
      {id}
      type="checkbox"
      checked={values[field.key] === true}
      onchange={(event) => set(field.key, event.currentTarget.checked)}
    />
  {:else}
    <input
      {id}
      type={field.kind === 'number' ? 'number' : 'text'}
      required={field.required}
      value={String(values[field.key] ?? '')}
      oninput={(event) =>
        set(
          field.key,
          field.kind === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value,
        )}
    />
  {/if}
{/snippet}

<div
  class="elicitation agent-permission"
  role="group"
  aria-label="Agent question"
  data-request-id={elicitation.id}
  data-session-id={elicitation.sessionId}
  data-agent-id={agent}
  tabindex="-1"
>
  <header class="elicitation-heading">
    <p class="elicitation-eyebrow">
      {typeof elicitation.schema.title === 'string' && elicitation.schema.title.trim()
        ? elicitation.schema.title
        : 'Agent question'}
    </p>
    <p class="elicitation-message">{elicitation.message || 'The agent needs an answer.'}</p>
  </header>
  {#each fields as field (field.key)}
    {@const id = `${formId}-${field.key}`}
    {#if field.kind === 'single' || field.kind === 'multi'}
      {@const shown = preview(field)}
      <section class="elicitation-question" data-question={field.key}>
        <fieldset>
          <legend>
            {#if field.title}<span class="elicitation-header">{field.title}</span>{/if}
            {#if field.description && choiceCount > 1}<span class="elicitation-text"
                >{field.description}</span
              >{:else if !field.title}<span class="elicitation-text">{field.key}</span>{/if}
            {#if field.kind === 'multi'}<span class="elicitation-hint">Select all that apply</span
              >{/if}
          </legend>
          <div class="elicitation-options">
            {#each field.options as option, index (option.value)}
              <label class="elicitation-option" data-option={option.value}>
                <input
                  type={field.kind === 'multi' ? 'checkbox' : 'radio'}
                  name={id}
                  value={option.value}
                  checked={selected(field, option.value)}
                  aria-describedby={option.description ? `${id}-option-${index}` : undefined}
                  onfocus={() => (focused = { ...focused, [field.key]: option.value })}
                  onchange={(event) => {
                    focused = { ...focused, [field.key]: option.value };
                    if (field.kind === 'multi')
                      toggle(field.key, option.value, event.currentTarget.checked);
                    else set(field.key, option.value);
                  }}
                />
                <span class="elicitation-option-body">
                  <span class="elicitation-option-title">{option.title}</span>
                  {#if option.description}<span
                      class="elicitation-option-description"
                      id={`${id}-option-${index}`}>{option.description}</span
                    >{/if}
                </span>
              </label>
            {/each}
          </div>
          {#if canClearChoice(field, values[field.key])}
            <div class="elicitation-clear">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Clear choice${field.title ? ` for ${field.title}` : ''}`}
                onclick={(event: MouseEvent) => clear(field, event)}>Clear choice</Button
              >
            </div>
          {/if}
          {#if shown}
            <figure class="elicitation-preview">
              <figcaption>Preview · {shown.title}</figcaption>
              <textarea
                readonly
                rows={Math.min(12, (shown.text ?? '').split('\n').length)}
                aria-label={`Preview of ${shown.title}`}
                value={shown.text}></textarea>
            </figure>
          {/if}
          {#if field.other}
            {@const other = field.other}
            <div class="elicitation-other">
              <label for={`${id}-other`}
                >{other.title ?? 'Other'}
                {#if !other.description}<span>(optional)</span>{/if}</label
              >
              {#if other.description}<small id={`${id}-other-description`}
                  >{other.description}</small
                >{/if}
              <input
                id={`${id}-other`}
                type="text"
                value={String(values[other.key] ?? '')}
                aria-describedby={other.description ? `${id}-other-description` : undefined}
                oninput={(event) => set(other.key, event.currentTarget.value)}
              />
            </div>
          {/if}
        </fieldset>
      </section>
    {:else}
      <div class="elicitation-field" data-question={field.key}>
        <label for={id}>{field.title ?? field.key}</label>
        {#if field.description}<small>{field.description}</small>{/if}
        {#if field.kind === 'enum'}
          <select
            {id}
            value={String(values[field.key] ?? '')}
            oninput={(event) => set(field.key, event.currentTarget.value)}
            onchange={(event) => set(field.key, event.currentTarget.value)}
          >
            <option value="">Choose…</option>{#each field.options as option (option)}<option
                value={option}>{option}</option
              >{/each}
          </select>
        {:else if field.kind === 'text' || field.kind === 'number' || field.kind === 'boolean'}
          {@render textInput(field, id)}
        {/if}
      </div>
    {/if}
  {/each}
  {#if error}<p class="elicitation-error" role="alert">{error}</p>{/if}
  <div class="elicitation-actions">
    <Button size="sm" variant="primary" onclick={() => void answer('accept')}>Submit</Button><Button
      size="sm"
      variant="secondary"
      onclick={() => void answer('decline')}>Decline</Button
    ><Button size="sm" variant="secondary" onclick={() => void answer('cancel')}>Cancel</Button>
  </div>
</div>

<style>
  .elicitation {
    display: grid;
    gap: var(--space-16);
    box-sizing: border-box;
    width: 100%;
    max-width: 60rem;
    max-height: min(50vh, 40rem);
    margin: 0 0 10px;
    padding: var(--space-16);
    overflow-y: auto;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-8);
    background: var(--sui-surface);
  }
  .elicitation p {
    margin: 0;
  }
  .elicitation-heading {
    display: grid;
    gap: 2px;
  }
  .elicitation-eyebrow,
  .elicitation-header {
    color: var(--sui-muted);
    font-size: var(--type-12);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .elicitation-message {
    font-size: var(--type-16);
    font-weight: 600;
    line-height: 1.35;
  }
  .elicitation-question {
    min-width: 0;
  }
  .elicitation-question fieldset {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .elicitation-question + .elicitation-question {
    padding-top: var(--space-16);
    border-top: 1px solid var(--shell-divider);
  }
  .elicitation-question legend {
    display: grid;
    gap: 2px;
    margin-bottom: var(--space-8);
    padding: 0;
  }
  .elicitation-text {
    font-size: var(--type-14);
    font-weight: 600;
  }
  .elicitation-hint {
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  .elicitation-options {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
    gap: var(--space-8);
  }
  .elicitation-option {
    display: flex;
    gap: var(--space-8);
    align-items: flex-start;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--shell-control-border);
    border-radius: var(--radius-8);
    cursor: pointer;
  }
  .elicitation-option:hover {
    background: var(--shell-hover);
  }
  .elicitation-option:has(input:checked) {
    border-color: var(--sui-primary);
    background: var(--shell-selected);
    box-shadow: 0 0 0 1px var(--sui-primary);
  }
  .elicitation-option:has(input:focus-visible) {
    outline: 2px solid var(--sui-primary);
    outline-offset: 2px;
  }
  .elicitation-option input {
    flex: 0 0 auto;
    margin: 3px 0 0;
    accent-color: var(--sui-primary);
  }
  .elicitation-option input:focus-visible {
    outline: 0;
  }
  .elicitation-option-body {
    display: grid;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .elicitation-option-title {
    font-weight: 600;
  }
  .elicitation-option-description {
    color: var(--sui-muted);
    font-size: var(--type-13);
    line-height: 1.4;
  }
  .elicitation-clear {
    display: flex;
    justify-content: flex-start;
  }
  .elicitation-preview {
    display: grid;
    gap: 4px;
    margin: 0;
  }
  .elicitation-preview figcaption {
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  .elicitation-preview textarea {
    box-sizing: border-box;
    width: 100%;
    max-height: 16rem;
    resize: vertical;
    color: inherit;
    font-family: ui-monospace, monospace;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-6);
    background: var(--sui-subtle);
    font-size: var(--type-12);
    white-space: pre;
  }
  .elicitation-other,
  .elicitation-field {
    display: grid;
    gap: 4px;
    max-width: 36rem;
  }
  .elicitation-other label {
    color: var(--sui-muted);
    font-size: var(--type-13);
  }
  .elicitation-other label span,
  .elicitation-other small,
  .elicitation-field small {
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  .elicitation-field label {
    font-weight: 600;
  }
  .elicitation-other input,
  .elicitation-field input:not([type='checkbox']),
  .elicitation-field select {
    box-sizing: border-box;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--shell-control-border);
    border-radius: var(--radius-6);
    background: var(--sui-canvas);
    color: inherit;
    font: inherit;
  }
  .elicitation-error {
    color: var(--sui-danger-ink);
  }
  .elicitation-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
  }
</style>
