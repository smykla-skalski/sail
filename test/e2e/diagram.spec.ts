import { browser, $, expect } from '@wdio/globals';

describe('plan diagram', () => {
  it('keeps long labels visible in preview and fullscreen', async () => {
    await browser.execute(() => history.replaceState(null, '', '?diagram-fixture'));
    await browser.refresh();

    const preview = $('.diagram-preview img');
    await expect(preview).toBeDisplayed();

    const labels = await browser.execute(() => {
      const image = document.querySelector<HTMLImageElement>('.diagram-preview img')!;
      const svg = decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1));
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-10000px;top:0';
      host.innerHTML = svg;
      document.body.append(host);

      const result = [...host.querySelectorAll<SVGTextElement>('g.node text')].map((label) => {
        const labelBounds = label.getBoundingClientRect();
        const containerBounds = label.closest('svg')!.getBoundingClientRect();
        return {
          text: label.textContent?.replaceAll(/\s/g, ''),
          visible:
            labelBounds.left >= containerBounds.left &&
            labelBounds.right <= containerBounds.right &&
            labelBounds.top >= containerBounds.top &&
            labelBounds.bottom <= containerBounds.bottom,
        };
      });
      host.remove();
      return result;
    });
    expect(labels).toEqual([
      { text: 'Releaseinputs', visible: true },
      { text: 'versions.yml+active-branches.json', visible: true },
      { text: 'team-mesh-toolsrelease-manifestworkflow', visible: true },
      {
        text: 'backport/_get-active-branchesworkflows:seegeneratedoutput',
        visible: true,
      },
    ]);

    const previewSize = await preview.getSize();
    expect(previewSize.width).toBeLessThanOrEqual(448);
    expect(previewSize.height).toBeGreaterThan(100);

    await $('.diagram-preview').click();
    const dialog = $('.diagram-fullscreen');
    await expect(dialog).toBeDisplayed();
    await expect($('.fullscreen-canvas img')).toBeDisplayed();
  });
});
