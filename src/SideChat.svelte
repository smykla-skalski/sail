<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AgentWorkspace from './AgentWorkspace.svelte';
  import TaskLocation from './TaskLocation.svelte';
  import Markdown from './Markdown.svelte';
  import type { OpenCodeClient, SessionMessageInfo } from './lib/opencode';
  import type { AgentId } from './lib/acp';
  import {
    composerTaskLocation,
    type TaskLocation as TaskLocationValue,
  } from './lib/task-location';
  import {
    clipboardFiles,
    fileUri,
    insertClipboardText,
    removeClipboardFile,
    stageClipboardFile,
  } from './lib/attachments';

  type Source =
    { kind: 'opencode'; sessionID: string } | { kind: 'acp'; agent: AgentId; context: string };

  let {
    source,
    client,
    directory,
    taskLocation,
    focused,
    focusPrompt,
    onpromptfocused,
  }: {
    source: Source;
    client: OpenCodeClient | null;
    directory: string;
    taskLocation: TaskLocationValue;
    focused: boolean;
    focusPrompt: boolean;
    onpromptfocused: () => void;
  } = $props();
  const promptLocation = $derived(composerTaskLocation(taskLocation, directory));

  let forkID = $state<string | null>(null);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state('');
  let draft = $state('');
  let attachments = $state<{ path: string; name: string }[]>([]);
  let pendingPaste: Promise<void> = Promise.resolve();
  let replies = $state<{ id: string; role: string; text: string }[]>([]);
  let baseline = new Set<string>();
  let inboxID: string | null = null;
  let prompt = $state<HTMLTextAreaElement>();
  let disposed = false;

  async function pasteFiles(event: ClipboardEvent) {
    const files = clipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    if (pastedText && event.target instanceof HTMLTextAreaElement) {
      const input = event.target;
      const caret = input.selectionStart + pastedText.length;
      draft = insertClipboardText(draft, pastedText, input.selectionStart, input.selectionEnd);
      void tick().then(() => input.setSelectionRange(caret, caret));
    }
    const staged = await Promise.all(
      files.map(async (file) => {
        try {
          return {
            path: await stageClipboardFile(file),
            name: file.name || 'clipboard-image.png',
            failure: null,
          };
        } catch (cause) {
          return { path: null, name: file.name, failure: String(cause) };
        }
      }),
    );
    const ready: { path: string; name: string }[] = [];
    for (const item of staged) {
      if (item.failure) error = `Could not paste ${item.name}: ${item.failure}`;
      else if (item.path) {
        if (disposed) void removeClipboardFile(item.path);
        else ready.push({ path: item.path, name: item.name });
      }
    }
    attachments = [...attachments, ...ready];
  }

  function removeAttachment(path: string) {
    attachments = attachments.filter((item) => item.path !== path);
    void removeClipboardFile(path);
  }

  function messageText(message: SessionMessageInfo): string {
    return message.type === 'user'
      ? message.text
      : message.type === 'assistant'
        ? message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        : '';
  }

  async function refresh() {
    if (!client || !forkID) return;
    const page = await client.message.list({ sessionID: forkID, limit: 100, order: 'desc' });
    if (disposed) return;
    replies = page.data
      .filter((message) => !baseline.has(message.id))
      .toReversed()
      .map((message) => ({ id: message.id, role: message.type, text: messageText(message) }))
      .filter((message) => message.text);
  }

  onMount(() => {
    disposed = false;
    const forkClient = client;
    if (source.kind === 'opencode' && forkClient) {
      loading = true;
      void (async () => {
        let createdID: string | null = null;
        try {
          const fork = await forkClient.session.fork({ sessionID: source.sessionID });
          createdID = fork.id;
          if (disposed) {
            await forkClient.session.remove({ sessionID: fork.id });
            return;
          }
          const page = await forkClient.message.list({
            sessionID: fork.id,
            limit: 100,
            order: 'desc',
          });
          if (disposed) {
            await forkClient.session.remove({ sessionID: fork.id });
            return;
          }
          baseline = new Set(page.data.map((message) => message.id));
          forkID = fork.id;
        } catch (cause) {
          if (createdID) await forkClient.session.remove({ sessionID: createdID }).catch(() => {});
          if (!disposed) error = String(cause);
        } finally {
          if (!disposed) loading = false;
        }
      })();
    }
    return () => {
      disposed = true;
      attachments.forEach((item) => void removeClipboardFile(item.path));
      if (forkID && forkClient) {
        const sessionID = forkID;
        const pending = inboxID;
        void (async () => {
          if (pending)
            await forkClient.session.inbox.cancel({ sessionID, inboxID: pending }).catch(() => {});
          await forkClient.session.remove({ sessionID }).catch(() => {});
        })();
      }
    };
  });

  $effect(() => {
    if (focusPrompt && focused && !loading && !busy && source.kind === 'opencode') {
      void tick().then(() => {
        prompt?.focus();
        onpromptfocused();
        return undefined;
      });
    }
  });

  async function send() {
    await pendingPaste;
    const text = draft.trim();
    if ((!text && !attachments.length) || !client || !forkID || busy) return;
    const files = [...attachments];
    busy = true;
    error = '';
    draft = '';
    attachments = [];
    let accepted = false;
    try {
      const inbox = await client.session.prompt({
        sessionID: forkID,
        text,
        files: files.map((item) => ({ uri: fileUri(item.path), name: item.name })),
      });
      accepted = true;
      if (disposed) {
        await client.session.inbox.cancel({ sessionID: forkID, inboxID: inbox.id }).catch(() => {});
        return;
      }
      inboxID = inbox.id;
      await client.session.wait({ sessionID: forkID });
      inboxID = null;
      await refresh();
    } catch (cause) {
      if (!disposed) {
        error = String(cause);
        if (!accepted) {
          draft = text;
          attachments = [...files, ...attachments];
        }
      }
    } finally {
      if (accepted || disposed) files.forEach((item) => void removeClipboardFile(item.path));
      if (!disposed) busy = false;
    }
  }
</script>

{#if source.kind === 'acp'}
  <AgentWorkspace
    agent={source.agent}
    agentName={source.agent}
    {directory}
    {taskLocation}
    thread={null}
    running={false}
    {focused}
    {focusPrompt}
    {onpromptfocused}
    ephemeral
    seedContext={source.context}
    oncreated={() => {}}
    onactivity={() => {}}
    onstatus={() => {}}
    onterminal={() => {}}
  />
{:else}
  <div class="side-chat">
    <p class="side-chat-hint">Questions here stay out of the main thread.</p>
    <div class="side-chat-messages" aria-live="polite">
      {#each replies as reply (reply.id)}
        <div class="side-chat-message">
          <strong>{reply.role === 'user' ? 'You' : 'Agent'}</strong><Markdown source={reply.text} />
        </div>
      {/each}
      {#if loading}<p>Preparing side chat…</p>{/if}
      {#if busy}<p>Thinking…</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
    <div class="side-chat-composer">
      <TaskLocation location={promptLocation} />
      {#if attachments.length}<div class="attachments">
          {#each attachments as attachment (attachment.path)}<span
              >{attachment.name}<button
                aria-label={`Remove ${attachment.name}`}
                onclick={() => removeAttachment(attachment.path)}>×</button
              ></span
            >{/each}
        </div>{/if}
      <textarea
        bind:this={prompt}
        bind:value={draft}
        onpaste={(event) => {
          pendingPaste = Promise.all([pendingPaste, pasteFiles(event)]).then(() => {});
        }}
        data-pane-prompt
        aria-label="Side chat question"
        placeholder="Ask about this thread…"
        disabled={loading || busy || !forkID}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}></textarea>
      <button
        disabled={loading || busy || (!draft.trim() && !attachments.length) || !forkID}
        onclick={() => void send()}>Send</button
      >
    </div>
  </div>
{/if}

<style>
  .side-chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 0.75rem;
    gap: 0.5rem;
  }
  .side-chat-hint {
    margin: 0;
    color: var(--sui-muted);
    font-size: 0.8rem;
  }
  .side-chat-messages {
    flex: 1;
    overflow: auto;
  }
  .side-chat-message {
    margin-bottom: 1rem;
  }
  .side-chat-message strong {
    display: block;
    margin-bottom: 0.25rem;
  }
  .side-chat-composer {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .side-chat-composer :global(.task-location) {
    flex: 1 0 100%;
  }
  textarea {
    flex: 1;
    min-height: 3rem;
    resize: vertical;
  }
</style>
