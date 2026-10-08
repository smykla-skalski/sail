<script lang="ts">
  import { Button } from '@smykla-skalski/sui';

  export type Elicitation = {
    id: string | number;
    sessionId: string;
    message: string;
    schema: Record<string, unknown>;
  };

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
  const properties = $derived(
    elicitation.schema.properties &&
      typeof elicitation.schema.properties === 'object' &&
      !Array.isArray(elicitation.schema.properties)
      ? (elicitation.schema.properties as Record<string, Record<string, unknown>>)
      : {},
  );
  function defaults(schema: Record<string, unknown>): Record<string, unknown> {
    const fields =
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    return Object.fromEntries(
      Object.entries(fields).flatMap(([key, property]) =>
        property.default === undefined ? [] : [[key, property.default]],
      ),
    );
  }
  let values = $derived(defaults(elicitation.schema));
  let error = $state('');

  async function answer(action: 'accept' | 'decline' | 'cancel') {
    const required = Array.isArray(elicitation.schema.required)
      ? elicitation.schema.required.filter((key): key is string => typeof key === 'string')
      : [];
    if (
      action === 'accept' &&
      required.some((key) => values[key] === undefined || values[key] === '')
    ) {
      error = 'Complete all required fields.';
      return;
    }
    error = '';
    await onanswer(elicitation, action, action === 'accept' ? values : undefined);
  }
</script>

<div
  class="agent-permission"
  role="group"
  aria-label="Agent question"
  data-request-id={elicitation.id}
  data-session-id={elicitation.sessionId}
  data-agent-id={agent}
  tabindex="-1"
>
  <strong>{elicitation.schema.title ?? 'Agent question'}</strong>
  {#if elicitation.message}<small>{elicitation.message}</small>{/if}
  {#if error}<small role="alert">{error}</small>{/if}
  {#each Object.entries(properties) as [key, property] (key)}
    <label
      >{property.title ?? key}
      {#if property.description}<small>{property.description}</small>{/if}
      {#if property.type === 'boolean'}
        <input
          type="checkbox"
          checked={values[key] === true}
          onchange={(event) => (values = { ...values, [key]: event.currentTarget.checked })}
        />
      {:else if Array.isArray(property.enum)}
        <select
          value={String(values[key] ?? '')}
          onchange={(event) => (values = { ...values, [key]: event.currentTarget.value })}
        >
          <option value="">Choose…</option>{#each property.enum as option (String(option))}<option
              value={String(option)}>{String(option)}</option
            >{/each}
        </select>
      {:else}
        <input
          type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'}
          value={String(values[key] ?? '')}
          oninput={(event) =>
            (values = {
              ...values,
              [key]:
                property.type === 'number' || property.type === 'integer'
                  ? Number(event.currentTarget.value)
                  : event.currentTarget.value,
            })}
        />
      {/if}
    </label>
  {/each}
  <div>
    <Button size="sm" variant="primary" onclick={() => void answer('accept')}>Submit</Button><Button
      size="sm"
      variant="secondary"
      onclick={() => void answer('decline')}>Decline</Button
    ><Button size="sm" variant="secondary" onclick={() => void answer('cancel')}>Cancel</Button>
  </div>
</div>
