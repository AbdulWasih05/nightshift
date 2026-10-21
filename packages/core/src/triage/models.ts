// Model fallback chain: gemma3:4b local -> gemma3:1b local -> Render-hosted -> NEEDS_HUMAN.
// Every path is an OpenAI-compatible endpoint, so Mastra drives all of them the same way.

export interface ModelSpec {
  /** Recorded in triage.model_path, e.g. "gemma3:4b" or "hosted". */
  path: string;
  id: `${string}/${string}`;
  url: string;
  apiKey: string;
}

export function modelChain(env: NodeJS.ProcessEnv = process.env): ModelSpec[] {
  const ollama = `${(env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`;
  const chain: ModelSpec[] = [];
  for (const name of [env.TRIAGE_MODEL ?? 'gemma3:4b', env.TRIAGE_FALLBACK_MODEL ?? 'gemma3:1b']) {
    if (name) chain.push({ path: name, id: `ollama/${name}`, url: ollama, apiKey: 'ollama' });
  }
  if (env.HOSTED_MODEL_URL && env.HOSTED_MODEL_NAME) {
    chain.push({
      path: 'hosted',
      id: `hosted/${env.HOSTED_MODEL_NAME}`,
      url: env.HOSTED_MODEL_URL,
      apiKey: env.HOSTED_MODEL_API_KEY ?? 'none',
    });
  }
  return chain;
}
