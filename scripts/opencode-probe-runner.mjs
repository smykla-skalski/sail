import { spawn } from 'node:child_process';
import process from 'node:process';

export async function run(binary, cliArguments, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(binary, cliArguments, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, ...options.environment },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => (stderr += error.message));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stderr += error.message;
    });
    child.stdin.end(options.input ?? '');
    child.on('close', (status, signal) =>
      resolveRun({
        status,
        timedOut: signal === 'SIGTERM' || signal === 'SIGKILL',
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }),
    );
  });
}
