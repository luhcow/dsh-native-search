// One native hosted-search request. Never simulate client tool turns or downgrade.
import { isIP } from 'node:net';
import { searchError } from './errors.js';

export const SEARCH_PROTOCOLS = [
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'xai-responses',
  'copilot-responses',
];

const API_PROTOCOL = {
  'openai-responses': 'openai-responses',
  'azure-openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  'google-generative-ai': 'google-generative-ai',
};

const PROVIDER_PROTOCOL = {
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  google: 'google-generative-ai',
  'azure-openai-responses': 'openai-responses',
  xai: 'xai-responses',
  'github-copilot': 'copilot-responses',
};

export const PROVIDER_DEFAULTS = {
  openai: { baseURL: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY' },
  anthropic: { baseURL: 'https://api.anthropic.com', credentialRef: 'ANTHROPIC_API_KEY' },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', credentialRef: 'GEMINI_API_KEY' },
  xai: { baseURL: 'https://api.x.ai/v1', credentialRef: 'XAI_API_KEY' },
  'github-copilot': { baseURL: 'https://api.githubcopilot.com' },
};

const MAX_SOURCES = 20;
const MAX_ANSWER_CHARS = 30_000;
const MAX_OUTPUT_TOKENS = 2048;
const NO_SEARCH = 'Provider did not complete a hosted web search call in this response';

export function sourceUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (parsed.username || parsed.password || !host.includes('.') || isIP(host)
      || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return undefined;
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch { return undefined; }
}

function modelApi(profile, model) {
  const item = profile?.models?.find((entry) => entry?.id === model);
  return typeof item?.api === 'string' && item.api.trim() ? item.api.trim() : undefined;
}

export function detectProtocol(provider, profile, model, explicit) {
  const chosen = String(explicit ?? '').trim();
  if (chosen) {
    if (!SEARCH_PROTOCOLS.includes(chosen)) throw searchError('UNSUPPORTED', `Unsupported search protocol ${chosen}`);
    return chosen;
  }
  const api = modelApi(profile, model) || (typeof profile?.api === 'string' ? profile.api.trim() : '');
  // An explicit chat API is authoritative, even for a familiar provider name.
  if (api) {
    if (Object.hasOwn(API_PROTOCOL, api)) return API_PROTOCOL[api];
    throw searchError('UNSUPPORTED', `API ${api} has no hosted web search adapter in this plugin. `
      + 'If the endpoint also implements a supported native search API, set the plugin protocol explicitly.');
  }
  if (Object.hasOwn(PROVIDER_PROTOCOL, provider)) return PROVIDER_PROTOCOL[provider];
  throw searchError('UNSUPPORTED', `Route ${provider} has no recognizable built-in web search interface. Set the route api or plugin protocol.`);
}

export function parseRoot(baseURL) {
  const url = new URL(baseURL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Provider API baseURL must use HTTPS (HTTP is allowed only on loopback)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider API baseURL must not include credentials, query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(responses|messages|chat\/completions)$/.test(path) || /\/models\/[^/]+:generateContent$/.test(path)) {
    throw new Error('Provider baseURL must be the API root, not an operation endpoint');
  }
  return url;
}

function joinApi(baseURL, suffix) {
  const url = parseRoot(baseURL);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
  return url.toString();
}

export function responsesEndpoint(baseURL) {
  return joinApi(baseURL, '/responses');
}

export function endpointFor(protocol, baseURL, model) {
  if (protocol === 'openai-responses' || protocol === 'xai-responses' || protocol === 'copilot-responses') {
    return responsesEndpoint(baseURL);
  }
  if (protocol === 'anthropic-messages') {
    const url = parseRoot(baseURL);
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/v1') ? `${path}/messages` : `${path}/v1/messages`;
    return url.toString();
  }
  if (protocol === 'google-generative-ai') {
    if (!/^[\w.:-]{1,128}$/.test(model)) throw new Error('Invalid model id for Google search');
    return joinApi(baseURL, `/models/${model}:generateContent`);
  }
  throw searchError('UNSUPPORTED', `Unsupported search protocol ${protocol}`);
}

export function requestHeaders(protocol, authMode, key) {
  const mode = authMode || 'auto';
  const headers = { 'content-type': 'application/json' };
  if (mode === 'api-key') headers['api-key'] = key;
  else if (mode === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (mode !== 'auto') throw new Error('Unsupported search authMode');
  else if (protocol === 'anthropic-messages') headers['x-api-key'] = key;
  else if (protocol === 'google-generative-ai') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  if (protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  if (protocol === 'copilot-responses') {
    headers['Openai-Intent'] = 'conversation-edits';
    headers['User-Agent'] = 'dsh-native-search';
    headers['x-initiator'] = 'user';
  }
  return headers;
}

function contextSize(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

export function requestBody(protocol, model, query, size) {
  if (protocol === 'openai-responses') {
    return {
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: query,
      tools: [{ type: 'web_search', search_context_size: contextSize(size) }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      store: false,
    };
  }
  if (protocol === 'xai-responses') {
    return {
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: query,
      tools: [{ type: 'web_search' }],
      store: false,
    };
  }
  if (protocol === 'copilot-responses') {
    return {
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: query,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
    };
  }
  if (protocol === 'anthropic-messages') {
    return {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    };
  }
  if (protocol === 'google-generative-ai') {
    return {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
  }
  throw searchError('UNSUPPORTED', `Unsupported search protocol ${protocol}`);
}

function sourceList(maxResults) {
  const limit = Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, MAX_SOURCES) : 8;
  const all = new Map();
  return {
    add(value, title) {
      const url = sourceUrl(typeof value === 'string' ? value : value?.url);
      if (!url) return;
      const current = all.get(url);
      if (!current) all.set(url, { url, ...(typeof title === 'string' && title ? { title } : {}) });
      else if (typeof title === 'string' && title && !current.title) current.title = title;
    },
    finish(answer) {
      const text = answer ?? '';
      return {
        ...(text ? { content: text.slice(0, MAX_ANSWER_CHARS) } : {}),
        sources: [...all.values()].slice(0, limit),
        truncated: all.size > limit || text.length > MAX_ANSWER_CHARS,
      };
    },
  };
}

function invalidResponse() {
  throw searchError('INVALID_RESPONSE', 'Invalid hosted search response');
}

function array(value) {
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value;
}

export function parseSearchResponse(data, maxResults = 8, options = {}) {
  object(data);
  if (data.error || data.status === 'failed') throw searchError('FAILED', 'Provider hosted search failed');
  if (['incomplete', 'in_progress', 'queued', 'cancelled'].includes(data.status)) {
    throw searchError('INCOMPLETE', 'Provider did not complete the hosted search response');
  }
  if (data.status !== 'completed') invalidResponse();
  const output = array(data.output).map(object);
  const calls = output.filter((item) => item.type === 'web_search_call');
  if (calls.some((call) => call.status === 'failed')) throw searchError('FAILED', 'Provider web search call failed');
  if (calls.some((call) => !['completed', 'in_progress', 'searching'].includes(call.status))) invalidResponse();
  if (calls.some((call) => call.status !== 'completed')) {
    throw searchError('INCOMPLETE', 'Provider did not complete a hosted web search call');
  }
  const bag = sourceList(maxResults);
  const parts = [];
  for (const item of output) {
    if (item.type === 'function_call') throw searchError('INCOMPLETE', 'Provider requested an unsupported client tool turn');
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    if (item.status && item.status !== 'completed') throw searchError('INCOMPLETE', 'Provider assistant message is incomplete');
    for (const block of array(item.content).map(object)) {
      if (block.type === 'refusal') throw searchError('FAILED', 'Provider refused the search answer');
      if (block.type !== 'output_text') continue;
      if (typeof block.text !== 'string') invalidResponse();
      parts.push(block.text);
      for (const annotation of array(block.annotations ?? []).map(object)) {
        if (annotation.type === 'url_citation') bag.add(annotation.url, annotation.title);
      }
    }
  }
  for (const call of calls) {
    if (call.action !== undefined) object(call.action);
    for (const source of array(call.action?.sources ?? [])) bag.add(source, source?.title);
  }
  if (options.acceptCitations && data.citations !== undefined) {
    for (const citation of array(data.citations)) bag.add(citation);
  }
  // Citations supplement proven calls; no option may disable execution evidence.
  if (!calls.length) throw searchError('NOT_EXECUTED', NO_SEARCH);
  return bag.finish(parts.join('\n\n'));
}

function parseAnthropicResponse(data, maxResults) {
  object(data);
  if (data.error || data.type === 'error') throw searchError('FAILED', 'Provider hosted search failed');
  const blocks = array(data.content).map(object);
  // Tool errors win even when earlier calls returned useful results.
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && block.content?.type === 'web_search_tool_result_error') {
      throw searchError('FAILED', 'Provider web search tool failed');
    }
  }
  if (['pause_turn', 'max_tokens', 'tool_use', 'model_context_window_exceeded'].includes(data.stop_reason)) {
    throw searchError('INCOMPLETE', 'Provider search response is incomplete; continuation is disabled');
  }
  if (data.stop_reason === 'refusal') throw searchError('FAILED', 'Provider refused the search');
  if (data.type !== 'message' || data.role !== 'assistant' || data.stop_reason !== 'end_turn') invalidResponse();
  const bag = sourceList(maxResults);
  const parts = [];
  const found = [];
  const pending = new Set();
  const ids = new Set();
  let searched = false;
  for (const block of blocks) {
    if (block.type === 'server_tool_use') {
      if (block.name !== 'web_search' || typeof block.id !== 'string' || !block.id || ids.has(block.id)) invalidResponse();
      pending.add(block.id);
      ids.add(block.id);
    } else if (block.type === 'web_search_tool_result') {
      if (!pending.delete(block.tool_use_id)) invalidResponse();
      for (const result of array(block.content).map(object)) {
        if (result.type !== 'web_search_result' || typeof result.url !== 'string') invalidResponse();
        found.push(result);
      }
      searched = true;
    } else if (block.type === 'tool_use') {
      throw searchError('INCOMPLETE', 'Provider requested an unsupported client tool turn');
    } else if (block.type === 'text') {
      if (typeof block.text !== 'string') invalidResponse();
      parts.push(block.text);
      for (const citation of array(block.citations ?? []).map(object)) {
        if (citation.type === 'web_search_result_location') bag.add(citation.url, citation.title);
      }
    }
  }
  if (pending.size) throw searchError('INCOMPLETE', 'Provider did not return all hosted search results');
  if (!searched) throw searchError('NOT_EXECUTED', NO_SEARCH);
  // Inline citations take the maxResults budget ahead of uncited result pages.
  for (const result of found) bag.add(result.url, result.title);
  return bag.finish(parts.join('\n\n').trim());
}

function parseGoogleResponse(data, maxResults) {
  object(data);
  if (data.error || data.promptFeedback?.blockReason) throw searchError('FAILED', 'Provider rejected or failed the search');
  const candidate = object(array(data.candidates)[0]);
  if (candidate.finishReason === 'MAX_TOKENS') throw searchError('INCOMPLETE', 'Provider search response reached its output limit');
  if (!candidate.finishReason || candidate.finishReason === 'FINISH_REASON_UNSPECIFIED') invalidResponse();
  if (candidate.finishReason !== 'STOP') throw searchError('FAILED', 'Provider did not finish the search successfully');
  const metadata = candidate.groundingMetadata === undefined ? {} : object(candidate.groundingMetadata);
  const queries = array(metadata.webSearchQueries ?? []);
  if (queries.some((query) => typeof query !== 'string' || !query.trim())) invalidResponse();
  const bag = sourceList(maxResults);
  const parts = [];
  for (const part of array(candidate.content?.parts ?? []).map(object)) {
    // Thinking content is not the final answer.
    if (typeof part.text === 'string' && !part.thought) parts.push(part.text);
  }
  let webEvidence = false;
  for (const chunk of array(metadata.groundingChunks ?? []).map(object)) {
    if (chunk.web === undefined) continue;
    const web = object(chunk.web);
    if (typeof web.uri !== 'string') invalidResponse();
    let url;
    try { url = new URL(web.uri); } catch { invalidResponse(); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') invalidResponse();
    webEvidence = true;
    bag.add(web.uri, web.title);
  }
  // Used search queries prove execution even when there are zero result URLs.
  // An empty metadata object or groundingSupports alone does not prove search.
  if (!queries.length && !webEvidence) throw searchError('NO_EVIDENCE', 'Provider returned no verifiable hosted search evidence');
  return bag.finish(parts.join('\n\n').trim());
}

export async function runSearch(protocol, model, query, { contextSize: size, maxResults, post }) {
  const data = await post(requestBody(protocol, model, query, size));
  if (protocol === 'anthropic-messages') return parseAnthropicResponse(data, maxResults);
  if (protocol === 'google-generative-ai') return parseGoogleResponse(data, maxResults);
  if (protocol === 'xai-responses') return parseSearchResponse(data, maxResults, { acceptCitations: true });
  return parseSearchResponse(data, maxResults);
}
