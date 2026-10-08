<script lang="ts">
  import {
    isFormAlreadySettledError,
    isFormNotFoundError,
    isPermissionNotFoundError,
    type FormField,
    type FormInfo,
    type PermissionRequest,
  } from '@opencode/client';
  import type { OpenCodeClient } from './lib/opencode';
  import { openExternalLink } from './lib/external-link';
  import PermissionCard from './PermissionCard.svelte';
  import {
    mayAlwaysAllow,
    openCodePermissionChoices,
    openCodePermissionDetails,
  } from './lib/permission-card';
  import OptionPicker from './OptionPicker.svelte';
  import {
    openCodePermissionToolCall,
    permissionPolicy,
    type CapabilityProfile,
    type PermissionPolicyDecision,
  } from './lib/capability-profiles';
  import { openCodePermissionRejections } from './lib/opencode-permission-resolution';

  interface Props {
    pendingPermissions: PermissionRequest[];
    pendingForms: FormInfo[];
    client: OpenCodeClient | null;
    sessionID: string | null;
    workspace: string;
    onchanged: () => Promise<void>;
    capabilityProfile?: CapabilityProfile;
    ondecision?: (
      request: PermissionRequest,
      decision: 'once' | 'always' | 'reject',
      policy: PermissionPolicyDecision,
    ) => void;
  }

  let {
    pendingPermissions,
    pendingForms,
    client,
    sessionID,
    workspace,
    onchanged,
    capabilityProfile = 'build',
    ondecision,
  }: Props = $props();
  type Value = string | number | boolean | string[];
  let drafts = $state<Record<string, Record<string, Value>>>({});
  let customInputs = $state<Record<string, string>>({});
  let feedback = $state<Record<string, string>>({});
  let busyID = $state<string | null>(null);
  let pickerOpen = $state<string | null>(null);
  let suggestionOpen = $state<string | null>(null);
  let error = $state('');
  let status = $state('');

  function requestPolicy(request: PermissionRequest): PermissionPolicyDecision {
    return permissionPolicy({
      profile: capabilityProfile,
      workspace,
      title: request.action,
      toolCall: openCodePermissionToolCall(request),
      options: [
        { optionId: 'once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    });
  }

  function suggestionKeydown(event: KeyboardEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    const combo = button.closest('.prompt-custom-combo');
    const input = combo?.querySelector<HTMLInputElement>('input');
    const buttons = [
      ...(combo?.querySelectorAll<HTMLButtonElement>('.prompt-suggestions button') ?? []),
    ];
    const index = buttons.indexOf(button);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      input?.focus();
      suggestionOpen = null;
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) input?.focus();
      else buttons[index - 1]?.focus();
    }
  }

  $effect(() => {
    void sessionID;
    busyID = null;
    status = '';
    error = '';
  });

  $effect(() => {
    for (const form of pendingForms) {
      if (drafts[form.id]) continue;
      drafts[form.id] = Object.fromEntries(
        form.fields.flatMap((field) =>
          field.type === 'external'
            ? []
            : [[field.key, field.default ?? (field.type === 'multiselect' ? [] : '')]],
        ),
      );
    }
  });

  function value(form: FormInfo, key: string): Value {
    return drafts[form.id]?.[key] ?? '';
  }

  function setValue(form: FormInfo, key: string, next: Value) {
    drafts[form.id] = { ...drafts[form.id], [key]: next };
  }

  function addCustom(form: FormInfo, key: string) {
    const id = `${form.id}:${key}`;
    const entry = customInputs[id]?.trim();
    const selected = value(form, key);
    if (!entry || !Array.isArray(selected) || selected.includes(entry)) return;
    setValue(form, key, [...selected, entry]);
    customInputs[id] = '';
  }

  function visible(form: FormInfo, field: FormField): boolean {
    if ('hidden' in field && field.hidden) return false;
    return (
      !('when' in field) ||
      !field.when?.length ||
      field.when.every((condition) => {
        const current = value(form, condition.key);
        const matches = Array.isArray(current)
          ? current.includes(String(condition.value))
          : typeof condition.value === 'number' && typeof current === 'string' && current !== ''
            ? Number(current) === condition.value
            : current === condition.value;
        return condition.op === 'eq' ? matches : !matches;
      })
    );
  }

  function externalUrl(raw: string): string | null {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function answer(form: FormInfo): Record<string, Value> {
    const result: Record<string, Value> = {};
    for (const field of form.fields) {
      if ('hidden' in field && field.hidden) {
        if (field.default !== undefined) result[field.key] = field.default;
        continue;
      }
      if (field.type === 'external' || !visible(form, field)) continue;
      const current = value(form, field.key);
      if (field.type === 'number' || field.type === 'integer') {
        if (current === '') {
          if (field.required) throw new Error(`${field.title ?? field.key} is required.`);
          continue;
        }
        if (current === 'Infinity' || current === '-Infinity' || current === 'NaN') {
          result[field.key] = current;
          continue;
        }
        const parsed = Number(current);
        if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed)))
          throw new Error(`Enter a valid number for ${field.title ?? field.key}.`);
        if (typeof field.minimum === 'number' && parsed < field.minimum)
          throw new Error(`${field.title ?? field.key} must be at least ${field.minimum}.`);
        if (typeof field.maximum === 'number' && parsed > field.maximum)
          throw new Error(`${field.title ?? field.key} must be at most ${field.maximum}.`);
        result[field.key] = parsed;
      } else if (field.type === 'multiselect') {
        const entry = field.custom ? customInputs[`${form.id}:${field.key}`]?.trim() : undefined;
        const selected = Array.isArray(current) ? [...current] : [];
        if (entry && !selected.includes(entry)) selected.push(entry);
        if (selected.length < (field.minItems ?? (field.required ? 1 : 0)))
          throw new Error(`Choose more options for ${field.title ?? field.key}.`);
        if (field.maxItems !== undefined && selected.length > field.maxItems)
          throw new Error(`Choose fewer options for ${field.title ?? field.key}.`);
        result[field.key] = selected;
      } else if (field.type === 'boolean') {
        result[field.key] = current === true;
      } else {
        const text = String(current);
        if (field.required && !text.trim())
          throw new Error(`${field.title ?? field.key} is required.`);
        if (!text && !field.required) continue;
        if (field.minLength !== undefined && text.length < field.minLength)
          throw new Error(`${field.title ?? field.key} is too short.`);
        if (field.maxLength !== undefined && text.length > field.maxLength)
          throw new Error(`${field.title ?? field.key} is too long.`);
        if (field.pattern && text && !new RegExp(field.pattern).test(text))
          throw new Error(`${field.title ?? field.key} has an invalid format.`);
        result[field.key] = text;
      }
    }
    return result;
  }

  async function decide(request: PermissionRequest, decision: 'once' | 'always' | 'reject') {
    if (!client || !sessionID || request.sessionID !== sessionID) return;
    const source = client;
    const selected = sessionID;
    busyID = request.id;
    error = '';
    status = 'Sending permission decision…';
    try {
      await source.permission.get({ sessionID: selected, requestID: request.id });
      if (sessionID !== selected) return;
      if (decision === 'reject') {
        await openCodePermissionRejections.reject({
          selected: request,
          list: () => source.permission.list({ sessionID: selected }),
          reply: () =>
            source.permission.reply({
              sessionID: selected,
              requestID: request.id,
              decision,
              ...(feedback[request.id]?.trim() ? { message: feedback[request.id].trim() } : {}),
            }),
          record: (settledRequest) =>
            ondecision?.(settledRequest, decision, requestPolicy(settledRequest)),
        });
      } else {
        await openCodePermissionRejections.resolveAutomatically({
          selected: request,
          decision,
          reply: () =>
            source.permission.reply({ sessionID: selected, requestID: request.id, decision }),
          record: (settledRequest, settledDecision) =>
            ondecision?.(settledRequest, settledDecision, requestPolicy(settledRequest)),
        });
      }
      if (sessionID === selected)
        status = decision === 'reject' ? 'Permission rejected.' : 'Permission allowed.';
    } catch (cause) {
      if (sessionID === selected) {
        status = '';
        if (!isPermissionNotFoundError(cause)) error = describe(cause);
      }
    } finally {
      if (sessionID === selected) {
        busyID = null;
        await onchanged();
      }
    }
  }

  async function settle(form: FormInfo, action: 'reply' | 'cancel') {
    if (!client || !sessionID || form.sessionID !== sessionID) return;
    const source = client;
    const selected = sessionID;
    busyID = form.id;
    error = '';
    status = action === 'reply' ? 'Submitting form…' : 'Cancelling form…';
    try {
      const submitted = action === 'reply' ? answer(form) : null;
      const current = await source.session.form.get({ sessionID: selected, formID: form.id });
      if (sessionID !== selected || current.state.status !== 'pending') return;
      if (submitted)
        await source.session.form.reply({
          sessionID: selected,
          formID: form.id,
          answer: submitted,
        });
      else await source.session.form.cancel({ sessionID: selected, formID: form.id });
      if (sessionID === selected)
        status = action === 'reply' ? 'Form submitted.' : 'Form cancelled.';
    } catch (cause) {
      if (sessionID === selected) {
        status = '';
        if (!isFormNotFoundError(cause) && !isFormAlreadySettledError(cause))
          error = describe(cause);
      }
    } finally {
      if (sessionID === selected) {
        busyID = null;
        await onchanged();
      }
    }
  }

  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }
</script>

{#if pendingPermissions.length || pendingForms.length || status || error}
  <section class="prompt-panel" aria-label="Pending agent requests">
    {#if pendingPermissions.length || pendingForms.length}<h2>Agent requests</h2>{/if}
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    {#if status}<p class="notice" role="status">{status}</p>{/if}
    {#each pendingPermissions as request (request.id)}
      {@const policy = requestPolicy(request)}
      {@const details = openCodePermissionDetails(request)}
      <PermissionCard
        title={`Allow ${request.action}?`}
        {policy}
        command={details.command}
        files={details.files}
        message={request.message}
        toolCallId={details.toolCallId}
        requestId={request.id}
        sessionId={request.sessionID}
        agentId="opencode"
        label="OpenCode permission request"
        extraClass="prompt-card"
        choices={openCodePermissionChoices(policy)}
        busy={!!busyID}
        onchoose={(choice) => decide(request, choice.id as 'once' | 'always' | 'reject')}
      >
        {#if mayAlwaysAllow(policy)}<p class="prompt-warning">
            Allow always saves these approvals for this project:
            {#if request.save?.length}{#each request.save as pattern, index (`${pattern}:${index}`)}<code
                  >{request.action}: {pattern}</code
                >{/each}
            {:else}<span>No saved pattern proposed.</span>{/if}
          </p>{/if}
        <p class="prompt-warning">Reject also rejects other pending permissions in this session.</p>
        <label
          >Optional rejection feedback
          <textarea
            value={feedback[request.id] ?? ''}
            oninput={(event) => (feedback[request.id] = event.currentTarget.value)}></textarea>
        </label>
      </PermissionCard>
    {/each}
    {#each pendingForms as form (form.id)}
      <article
        class="prompt-card"
        data-request-id={form.id}
        data-session-id={form.sessionID}
        tabindex="-1"
      >
        <h3>{form.title}</h3>
        {#each form.fields as field (field.key)}
          {#if visible(form, field)}
            <div class="prompt-field" role="group" aria-label={field.title ?? field.key}>
              <strong>{field.title ?? field.key}</strong>{#if 'required' in field && field.required}
                *{/if}
              {#if 'description' in field && field.description}<small>{field.description}</small
                >{/if}
              {#if field.type === 'external'}
                {#if externalUrl(field.url)}<a
                    href={externalUrl(field.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(event) => openExternalLink(event, externalUrl(field.url) ?? '')}
                    >Open link</a
                  >{:else}<span>Unsupported link</span>{/if}
              {:else if field.type === 'boolean'}<input
                  type="checkbox"
                  aria-label={field.title ?? field.key}
                  checked={value(form, field.key) === true}
                  onchange={(event) => setValue(form, field.key, event.currentTarget.checked)}
                />
              {:else if field.type === 'multiselect'}
                {#each field.options as option (option.value)}<label class="prompt-option"
                    ><input
                      type="checkbox"
                      aria-label={option.label}
                      checked={Array.isArray(value(form, field.key)) &&
                        (value(form, field.key) as string[]).includes(option.value)}
                      onchange={(event) => {
                        const selected = value(form, field.key) as string[];
                        setValue(
                          form,
                          field.key,
                          event.currentTarget.checked
                            ? [...selected, option.value]
                            : selected.filter((item) => item !== option.value),
                        );
                      }}
                    />{option.label}</label
                  >{/each}
                {#if field.custom}
                  {#each (value(form, field.key) as string[]).filter((item) => !field.options.some((option) => option.value === item)) as item (item)}
                    <button
                      type="button"
                      class="prompt-custom-option"
                      aria-label={`Remove ${item}`}
                      onclick={() =>
                        setValue(
                          form,
                          field.key,
                          (value(form, field.key) as string[]).filter(
                            (selected) => selected !== item,
                          ),
                        )}>{item} ×</button
                    >
                  {/each}
                  <div class="prompt-custom-entry">
                    <input
                      aria-label={`Custom ${field.title ?? field.key}`}
                      value={customInputs[`${form.id}:${field.key}`] ?? ''}
                      oninput={(event) =>
                        (customInputs[`${form.id}:${field.key}`] = event.currentTarget.value)}
                    />
                    <button type="button" onclick={() => addCustom(form, field.key)}>Add</button>
                  </div>
                {/if}
              {:else if field.type === 'string' && field.options?.length && !field.custom}
                <OptionPicker
                  label={field.title ?? field.key}
                  value={String(value(form, field.key))}
                  options={[
                    { value: '', name: 'Choose…' },
                    ...field.options.map((option) => ({ value: option.value, name: option.label })),
                  ]}
                  open={pickerOpen === `${form.id}:${field.key}`}
                  onopen={() => (pickerOpen = `${form.id}:${field.key}`)}
                  onclose={() => (pickerOpen = null)}
                  onchoose={(next) => setValue(form, field.key, next)}
                />
              {:else}<div
                  class="prompt-custom-combo"
                  onfocusout={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      suggestionOpen = null;
                  }}
                >
                  <input
                    type={field.type === 'string'
                      ? field.format === 'uri'
                        ? 'url'
                        : field.format === 'date-time'
                          ? 'text'
                          : (field.format ?? 'text')
                      : 'text'}
                    aria-label={field.title ?? field.key}
                    inputmode={field.type === 'number' || field.type === 'integer'
                      ? 'decimal'
                      : undefined}
                    value={String(value(form, field.key))}
                    placeholder={field.type === 'string' ? (field.placeholder ?? '') : ''}
                    oninput={(event) => setValue(form, field.key, event.currentTarget.value)}
                    onfocus={() => (suggestionOpen = `${form.id}:${field.key}`)}
                    onkeydown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        suggestionOpen = null;
                      }
                      if (
                        event.key === 'ArrowDown' &&
                        field.type === 'string' &&
                        field.options?.length
                      ) {
                        event.preventDefault();
                        event.currentTarget.parentElement
                          ?.querySelector<HTMLButtonElement>('.prompt-suggestions button')
                          ?.focus();
                      }
                    }}
                  />
                  {#if suggestionOpen === `${form.id}:${field.key}` && field.type === 'string' && field.custom && field.options?.length}
                    <div
                      class="prompt-suggestions"
                      role="listbox"
                      aria-label={`${field.title ?? field.key} suggestions`}
                    >
                      {#each field.options
                        .filter((option) => `${option.label} ${option.value}`
                            .toLowerCase()
                            .includes(String(value(form, field.key)).toLowerCase()))
                        .slice(0, 8) as option (option.value)}
                        <button
                          type="button"
                          role="option"
                          aria-selected={value(form, field.key) === option.value}
                          onkeydown={suggestionKeydown}
                          onclick={() => {
                            setValue(form, field.key, option.value);
                            suggestionOpen = null;
                          }}>{option.label}</button
                        >
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
        <div class="prompt-actions">
          <button disabled={!!busyID} onclick={() => settle(form, 'reply')}>Submit</button>
          <button disabled={!!busyID} onclick={() => settle(form, 'cancel')}>Cancel</button>
        </div>
      </article>
    {/each}
  </section>
{/if}
