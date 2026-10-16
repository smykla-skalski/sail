export function protectedScript(script: string | ((...args: never[]) => unknown)): string {
  const body =
    typeof script === 'function' ? `return (${script.toString()}).apply(this, arguments);` : script;
  // WebDriverIO interprets a top-level error property as a protocol failure, even on HTTP 200.
  return `return [await (async function () { ${body}\n }).apply(this, arguments)];`;
}
