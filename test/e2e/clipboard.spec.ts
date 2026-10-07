import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('clipboard chat attachments', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-clipboard-e2e-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('copies selections and sends pasted text, files, and images to ACP', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    const copied = await browser.execute(() => {
      const header = document.querySelector('.agent-header');
      if (!header || !navigator.clipboard) throw new Error('No selectable header or clipboard');
      const writes: string[] = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => {
          writes.push(text);
        },
      });
      try {
        const range = document.createRange();
        range.selectNodeContents(header);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        selection?.removeAllRanges();
        return writes;
      } finally {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: original,
        });
      }
    });
    expect(copied.join(' ')).toContain('Ready');

    await $('.agent-composer textarea').setValue('Clipboard fixture');
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea');
      if (!input) throw new Error('No composer');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const data = new DataTransfer();
      data.setData('text/plain', ' mixed');
      data.items.add(new File(['file body'], 'notes.txt', { type: 'text/plain' }));
      input.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('file contents: file body'),
    );
    const conversation = await $('.agent-conversation').getText();
    expect(conversation).toContain('Clipboard fixture mixed');
    const staged = conversation.match(/Attached files \(read these paths\):\s*(\/[^\s;]+)/)?.[1];
    if (!staged) throw new Error('Agent did not receive a staged file path');
    await browser.waitUntil(() => !existsSync(staged), {
      timeoutMsg: 'Sent file was not removed',
    });

    await $('.agent-composer textarea').setValue('Clipboard fixture image');
    await browser.execute(async () => {
      const input = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea');
      if (!input) throw new Error('No composer');
      input.setSelectionRange(9, 9);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      canvas.getContext('2d')?.fillRect(0, 0, 2, 2);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('No PNG'))),
          'image/png',
        ),
      );
      const data = new DataTransfer();
      data.items.add(new File([blob], 'pixel.png', { type: 'image/png' }));
      input.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    await expect($('.clipboard-image-preview')).toBeDisplayed();
    await expect($('.clipboard-image-preview')).toHaveAttribute('data-caret-offset', '9');
    await expect($('button[aria-label="Remove pixel.png"]')).toBeDisplayed();
    await $('.agent-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('image: image/png'));

    await $('.agent-composer textarea').setValue('');
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea');
      if (!input) throw new Error('No composer');
      const data = new DataTransfer();
      data.items.add(new File(['remove me'], 'remove.txt', { type: 'text/plain' }));
      input.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    await $('button[aria-label="Remove remove.txt"]').click();
    await expect($('.agent-actions button')).not.toBeEnabled();
  });
});
