<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '@smykla-skalski/sui';

  export type Confirmation = {
    id: string;
    title: string;
    message: string;
    confirmLabel: string;
    destructive?: boolean;
  };

  let {
    request,
    onanswer,
  }: {
    request: Confirmation | null;
    onanswer: (confirmed: boolean) => void;
  } = $props();
  let dialog: HTMLDialogElement;

  $effect(() => {
    if (request) {
      void tick().then(() => {
        if (!dialog.open) dialog.showModal();
        return undefined;
      });
    } else if (dialog?.open) dialog.close();
  });
</script>

<dialog
  class="commands-dialog confirmation-dialog"
  bind:this={dialog}
  aria-labelledby="confirmation-title"
  oncancel={(event) => {
    event.preventDefault();
    onanswer(false);
  }}
>
  {#if request}
    <h2 id="confirmation-title">{request.title}</h2>
    <p>{request.message}</p>
    <div class="confirmation-actions">
      <Button variant="secondary" onclick={() => onanswer(false)}>Cancel</Button>
      <Button
        class="confirmation-primary"
        variant={request.destructive ? 'danger' : 'primary'}
        onclick={() => onanswer(true)}>{request.confirmLabel}</Button
      >
    </div>
  {/if}
</dialog>
