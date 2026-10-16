import { createConnection } from 'node:net';
import process from 'node:process';

if (
  process.argv[3] === 'requires-credential' &&
  process.env.SAIL_PROVIDER_TOKEN !== 'fixture-token'
)
  throw new Error('Credential required.');
const socket = createConnection({ host: '127.0.0.1', port: Number(process.argv[2]) });
socket.on('error', () => process.exit(1));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
