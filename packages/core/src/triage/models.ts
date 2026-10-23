// Model fallback chain: gemma3:4b local -> gemma3:1b local -> Render-hosted -> NEEDS_HUMAN.
// Every path is an OpenAI-compatible endpoint, so Mastra drives all of them the same way.
//
// `path` is the model as recorded in triage.model_path (the weights: "gemma3:4b"). The Ollama tag actually
// called can differ: on the build laptop it is a Modelfile copy of the same weights with num_thread capped
// (TRIAGE_MODEL_TAG=nightshift-gemma3-4b), so a night does not take every CPU thread.

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
  const local: [string | undefined, string | undefined][] = [
    [env.TRIAGE_MODEL ?? 'gemma3:4b', env.TRIAGE_MODEL_TAG],
    [env.TRIAGE_FALLBACK_MODEL ?? 'gemma3:1b', env.TRIAGE_FALLBACK_MODEL_TAG],
  ];
  for (const [name, tag] of local) {
    if (name) chain.push({ path: name, id: `ollama/${tag || name}`, url: ollama, apiKey: 'ollama' });
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
