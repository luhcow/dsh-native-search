import z from '@deepseek-ai/schemastery';
export { apply } from './register.js';

export const name = 'provider-web-search';
export const inject = ['web', 'settings', 'credentials', 'llm'];

// Volatile fields can be edited in the normal DSH Settings profile view.
export const Config = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  llmEntryId: z.string().default('llm-pi-ai').volatile(),
  // Empty selects the built-in search tool for the route's interface.
  protocol: z.string().default('').volatile(),
  // auto uses the protocol's own credential header. bearer and api-key override it.
  authMode: z.string().default('auto').volatile(),
  apiVersion: z.string().default('').volatile(),
  searchContextSize: z.string().default('medium').volatile(),
  timeoutMs: z.number().default(30_000).volatile(),
});
