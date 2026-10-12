import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function e2eIdentity() {
  const runId = randomUUID().replaceAll('-', '');
  return {
    identifier: `dev.smykla.sail.e2e.${runId}`,
    productName: `Sail E2E ${runId.slice(0, 8)}`,
  };
}

const escapeXml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function e2eContextService(identity, template, configDir, temporaryDir) {
  if (!configDir || !isAbsolute(configDir)) {
    throw new Error('Set an absolute private SAIL_E2E_CONFIG_DIR before building the E2E app');
  }
  if (!temporaryDir || !isAbsolute(temporaryDir)) {
    throw new Error('Set an absolute private TMPDIR before building the E2E app');
  }
  const releaseLabel = 'dev.smykla.sai-harness.context-supervisor';
  const occurrences = template.split(releaseLabel).length - 1;
  if (occurrences !== 2) throw new Error('Unexpected context service plist template');

  const label = `${identity.identifier}.context-supervisor`;
  const closing = '</dict></plist>';
  const end = template.lastIndexOf(closing);
  if (end < 0) throw new Error('Unexpected context service plist structure');
  const environment = `  <key>EnvironmentVariables</key><dict>\n    <key>SAIL_E2E_CONFIG_DIR</key><string>${escapeXml(configDir)}</string>\n    <key>TMPDIR</key><string>${escapeXml(temporaryDir)}</string>\n  </dict>\n`;
  return {
    label,
    destination: `Library/LaunchAgents/${label}.plist`,
    plist: (template.slice(0, end) + environment + template.slice(end)).replaceAll(
      releaseLabel,
      label,
    ),
  };
}
