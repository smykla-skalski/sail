import { browser } from '@wdio/globals';

interface ElementBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export async function takeElementScreenshot(selector: string): Promise<Buffer> {
  const bounds = await browser.execute((target): ElementBounds => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`Element not found: ${target}`);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  }, selector);
  const screenshot = await browser.takeScreenshot();
  const cropped = await browser.execute(
    async (base64, rect): Promise<string> => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scaleX = image.naturalWidth / rect.viewportWidth;
      const scaleY = image.naturalHeight / rect.viewportHeight;
      const left = Math.max(0, Math.floor(rect.left * scaleX));
      const top = Math.max(0, Math.floor(rect.top * scaleY));
      const right = Math.min(image.naturalWidth, Math.ceil(rect.right * scaleX));
      const bottom = Math.min(image.naturalHeight, Math.ceil(rect.bottom * scaleY));
      if (right <= left || bottom <= top) throw new Error('Element is outside the screenshot');
      const canvas = document.createElement('canvas');
      canvas.width = right - left;
      canvas.height = bottom - top;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Screenshot canvas is unavailable');
      context.drawImage(
        image,
        left,
        top,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return canvas.toDataURL('image/png').split(',')[1];
    },
    screenshot,
    bounds,
  );
  return Buffer.from(cropped, 'base64');
}
