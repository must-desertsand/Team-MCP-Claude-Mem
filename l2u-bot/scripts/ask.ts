/**
 * Runs the agent loop without Slack.
 * Same model chain, prompt, and tools as the bot itself; only the Slack lookup
 * tools are omitted.
 *
 *   pnpm ask "Where is Toss payment cancellation handled?"
 */
import OpenAI from 'openai';
import { loadConfig } from '../src/config.js';
import { GithubReader } from '../src/github/reader.js';
import { RepoReader } from '../src/repo/search.js';
import { AgentLoop } from '../src/agent/loop.js';
import { buildRepoTools } from '../src/agent/tools.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { toKstIso } from '../src/slack/normalize.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  process.stderr.write('Usage: pnpm ask "<question>"\n');
  process.exit(1);
}

// Placeholders so the CLI runs without Slack tokens. This path never calls the Slack API.
process.env['SLACK_BOT_TOKEN'] ||= 'cli-not-used';
process.env['SLACK_APP_TOKEN'] ||= 'cli-not-used';

const config = loadConfig();
const openai = new OpenAI({ apiKey: config.litellm.apiKey, baseURL: `${config.litellm.baseUrl}/v1` });
const repo = new RepoReader(config.repo.clonePath);
const github = new GithubReader(config.github.repo);

const [state, overview] = await Promise.all([repo.state(), repo.overview()]);
const tools = buildRepoTools({ github, repo, maxResultBytes: config.limits.toolResultBytes });

const loop = new AgentLoop({
  client: openai,
  models: config.models.chain,
  compactModel: config.models.compact,
  tools,
  limits: config.limits,
  logger: (m) => process.stderr.write(`· ${m}\n`),
});

const started = Date.now();
const outcome = await loop.run(
  buildSystemPrompt({
    repoFullName: config.github.repo,
    repoBranch: state.branch,
    repoSha: state.sha,
    repoDirty: state.dirty,
    repoOverview: overview,
    channel: '(CLI)',
    threadTs: '-',
    requester: 'CLI user',
    nowKst: toKstIso(String(Date.now() / 1000)),
  }),
  question,
);

process.stdout.write(`\n${outcome.text}\n`);
process.stderr.write(
  `\n--- ${outcome.model} · ${outcome.turns} turns · ${outcome.toolCalls.length} tool calls · ${Date.now() - started}ms · ${outcome.stopReason}\n`,
);
for (const c of outcome.toolCalls) {
  process.stderr.write(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} ${JSON.stringify(c.args).slice(0, 90)}\n`);
}
