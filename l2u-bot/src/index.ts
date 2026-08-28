import OpenAI from 'openai';
import { loadConfig, ConfigError } from './config.js';
import { SlackGateway } from './slack/gateway.js';
import { SlackCollector } from './slack/collector.js';
import { SlackResponder } from './slack/responder.js';
import { GithubReader } from './github/reader.js';
import { RepoReader } from './repo/search.js';
import { AgentLoop } from './agent/loop.js';
import { buildTools } from './agent/tools.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { renderTranscript, toKstIso } from './slack/normalize.js';
import { AuditLog } from './audit/log.js';
import { SingleInstanceLock, LockError } from './lock.js';
import type { Job } from './types.js';

function log(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Two instances would split Slack traffic unpredictably rather than duplicate it.
  const lock = new SingleInstanceLock(SingleInstanceLock.defaultPath());
  lock.acquire();

  const openai = new OpenAI({ apiKey: config.litellm.apiKey, baseURL: `${config.litellm.baseUrl}/v1` });
  const github = new GithubReader(config.github.repo);
  const repo = new RepoReader(config.repo.clonePath);
  const audit = new AuditLog(config.auditDir, config.auditRetentionDays);

  const pruned = audit.prune();
  if (pruned.length > 0) log(`Pruned ${pruned.length} audit log(s) past retention`);
  // Audit logs contain verbatim conversations; prune daily so a long-running
  // instance does not accumulate them indefinitely.
  const pruneTimer = setInterval(() => {
    const files = audit.prune();
    if (files.length > 0) log(`Pruned ${files.length} audit log(s) past retention`);
  }, 24 * 60 * 60_000);
  pruneTimer.unref();

  const gateway = new SlackGateway({
    botToken: config.slack.botToken,
    appToken: config.slack.appToken,
    allowedChannels: config.slack.allowedChannels,
    logger: log,
    onJob: (job) => {
      queue = queue.then(() => handle(job)).catch((error) => log(`Job handling failed: ${error}`));
    },
  });

  const collector = new SlackCollector(gateway.client);
  const responder = new SlackResponder(gateway.client);

  // Running jobs concurrently spikes both rate limits and cost. Process them serially.
  let queue: Promise<void> = Promise.resolve();

  async function handle(job: Job): Promise<void> {
    const started = Date.now();
    let placeholderTs: string | undefined;

    try {
      placeholderTs = await responder.postPlaceholder(job.channel, job.threadTs);

      const [thread, repoState, repoOverview] = await Promise.all([
        collector.readThread(job.channel, job.threadTs).catch(() => []),
        repo.state().catch(() => ({ branch: 'unknown', sha: 'unknown', dirty: false })),
        repo.overview().catch(() => '(repository overview unavailable)'),
      ]);

      const tools = buildTools({
        slack: collector,
        github,
        repo,
        defaultChannel: job.channel,
        maxResultBytes: config.limits.toolResultBytes,
      });

      // Slack rate-limits chat.update to roughly one call per second per channel,
      // so progress notes are throttled rather than sent every turn.
      let lastProgressAt = 0;
      const progressIntervalMs = 5_000;

      const loop = new AgentLoop({
        client: openai,
        models: config.models.chain,
        compactModel: config.models.compact,
        tools,
        limits: config.limits,
        logger: log,
        onProgress: (note) => {
          const now = Date.now();
          if (now - lastProgressAt < progressIntervalMs || !placeholderTs) return;
          lastProgressAt = now;
          void responder.updateProgress(job.channel, placeholderTs, note);
        },
      });

      const systemPrompt = buildSystemPrompt({
        repoFullName: config.github.repo,
        repoBranch: repoState.branch,
        repoSha: repoState.sha,
        repoDirty: repoState.dirty,
        repoOverview,
        channel: job.channel,
        threadTs: job.threadTs,
        requester: job.userId,
        nowKst: toKstIso(String(Date.now() / 1000)),
      });

      const userPrompt = [
        '## Conversation in this thread',
        thread.length > 0 ? renderTranscript(thread) : '(thread content could not be read)',
        '',
        '## The question the requester just asked',
        job.text || '(the question body is empty; summarize the thread context instead)',
      ].join('\n');

      log(`Job started: ${job.eventId} / ${job.text.slice(0, 60)}`);
      const outcome = await loop.run(systemPrompt, userPrompt);

      const footer = `\n\n_${outcome.model} · ${outcome.turns} turns · ${outcome.toolCalls.length} tool calls · code ${repoState.branch}@${repoState.sha}${repoState.dirty ? '+dirty' : ''}_`;
      await responder.finalize(job.channel, placeholderTs, outcome.text + footer);
      audit.record(job, outcome, Date.now() - started);
      log(`Job finished: ${job.eventId} (${Date.now() - started}ms, ${outcome.stopReason})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`Job error: ${job.eventId} ${reason}`);
      audit.recordFailure(job, reason, Date.now() - started);
      if (placeholderTs) {
        await responder.fail(job.channel, placeholderTs, reason).catch(() => undefined);
      }
    }
  }

  await gateway.start();
  log(`l2u-bot started. repo=${config.github.repo} clone=${config.repo.clonePath}`);
  log(`Model chain: ${config.models.chain.map((m) => m.id).join(' -> ')}`);
  log(
    config.slack.allowedChannels.length > 0
      ? `Allowed channels: ${config.slack.allowedChannels.join(', ')}`
      : 'Allowed channels: unrestricted (setting SLACK_ALLOWED_CHANNELS is recommended)',
  );

  const shutdown = async (): Promise<void> => {
    log('Shutting down.');
    await gateway.stop().catch(() => undefined);
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  if (error instanceof LockError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  if (error instanceof ConfigError) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`Startup failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
