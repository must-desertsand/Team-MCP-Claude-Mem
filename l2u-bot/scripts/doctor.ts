/**
 * Environment preflight.
 *
 * Run this on any machine before starting the bot. It reports what is present,
 * what is missing, and what to do about each gap — so moving between machines is
 * a measurement rather than a guess.
 *
 *   pnpm doctor
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../src/exec.js';
import { SingleInstanceLock } from '../src/lock.js';
import {
  meetsVersion,
  evaluateScopes,
  missingModels,
  summarize,
  formatResults,
} from '../src/preflight/evaluate.js';
import type { CheckResult } from '../src/preflight/types.js';

const results: CheckResult[] = [];
const add = (r: CheckResult): void => {
  results.push(r);
};

async function binaryVersion(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr, code } = await run(command, args, { timeoutMs: 10_000 });
    if (code !== 0) return undefined;
    return (stdout || stderr).trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- runtimes

async function checkRuntimes(): Promise<void> {
  const node = process.version;
  add({
    name: 'Node.js',
    status: meetsVersion(node, '22') ? 'ok' : 'fail',
    detail: `${node} (requires >= 22)`,
    fix: 'Install Node 22 or newer, e.g. `brew install node`',
  });

  for (const [name, command, args, required, fixHint] of [
    ['pnpm', 'pnpm', ['--version'], '9', 'npm i -g pnpm'],
    ['git', 'git', ['--version'], '2.30', 'brew install git'],
  ] as const) {
    const version = await binaryVersion(command, [...args]);
    add({
      name,
      status: version === undefined ? 'fail' : meetsVersion(version, required) ? 'ok' : 'warn',
      detail: version ?? 'not found',
      fix: fixHint,
    });
  }

  const rg = await binaryVersion('rg', ['--version']);
  add({
    name: 'ripgrep (optional)',
    status: rg ? 'ok' : 'warn',
    detail: rg ?? 'not found — falling back to `git grep`',
    fix: 'Optional. `brew install ripgrep` speeds up search; git grep works without it.',
  });
}

// ---------------------------------------------------------------- github

async function checkGithub(): Promise<void> {
  const version = await binaryVersion('gh', ['--version']);
  if (!version) {
    add({
      name: 'gh CLI',
      status: 'fail',
      detail: 'not found',
      fix: 'brew install gh',
    });
    return;
  }
  add({ name: 'gh CLI', status: 'ok', detail: version });

  const usingEnvToken = Boolean(process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN']);
  try {
    const { stderr, stdout, code } = await run('gh', ['auth', 'status'], { timeoutMs: 15_000 });
    const output = `${stdout}${stderr}`;
    const account = output.match(/account (\S+)/)?.[1];
    add({
      name: 'gh authentication',
      status: code === 0 ? 'ok' : 'fail',
      detail:
        code === 0
          ? `${account ?? 'authenticated'}${usingEnvToken ? ' (via GH_TOKEN)' : ' (via keyring)'}`
          : 'not authenticated',
      fix: usingEnvToken
        ? undefined
        : 'On a shared or daemon-run machine set GH_TOKEN instead of the keyring — launchd daemons cannot reach the login keychain.',
    });
  } catch {
    add({ name: 'gh authentication', status: 'fail', detail: 'check failed', fix: 'gh auth login' });
  }

  const repo = process.env['GITHUB_REPO'] ?? 'mustfintech/l2u-sandbox';
  try {
    const { code } = await run('gh', ['repo', 'view', repo, '--json', 'name'], { timeoutMs: 20_000 });
    add({
      name: 'GitHub repo access',
      status: code === 0 ? 'ok' : 'fail',
      detail: repo,
      fix: `The authenticated account cannot read ${repo}. Grant access or use a different token.`,
    });
  } catch {
    add({ name: 'GitHub repo access', status: 'fail', detail: repo, fix: 'Check network and token.' });
  }
}

// ---------------------------------------------------------------- clone

async function checkClone(): Promise<void> {
  const clonePath = process.env['REPO_CLONE_PATH'];
  if (!clonePath) {
    add({
      name: 'Code clone',
      status: 'fail',
      detail: 'REPO_CLONE_PATH is not set',
      fix: 'Set REPO_CLONE_PATH in .env to a clone dedicated to the bot.',
    });
    return;
  }
  if (!fs.existsSync(path.join(clonePath, '.git'))) {
    add({
      name: 'Code clone',
      status: 'fail',
      detail: `${clonePath} is not a git repository`,
      fix: `git clone https://github.com/${process.env['GITHUB_REPO'] ?? 'mustfintech/l2u-sandbox'}.git ${clonePath}`,
    });
    return;
  }

  const [branch, sha, status] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clonePath }),
    run('git', ['rev-parse', '--short', 'HEAD'], { cwd: clonePath }),
    run('git', ['status', '--porcelain'], { cwd: clonePath }),
  ]);
  const dirtyCount = status.stdout.trim() === '' ? 0 : status.stdout.trim().split('\n').length;
  const branchName = branch.stdout.trim();
  const onMain = branchName === 'main' || branchName === 'master';

  add({
    name: 'Code clone',
    status: dirtyCount > 0 || !onMain ? 'warn' : 'ok',
    detail: `${clonePath} — ${branchName}@${sha.stdout.trim()}${dirtyCount > 0 ? `, ${dirtyCount} uncommitted files` : ''}`,
    fix:
      dirtyCount > 0 || !onMain
        ? 'The bot answers from this working tree. On a shared machine use a dedicated clone pinned to main, not somebody\'s working copy.'
        : undefined,
  });
}

// ---------------------------------------------------------------- slack

async function checkSlack(): Promise<void> {
  const bot = process.env['SLACK_BOT_TOKEN'];
  const app = process.env['SLACK_APP_TOKEN'];

  add({
    name: 'Slack app token',
    status: app?.startsWith('xapp-') ? 'ok' : 'fail',
    detail: app ? (app.startsWith('xapp-') ? 'present' : 'set but not an xapp- token') : 'missing',
    fix: 'Slack app → Basic Information → App-Level Tokens, scope connections:write',
  });

  if (!bot?.startsWith('xoxb-')) {
    add({
      name: 'Slack bot token',
      status: 'fail',
      detail: bot ? 'set but not an xoxb- token' : 'missing',
      fix: 'Slack app → OAuth & Permissions → Bot User OAuth Token',
    });
    return;
  }

  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bot}` },
    });
    const scopes = (response.headers.get('x-oauth-scopes') ?? '').split(',');
    const body = (await response.json()) as { ok: boolean; team?: string; user?: string; error?: string };

    add({
      name: 'Slack bot token',
      status: body.ok ? 'ok' : 'fail',
      detail: body.ok ? `${body.team} / ${body.user}` : (body.error ?? 'invalid'),
      fix: 'Reinstall the app to the workspace and copy the new token.',
    });

    if (body.ok) {
      const verdict = evaluateScopes(scopes);
      const missing = [...verdict.missingRequired, ...verdict.missingOptional];
      add({
        name: 'Slack scopes',
        status: verdict.missingRequired.length > 0 ? 'fail' : missing.length > 0 ? 'warn' : 'ok',
        detail: missing.length > 0 ? `missing: ${missing.join(', ')}` : 'all present',
        fix:
          missing.length > 0
            ? 'Add under OAuth & Permissions, then reinstall — reinstalling issues a new xoxb- token. Without im:history the bot ignores DMs; without reactions:read it falls back to a history lookup.'
            : undefined,
      });
    }
  } catch (error) {
    add({
      name: 'Slack bot token',
      status: 'fail',
      detail: `cannot reach slack.com (${error instanceof Error ? error.message : String(error)})`,
      fix: 'Socket Mode needs outbound access to slack.com.',
    });
  }
}

// ---------------------------------------------------------------- litellm

async function checkLitellm(): Promise<void> {
  const key = process.env['LITELLM_KEY'];
  const baseUrl = process.env['LITELLM_BASE_URL'] ?? 'https://litellm.must.codes';
  if (!key) {
    add({
      name: 'LiteLLM key',
      status: 'fail',
      detail: 'LITELLM_KEY is not set',
      fix: 'Set LITELLM_KEY in .env',
    });
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      add({
        name: 'LiteLLM gateway',
        status: 'fail',
        detail: `${baseUrl} returned ${response.status}`,
        fix: 'Check the key and whether this host can reach the gateway.',
      });
      return;
    }
    const body = (await response.json()) as { data?: { id: string }[] };
    const available = (body.data ?? []).map((m) => m.id);
    add({ name: 'LiteLLM gateway', status: 'ok', detail: `${baseUrl} — ${available.length} models` });

    const chain = (process.env['LITELLM_MODEL_CHAIN'] ?? 'glm-5.2,gemma4,gemini/gemini-3.5-flash')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const compact = process.env['LITELLM_COMPACT_MODEL'] ?? 'gemini/gemini-3.5-flash-lite';
    const gone = missingModels([...chain, compact], available);

    add({
      name: 'Model chain',
      status: gone.length > 0 ? 'fail' : 'ok',
      detail: gone.length > 0 ? `not on the gateway: ${gone.join(', ')}` : chain.join(' -> '),
      fix: `The roster changes. Available now: ${available.slice(0, 8).join(', ')}…`,
    });
  } catch (error) {
    add({
      name: 'LiteLLM gateway',
      status: 'fail',
      detail: `cannot reach ${baseUrl} (${error instanceof Error ? error.message : String(error)})`,
      fix: 'Confirm this machine can reach the gateway — it may be reachable only on the internal network.',
    });
  }
}

// ---------------------------------------------------------------- runtime environment

async function checkRuntimeEnvironment(): Promise<void> {
  const auditDir = process.env['AUDIT_DIR'] ?? path.resolve(process.cwd(), 'audit');
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.accessSync(auditDir, fs.constants.W_OK);
    const mode = fs.statSync(auditDir).mode & 0o777;
    const worldReadable = (mode & 0o007) !== 0 || (mode & 0o070) !== 0;
    add({
      name: 'Audit directory',
      status: worldReadable ? 'warn' : 'ok',
      detail: `${auditDir} (mode ${mode.toString(8)})`,
      fix: worldReadable
        ? `Audit logs contain full Slack conversations. On a shared machine restrict it: chmod 700 ${auditDir}`
        : undefined,
    });
  } catch (error) {
    add({
      name: 'Audit directory',
      status: 'fail',
      detail: `${auditDir} is not writable`,
      fix: String(error),
    });
  }

  // Another instance holding the same Slack connection makes event routing
  // unpredictable, since Slack sends each event to exactly one connection.
  // The lock file is authoritative here; pgrep output differs across platforms.
  const holder = new SingleInstanceLock(SingleInstanceLock.defaultPath()).inspect();
  add({
    name: 'Running instance',
    status: holder ? 'warn' : 'ok',
    detail: holder
      ? `pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}`
      : 'not running on this machine',
    fix: holder
      ? 'Stop it before starting another. Slack routes each event to exactly one connection, so a second instance — on this or any other host — splits traffic unpredictably.'
      : undefined,
  });

  if (os.platform() === 'darwin') {
    try {
      const { stdout } = await run('pmset', ['-g'], { timeoutMs: 5_000 });
      const sleepLine = stdout.split('\n').find((l) => /^\s*sleep\s+\d/.test(l));
      const sleepValue = Number(sleepLine?.match(/sleep\s+(\d+)/)?.[1] ?? '0');
      add({
        name: 'System sleep',
        status: sleepValue > 0 ? 'warn' : 'ok',
        detail: sleepValue > 0 ? `sleeps after ${sleepValue} min` : 'sleep disabled',
        fix:
          sleepValue > 0
            ? 'Sleep drops the Socket Mode connection. For an always-on host: sudo pmset -a sleep 0 disksleep 0'
            : undefined,
      });
    } catch {
      // pmset is unavailable in some contexts; not worth failing over.
    }
  }
}

// ---------------------------------------------------------------- main

const sections: [string, () => Promise<void>][] = [
  ['Runtimes', checkRuntimes],
  ['GitHub', checkGithub],
  ['Code clone', checkClone],
  ['Slack', checkSlack],
  ['LiteLLM', checkLitellm],
  ['Runtime environment', checkRuntimeEnvironment],
];

process.stdout.write(`l2u-bot preflight — ${os.hostname()} (${os.platform()} ${os.arch()})\n\n`);

for (const [, fn] of sections) {
  await fn();
}

process.stdout.write(`${formatResults(results)}\n\n`);

const summary = summarize(results);
process.stdout.write(`${summary.ok} ok · ${summary.warn} warnings · ${summary.fail} failures\n`);
if (summary.fail > 0) {
  process.stdout.write('\nResolve the failures above before starting the bot.\n');
}
// Set the code rather than calling process.exit: exiting immediately truncates
// stdout when it is a pipe.
process.exitCode = summary.exitCode;
