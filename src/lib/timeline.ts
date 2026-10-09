export function nearBottom(
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
