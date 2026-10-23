// Spike: Mastra Agent -> Ollama (OpenAI-compatible /v1) with structured output. Not part of the build.
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

const schema = z.object({ bucket: z.enum(['A', 'B']), reason: z.string() });
const agent = new Agent({
  id: 'spike',
  name: 'spike',
  instructions: 'Classify. Output JSON only.',
  model: { id: 'ollama/nightshift-gemma3-4b', url: 'http://localhost:11434/v1', apiKey: 'ollama' },
});
const t = Date.now();
const r = await agent.generate('Is "Fix typo in README" bucket A (docs) or B (code)?', {
  modelSettings: { temperature: 0 },
  structuredOutput: { schema, errorStrategy: 'fallback', fallbackValue: { bucket: 'B', reason: '__fallback__' } },
});
console.log({ ms: Date.now() - t, object: r.object, text: r.text?.slice(0, 200), usage: r.usage });
process.exit(0);
