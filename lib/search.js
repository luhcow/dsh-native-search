// Hosted web search for the built-in tool of the selected model route.
// The wire protocol follows that route's interface (Responses, Anthropic
// Messages, Gemini google_search, xAI and Copilot Responses).
import {
  PROVIDER_DEFAULTS, detectProtocol, endpointFor, requestHeaders, runSearch,
} from './protocols.js';
import { searchError } from './errors.js';

export { parseSearchResponse, responsesEndpoint } from './protocols.js';

export const SEARCH_PROVIDER_ID = 'dsh-native-search';
const MAX_QUERY_CHARS = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function configValue(value) {
  return typeof value?.get === 'function' ? value.get() : value;
}

export function resolveRoute(settings, config) {
  const provider = String(configValue(config.provider) ?? '').trim();
  const model = String(configValue(config.model) ?? '').trim();
  const entryId = String(configValue(config.llmEntryId) ?? 'llm-pi-ai');
  if (!provider || !model) throw new Error('Configure provider and model for hosted web search');
  const entry = settings.describe({ redactSecrets: true })
    .find((item) => String(item.ns) === entryId);
  if (!entry) throw new Error(`Model provider settings entry ${entryId} is not mounted`);
  const profile = entry.value?.providers?.[provider] ?? {};
  if (Array.isArray(profile.models) && !profile.models.some((item) => item?.id === model)) {
    throw new Error(`Model ${model} is not declared on route ${provider}`);
  }
  const protocol = detectProtocol(provider, profile, model, configValue(config.protocol));
  const defaults = PROVIDER_DEFAULTS[provider] ?? {};
  // Only fill a missing field. An explicit empty baseURL or credential stays
  // empty so a custom route cannot silently fall back to api.openai.com.
  const baseURL = profile.baseURL === undefined ? defaults.baseURL : profile.baseURL;
  const credentialRef = profile.apiKeyEnv === undefined ? defaults.credentialRef : profile.apiKeyEnv;
  if (!baseURL || !credentialRef) throw new Error('The provider endpoint or credential reference is missing');
  const authMode = String(configValue(config.authMode) ?? 'auto');
  if (authMode !== 'auto' && authMode !== 'bearer' && authMode !== 'api-key') {
    throw new Error('Unsupported Responses authMode');
  }
  const apiVersion = String(configValue(config.apiVersion) ?? '');
  if (apiVersion && !/^[\w.-]{1,32}$/.test(apiVersion)) throw new Error('Invalid Responses apiVersion');
  const url = new URL(endpointFor(protocol, baseURL, model));
  if (apiVersion) url.searchParams.set('api-version', apiVersion);
  return { provider, model, protocol, endpoint: url.toString(), credentialRef, authMode };
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) throw searchError('INVALID_RESPONSE', 'Provider returned an empty response body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Provider search response exceeds 2 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

function withAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function parseJson(text, signal) {
  signal.throwIfAborted();
  try { return JSON.parse(text); }
  catch {
    throw searchError('INVALID_RESPONSE', 'Invalid hosted search response');
  }
}

export async function searchHosted(ctx, config, request, signal, transport = fetch) {
  const query = request?.query;
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_CHARS) {
    throw new Error('Search query must contain 1–4096 characters');
  }
  const timeoutMs = configValue(config.timeoutMs);
  const timeout = AbortSignal.timeout(Number.isInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 300_000) : 30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const route = resolveRoute(ctx.settings, config);
  const providers = await withAbort(() => ctx.llm.listProviders(), combined);
  if (!providers.some((item) => item.id === route.provider)) {
    throw new Error(`Model provider route ${route.provider} is not connected`);
  }
  const key = await withAbort(() => ctx.credentials.resolve(route.credentialRef), combined);
  if (!key?.value) throw new Error(`Credential ${route.credentialRef} is not configured`);
  combined.throwIfAborted();
  const post = async (body) => {
    const response = await transport(route.endpoint, {
      method: 'POST',
      headers: requestHeaders(route.protocol, route.authMode, key.value),
      redirect: 'error',
      body: JSON.stringify(body),
      signal: combined,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw searchError('HTTP_ERROR', `Hosted web search request failed (HTTP ${response.status})`, { status: response.status });
    }
    return parseJson(await readBounded(response), combined);
  };
  return runSearch(route.protocol, route.model, query, {
    contextSize: configValue(config.searchContextSize),
    maxResults: request.maxResults,
    post,
  });
}
