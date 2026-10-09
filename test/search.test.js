import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configValue, parseSearchResponse, resolveRoute, responsesEndpoint, searchHosted } from '../lib/search.js';
import { apply } from '../lib/register.js';

const config = { provider: 'openai', model: 'gpt-4.1-mini', searchContextSize: 'low' };
const settings = (providers = {}) => ({ describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] });
const ctx = (profiles = {}, credentials = { OPENAI_API_KEY: 'test-key' }) => ({
  settings: settings(profiles),
  llm: { listProviders: async () => [{ id: 'openai' }, { id: 'custom' }] },
  credentials: { resolve: async (name) => credentials[name] ? { value: credentials[name] } : undefined },
});
const output = {
  status: 'completed',
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
      { url: 'https://example.org/first', title: 'First' },
      { url: 'https://example.org/second' },
      { url: 'javascript:alert(1)' },
      { url: 'http://127.0.0.1:8080/api' },
      { url: 'https://user:password@example.org/private' },
      { url: 'https://server.internal/settings' },
    ] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer [1]', annotations: [
      { type: 'url_citation', url: 'https://example.org/first', title: 'First source' },
      { type: 'url_citation', url: 'https://example.org/third', title: 'Third source' },
    ] }] },
  ],
};

test('registers an optional provider with live config availability', () => {
  let provider;
  const fields = { provider: '', model: '' };
  apply({ web: { registerSearchProvider: (value) => { provider = value; } } }, {
    provider: { get: () => fields.provider }, model: { get: () => fields.model },
  });
  assert.equal(provider.id, 'provider-responses');
  assert.equal(provider.available(), false);
  fields.provider = 'openai'; fields.model = 'gpt-4.1-mini';
  assert.equal(provider.available(), true);
  assert.equal(typeof provider.search, 'function');
});

test('reads live Cordis config refs and built-in OpenAI settings', () => {
  assert.equal(configValue({ get: () => 'current' }), 'current');
  assert.deepEqual(resolveRoute(settings(), { provider: { get: () => 'openai' }, model: 'gpt-4.1-mini' }), {
    provider: 'openai', model: 'gpt-4.1-mini', protocol: 'openai-responses',
    endpoint: 'https://api.openai.com/v1/responses', credentialRef: 'OPENAI_API_KEY', authMode: 'auto',
  });
});

test('selects the built-in search interface and does not treat chat completions as web_search', () => {
  const custom = { provider: 'custom', model: 'search-model' };
  assert.throws(() => resolveRoute(settings(), custom), /no recognizable built-in web search/);
  assert.throws(() => resolveRoute(settings({
    custom: { api: 'openai-completions', baseURL: 'https://other.test/v1/', apiKeyEnv: 'OTHER_KEY' },
  }), custom), /openai-completions/);
  assert.deepEqual(resolveRoute(settings({
    custom: { api: 'anthropic-messages', baseURL: 'https://other.test', apiKeyEnv: 'OTHER_KEY' },
  }), custom), {
    provider: 'custom', model: 'search-model', protocol: 'anthropic-messages',
    endpoint: 'https://other.test/v1/messages', credentialRef: 'OTHER_KEY', authMode: 'auto',
  });
  assert.throws(() => resolveRoute(settings({ openai: { baseURL: '' } }), config), /endpoint or credential reference is missing/);
});

test('uses direct Responses search on the selected configured model route', async () => {
  const profile = { 'azure-openai-responses': {
    baseURL: 'https://azure.example.test/v1', apiKeyEnv: 'AZURE_OPENAI_RESPONSES_API_KEY',
    models: [{ id: 'configured-search-model' }],
  } };
  const routeConfig = { provider: 'azure-openai-responses', model: 'configured-search-model' };
  assert.deepEqual(resolveRoute(settings(profile), routeConfig), {
    provider: 'azure-openai-responses', model: 'configured-search-model', protocol: 'openai-responses',
    endpoint: 'https://azure.example.test/v1/responses',
    credentialRef: 'AZURE_OPENAI_RESPONSES_API_KEY', authMode: 'auto',
  });
  assert.throws(() => resolveRoute(settings(profile), { ...routeConfig, model: 'not-listed' }), /not declared/);
  let sent;
  const transport = async (url, options) => {
    sent = { url, headers: options.headers };
    return new Response(JSON.stringify(output), { status: 200 });
  };
  const routeCtx = ctx(profile, { AZURE_OPENAI_RESPONSES_API_KEY: 'azure-test-secret' });
  routeCtx.llm.listProviders = async () => [{ id: 'azure-openai-responses' }];
  await searchHosted(routeCtx, routeConfig, { query: 'latest news' }, undefined, transport);
  assert.equal(sent.url, 'https://azure.example.test/v1/responses');
  assert.equal(sent.headers.authorization, 'Bearer azure-test-secret');
  assert.equal(sent.headers['api-key'], undefined);
  assert.deepEqual(resolveRoute(settings(profile), { ...routeConfig, authMode: 'api-key', apiVersion: 'v1' }), {
    provider: 'azure-openai-responses', model: 'configured-search-model', protocol: 'openai-responses',
    endpoint: 'https://azure.example.test/v1/responses?api-version=v1',
    credentialRef: 'AZURE_OPENAI_RESPONSES_API_KEY', authMode: 'api-key',
  });
  await searchHosted(routeCtx, { ...routeConfig, authMode: 'api-key', apiVersion: 'v1' },
    { query: 'latest news' }, undefined, transport);
  assert.equal(sent.headers['api-key'], 'azure-test-secret');
  assert.equal(sent.headers.authorization, undefined);
});

test('rejects insecure and credential-bearing remote URLs', () => {
  assert.throws(() => responsesEndpoint('http://external.test/v1'), /HTTPS/);
  assert.throws(() => responsesEndpoint('https://user:pass@external.test/v1'), /must not include credentials/);
  assert.throws(() => responsesEndpoint('https://external.test/v1?token=secret'), /query or fragment/);
  assert.equal(responsesEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/responses');
  assert.throws(() => responsesEndpoint('https://external.test/v1/responses'), /API root/);
});

test('normalizes real sources, annotations, result caps and answer', () => {
  assert.deepEqual(parseSearchResponse(output, 2), {
    content: 'Answer [1]',
    sources: [
      { url: 'https://example.org/first', title: 'First source' },
      { url: 'https://example.org/third', title: 'Third source' },
    ],
    truncated: true,
  });
  assert.equal(parseSearchResponse(output).sources.length, 3);
  const cited = parseSearchResponse({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { sources: [
      { url: 'https://a.example/' }, { url: 'https://b.example/' },
    ] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Evidence [C]',
      annotations: [{ type: 'url_citation', url: 'https://c.example/' }] }] },
  ] }, 1);
  assert.equal(cited.sources[0].url, 'https://c.example/');
  assert.throws(() => parseSearchResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hallucinated' }] }] }), /did not complete/);
  assert.throws(() => parseSearchResponse({ ...output, status: 'incomplete' }), /did not complete/);
  assert.throws(() => parseSearchResponse({ ...output, output: [
    { ...output.output[0], status: 'in_progress' }, output.output[1],
  ] }), /did not complete/);
});

test('sends only query to the selected connected route and reuses its stored credential', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(output), { status: 200 });
  };
  const result = await searchHosted(ctx(), config, { query: 'latest release', maxResults: 1 }, undefined, fakeFetch);
  assert.equal(result.sources.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-key');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].body.model, 'gpt-4.1-mini');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.tool_choice, 'required');
  assert.deepEqual(requests[0].body.tools, [{ type: 'web_search', search_context_size: 'low' }]);
  assert.deepEqual(requests[0].body.include, ['web_search_call.action.sources']);
  assert.equal(requests[0].body.input, 'latest release');
  assert.ok(!('messages' in requests[0].body));
});

test('clamps an oversized timeout rather than passing it to Node timers', async () => {
  await searchHosted(ctx(), { ...config, timeoutMs: 1e12 }, { query: 'search' }, undefined,
    async () => new Response(JSON.stringify(output), { status: 200 }));
});

test('custom route uses only its configured endpoint and credential', async () => {
  const profile = { custom: { api: 'openai-responses', baseURL: 'https://search.example/v1', apiKeyEnv: 'CUSTOM_KEY' } };
  const used = [];
  const transport = async (url, options) => {
    used.push({ url, headers: options.headers });
    return new Response(JSON.stringify(output), { status: 200 });
  };
  await searchHosted(ctx(profile, { CUSTOM_KEY: 'custom-secret' }),
    { provider: 'custom', model: 'search-model' }, { query: 'search' }, undefined, transport);
  assert.equal(used[0].url, 'https://search.example/v1/responses');
  assert.equal(used[0].headers.authorization, 'Bearer custom-secret');
});

test('does not send a request with a missing credential or invalid query', async () => {
  let calls = 0;
  const send = async () => { calls++; return new Response('{}'); };
  await assert.rejects(searchHosted(ctx({}, {}), config, { query: 'search' }, undefined, send), /not configured/);
  await assert.rejects(searchHosted(ctx(), config, { query: '  ' }, undefined, send), /Search query/);
  assert.equal(calls, 0);
});

test('does not expose provider error text containing credentials', async () => {
  const fakeFetch = async () => new Response('{"error":"Bearer secret"}', { status: 403 });
  await assert.rejects(searchHosted(ctx(), config, { query: 'search' }, undefined, fakeFetch), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('malformed provider output does not echo its body into the error', async () => {
  await assert.rejects(searchHosted(ctx(), config, { query: 'search' }, undefined,
    async () => new Response('{"secret":"sensitive"', { status: 200 })), (error) => {
    assert.equal(error.code, 'HOSTED_SEARCH_INVALID_RESPONSE');
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('times out while waiting for provider metadata before sending HTTP', async () => {
  const waiting = ctx();
  let metadataTimer;
  // AbortSignal.timeout is unref'ed. Simulate pending I/O with a referenced timer
  // so the test runner cannot exit before the 5 ms cancellation fires.
  waiting.llm.listProviders = () => new Promise((resolve) => {
    metadataTimer = setTimeout(() => resolve([{ id: 'openai' }]), 1000);
  });
  try {
    await assert.rejects(searchHosted(waiting, { ...config, timeoutMs: 5 }, { query: 'search' },
      undefined, async () => { throw new Error('HTTP should not start'); }), /timeout/i);
  } finally {
    clearTimeout(metadataTimer);
  }
});

test('preserves cancellation while reading the provider response body', async () => {
  const controller = new AbortController();
  await assert.rejects(searchHosted(ctx(), config, { query: 'search' }, controller.signal,
    async (_url, options) => {
      const body = new ReadableStream({ start(stream) {
        options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
      } });
      queueMicrotask(() => controller.abort(new DOMException('User stopped search', 'AbortError')));
      return new Response(body, { status: 200 });
    }), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

test('honors caller aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchHosted(ctx(), config, { query: 'search' }, controller.signal,
    async (_url, options) => { if (options.signal.aborted) throw options.signal.reason; }), /abort/i);
});

test('uses each provider interface built-in search tool', async () => {
  const seen = [];
  const transport = async (url, options) => {
    seen.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const body = seen.at(-1).body;
    if (body.tools?.[0]?.type === 'web_search_20250305') {
      return new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search' },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [
          { type: 'web_search_result', url: 'https://example.org/claude', title: 'Claude' },
          { type: 'web_search_result', url: 'http://169.254.169.254/latest' },
        ] },
        { type: 'text', text: 'Claude answer', citations: [
          { type: 'web_search_result_location', url: 'https://example.org/cited', title: 'Cited' },
        ] },
      ] }), { status: 200 });
    }
    if (body.tools?.[0]?.google_search) {
      return new Response(JSON.stringify({ candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'Gemini answer' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/gemini', title: 'Gemini' } }] },
      }] }), { status: 200 });
    }
    if (url.includes('api.x.ai')) {
      return new Response(JSON.stringify({
        status: 'completed',
        citations: ['https://example.org/grok', 'javascript:alert(1)'],
        output: [
          { type: 'web_search_call', status: 'completed', action: { type: 'search' } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Grok answer' }] },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'web_search_call', status: 'completed', action: { sources: [
        { url: 'https://example.org/copilot', title: 'Copilot' },
      ] } }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Copilot answer' }] }],
    }), { status: 200 });
  };
  const profiles = {
    anthropic: { api: 'anthropic-messages' },
    google: { api: 'google-generative-ai', models: [{ id: 'gemini-2.5-flash', api: 'google-generative-ai' }] },
    xai: { api: 'openai-completions' },
    'github-copilot': { apiKeyEnv: 'COPILOT_TOKEN' },
  };
  const routeCtx = ctx(profiles, {
    ANTHROPIC_API_KEY: 'anthropic-secret',
    GEMINI_API_KEY: 'gemini-secret',
    XAI_API_KEY: 'xai-secret',
    COPILOT_TOKEN: 'copilot-secret',
  });
  routeCtx.llm.listProviders = async () => Object.keys(profiles).map((id) => ({ id }));

  const anthropic = await searchHosted(routeCtx, { provider: 'anthropic', model: 'claude-sonnet' },
    { query: 'claude news' }, undefined, transport);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'anthropic-secret');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.tools[0].name, 'web_search');
  assert.deepEqual(anthropic.sources.map((source) => source.url), [
    'https://example.org/cited', 'https://example.org/claude',
  ]);

  const gemini = await searchHosted(routeCtx, { provider: 'google', model: 'gemini-2.5-flash' },
    { query: 'gemini news' }, undefined, transport);
  assert.equal(seen[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(seen[1].headers['x-goog-api-key'], 'gemini-secret');
  assert.deepEqual(seen[1].body.tools, [{ google_search: {} }]);
  assert.equal(gemini.content, 'Gemini answer');
  assert.equal(gemini.sources[0].url, 'https://example.org/gemini');

  const grok = await searchHosted(routeCtx, { provider: 'xai', model: 'grok-4', protocol: 'xai-responses' },
    { query: 'grok news' }, undefined, transport);
  assert.equal(seen[2].url, 'https://api.x.ai/v1/responses');
  assert.equal(seen[2].headers.authorization, 'Bearer xai-secret');
  assert.deepEqual(seen[2].body.tools, [{ type: 'web_search' }]);
  assert.equal(seen[2].body.tool_choice, undefined);
  assert.equal(grok.sources[0].url, 'https://example.org/grok');
  assert.equal(grok.sources.length, 1);

  const copilot = await searchHosted(routeCtx, { provider: 'github-copilot', model: 'gpt-4.1' },
    { query: 'copilot news' }, undefined, transport);
  assert.equal(seen[3].url, 'https://api.githubcopilot.com/responses');
  assert.equal(seen[3].headers.authorization, 'Bearer copilot-secret');
  assert.equal(seen[3].headers['Openai-Intent'], 'conversation-edits');
  assert.equal(copilot.content, 'Copilot answer');
});

test('does not call a chat-completions route unless a search protocol is explicit', async () => {
  let calls = 0;
  const send = async () => { calls += 1; return new Response('{}'); };
  const profile = { custom: { api: 'openai-completions', baseURL: 'https://chat.example/v1', apiKeyEnv: 'CUSTOM_KEY' } };
  const routeCtx = ctx(profile, { CUSTOM_KEY: 'secret' });
  await assert.rejects(searchHosted(routeCtx, { provider: 'custom', model: 'chat-model' },
    { query: 'news' }, undefined, send), /openai-completions/);
  assert.equal(calls, 0);
  const forced = await searchHosted(routeCtx, {
    provider: 'custom', model: 'chat-model', protocol: 'openai-responses',
  }, { query: 'news' }, undefined, async () => new Response(JSON.stringify(output), { status: 200 }));
  assert.equal(forced.sources[0].url, 'https://example.org/first');
});

test('rejects a built-in search that never actually searched', async () => {
  const routeCtx = ctx({ anthropic: {} }, { ANTHROPIC_API_KEY: 'anthropic-secret' });
  routeCtx.llm.listProviders = async () => [{ id: 'anthropic' }];
  await assert.rejects(searchHosted(routeCtx, { provider: 'anthropic', model: 'claude' },
    { query: 'news' }, undefined, async () => new Response(JSON.stringify({
      type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I already know this' }],
    }), { status: 200 })), /did not complete/);
});
