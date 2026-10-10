import { randomUUID } from 'node:crypto';

export function e2eIdentity() {
  const runId = randomUUID().replaceAll('-', '');
  return {
    identifier: `dev.smykla.sail.e2e.${runId}`,
    productName: `Sail E2E ${runId.slice(0, 8)}`,
  };
}
