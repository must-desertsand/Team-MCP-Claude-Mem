export interface Config {
  port: number;
  dbPath: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmMaxConcurrent: number;
  pollMs: number;
  workspacesPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = process.env.HOME ?? "/tmp";
  return {
    port: Number(env.PORT ?? 7337),
    dbPath: env.DB_PATH ?? `${home}/.team-mem-server/data.db`,
    llmBaseUrl: env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1",
    llmApiKey: env.LLM_API_KEY ?? "",
    llmModel: env.LLM_MODEL ?? "glm-5.2",
    llmMaxConcurrent: Number(env.LLM_MAX_CONCURRENT ?? 1),
    pollMs: Number(env.POLL_MS ?? 15000),
    workspacesPath: env.WORKSPACES_PATH ?? new URL("../workspaces.json", import.meta.url).pathname,
  };
}
