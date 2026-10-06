export type PickedBrowserElement = {
  label: string;
  url: string;
  html: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};

export type BrowserAttachment = {
  id: string;
  text: string;
  imagePath: string;
  previewUrl?: string;
  url?: string;
  created?: number;
};

export function describePickedElement(element: PickedBrowserElement): string {
  return [
    `Selected element at ${element.url}`,
    'HTML:',
    '```html',
    element.html,
    '```',
    'Computed styles:',
    '```json',
    JSON.stringify(element.styles, null, 2),
    '```',
  ].join('\n');
}
