import { randomUUID } from 'node:crypto';

export function e2eIdentity() {
  const runId = randomUUID().replaceAll('-', '');
  return {
    identifier: `dev.smykla.sail.e2e.${runId}`,
    productName: `Sail E2E ${runId.slice(0, 8)}`,
  };
}

export function e2eContextService(identity, template) {
  const releaseLabel = 'dev.smykla.sai-harness.context-supervisor';
  const occurrences = template.split(releaseLabel).length - 1;
  if (occurrences !== 2) throw new Error('Unexpected context service plist template');

  const label = `${identity.identifier}.context-supervisor`;
  return {
    label,
    destination: `Library/LaunchAgents/${label}.plist`,
    plist: template.replaceAll(releaseLabel, label),
  };
}
