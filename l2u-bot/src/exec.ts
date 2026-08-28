import { execFile } from 'node:child_process';

export interface ExecOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ExecError extends Error {}

/**
 * Run an external command with an argument array only.
 * No shell is involved, so shell metacharacters in model-supplied arguments
 * cannot turn into command injection.
 */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ExecOutcome> {
  const { cwd, timeoutMs = 30_000, maxBuffer = 8 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer, encoding: 'utf8', shell: false },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          const errno = (error as NodeJS.ErrnoException).code;
          if (errno === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(
              new ExecError(
                `${command} produced too much output and was aborted (over ${maxBuffer} bytes). Narrow the query and retry.`,
              ),
            );
            return;
          }
          if (errno === 'ENOENT') {
            reject(new ExecError(`${command} executable not found.`));
            return;
          }
          reject(new ExecError(`${command} failed: ${error.message}`));
          return;
        }
        const code = error && typeof error.code === 'number' ? error.code : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });
}
