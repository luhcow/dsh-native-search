import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProtocol, parseSearchResponse, requestBody, runSearch } from '../lib/protocols.js';
import { searchHosted } from '../lib/search.js';

// All settings, credentials and HTTP responses below are local test doubles.
// No real credential store, environment credential or business API is accessed.
const MODEL = 'strict-test-model';
const QUERY = ' \t最新 release "exact query"\n第二行  ';
const KEY = 'strict-test-fake-key';
const SOURCE = 'https://example.org/evidence';
const CODE = {
  unsupported: 'HOSTED_SEARCH_UNSUPPORTED',
  notExecuted: 'HOSTED_SEARCH_NOT_EXECUTED',
  noEvidence: 'HOSTED_SEARCH_NO_EVIDENCE',
  failed: 'HOSTED_SEARCH_FAILED',
  incomplete: 'HOSTED_SEARCH_INCOMPLETE',
  invalid: 'HOSTED_SEARCH_INVALID_RESPONSE',
  http: 'HOSTED_SEARCH_HTTP_ERROR',
};

const searchCall = (overrides = {}) => ({
  type: 'web_search_call', id: 'search_1', status: 'completed',
  action: { type: 'search', query: QUERY, sources: [] }, ...overrides,
});
const responseMessage = (annotations = []) => ({
  type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'Search completed.', annotations }],
});
const responses = (overrides = {}) => ({
  status: 'completed', output: [searchCall(), responseMessage()], ...overrides,
});
const serverToolUse = (id = 'srvtoolu_1') => ({
  type: 'server_tool_use', id, name: 'web_search', input: { query: QUERY },
});
const toolResult = (tool_use_id = 'srvtoolu_1', content = []) => ({
  type: 'web_search_tool_result', tool_use_id, content,
});
const anthropic = (overrides = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [serverToolUse(), toolResult(), { type: 'text', text: 'Search completed.' }],
  ...overrides,
});
const gemini = (candidateOverrides = {}, rootOverrides = {}) => ({
  candidates: [{
    finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Search completed.' }] },
    groundingMetadata: { webSearchQueries: ['test search query'] },
    ...candidateOverrides,
  }],
  ...rootOverrides,
});

function codeIs(expected) {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, expected);
    return true;
  };
}

function harness({ provider = 'fixture', profile = {}, protocol = 'openai-responses' } = {},
  payload = responses(), status = 200) {
  const requests = [];
  const credentialRefs = [];
  const ctx = {
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      [provider]: {
        baseURL: 'https://strict-search.example.invalid/v1', apiKeyEnv: 'STRICT_FAKE_KEY', ...profile,
      },
    } } }] },
    llm: { listProviders: async () => [{ id: provider }] },
    credentials: { resolve: async (ref) => {
      credentialRefs.push(ref);
      assert.equal(ref, 'STRICT_FAKE_KEY');
      return { value: KEY };
    } },
  };
  const config = { provider, model: MODEL, protocol, searchContextSize: 'low' };
  const transport = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  };
  return {
    requests, credentialRefs, ctx, config, transport,
    search: (request = { query: QUERY }) => searchHosted(ctx, config, request, undefined, transport),
  };
}

async function rejectsOnce(protocol, payload, expected) {
  const fixture = harness({ protocol }, payload);
  await assert.rejects(fixture.search(), codeIs(expected));
  assert.equal(fixture.requests.length, 1, 'failure must not retry, downgrade or continue');
}

const protocols = [
  { protocol: 'openai-responses', payload: responses, path: `/v1/responses` },
  { protocol: 'xai-responses', payload: responses, path: `/v1/responses` },
  { protocol: 'copilot-responses', payload: responses, path: `/v1/responses` },
  { protocol: 'anthropic-messages', payload: anthropic, path: `/v1/messages` },
  { protocol: 'google-generative-ai', payload: gemini, path: `/v1/models/${MODEL}:generateContent` },
];

function assertNativeRequest(protocol, body) {
  assert.equal(body.system, undefined, 'no synthetic system prompt');
  assert.equal(body.instructions, undefined, 'no synthetic instructions');
  assert.equal(body.previous_response_id, undefined, 'no continuation state');
  assert.equal(body.conversation, undefined, 'no conversation context');
  if (protocol === 'anthropic-messages') {
    assert.equal(body.model, MODEL);
    assert.deepEqual(body.messages, [{ role: 'user', content: QUERY }]);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, 'web_search_20250305');
    assert.equal(body.tools[0].name, 'web_search');
    assert.equal(body.input, undefined);
  } else if (protocol === 'google-generative-ai') {
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: QUERY }] }]);
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.equal(body.systemInstruction, undefined);
    assert.equal(body.messages, undefined);
  } else {
    assert.equal(body.model, MODEL);
    assert.equal(body.input, QUERY, 'query must be preserved verbatim, including whitespace');
    assert.equal(body.messages, undefined);
    assert.deepEqual(body.tools, protocol === 'openai-responses'
      ? [{ type: 'web_search', search_context_size: 'low' }]
      : [{ type: 'web_search' }]);
    if (protocol === 'openai-responses') {
      assert.equal(body.tool_choice, 'required');
      assert.deepEqual(body.include, ['web_search_call.action.sources']);
    }
  }
}

for (const { protocol, payload, path } of protocols) {
  test(`strict ${protocol}: exact query and native tool with one HTTP request`, async () => {
    assertNativeRequest(protocol, requestBody(protocol, MODEL, QUERY, 'low'));
    const fixture = harness({ protocol }, payload());
    const result = await fixture.search({
      query: QUERY, maxResults: 8,
      messages: [{ role: 'system', content: 'DO_NOT_SEND_HISTORY' }],
      history: 'DO_NOT_SEND_HISTORY', system: 'DO_NOT_SEND_HISTORY',
    });
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.credentialRefs, ['STRICT_FAKE_KEY']);
    const sent = fixture.requests[0];
    assert.equal(sent.url, `https://strict-search.example.invalid${path}`);
    assert.equal(sent.options.method, 'POST');
    assert.equal(sent.options.redirect, 'error');
    assertNativeRequest(protocol, sent.body);
    assert.doesNotMatch(sent.options.body, /DO_NOT_SEND_HISTORY/);
    assert.deepEqual(result.sources, [], 'completed searches may have zero sources');
    assert.equal(result.truncated, false);
  });

  for (const status of [400, 429, 500]) {
    test(`strict ${protocol}: HTTP ${status} is single-request and redacts body`, async () => {
      const secret = 'PRIVATE_RESPONSE_BODY_TOKEN';
      const fixture = harness({ protocol }, `{"error":"${secret}"}`, status);
      await assert.rejects(fixture.search(), (error) => {
        codeIs(CODE.http)(error);
        assert.equal(error.status, status);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.doesNotMatch(String(error.stack), new RegExp(secret));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
        return true;
      });
      assert.equal(fixture.requests.length, 1);
    });
  }
}

test('strict protocol precedence: explicit protocol overrides model and route APIs', () => {
  assert.equal(detectProtocol('openai', {
    api: 'anthropic-messages', models: [{ id: MODEL, api: 'google-generative-ai' }],
  }, MODEL, 'openai-responses'), 'openai-responses');
  assert.equal(detectProtocol('fixture', {
    api: 'openai-completions', models: [{ id: MODEL, api: 'openai-completions' }],
  }, MODEL, 'openai-responses'), 'openai-responses');
  assert.throws(() => detectProtocol('openai', { api: 'openai-responses' }, MODEL,
    'moonshot-chat'), codeIs(CODE.unsupported));
});

test('strict protocol precedence: model API, then route API, then no-API provider default', () => {
  assert.equal(detectProtocol('xai', {
    api: 'anthropic-messages', models: [{ id: MODEL, api: 'google-generative-ai' }],
  }, MODEL), 'google-generative-ai');
  assert.equal(detectProtocol('openai', {
    api: 'anthropic-messages', models: [{ id: 'another-model', api: 'google-generative-ai' }],
  }, MODEL), 'anthropic-messages');
  assert.equal(detectProtocol('fixture', {
    api: 'openai-completions', models: [{ id: MODEL, api: 'openai-responses' }],
  }, MODEL), 'openai-responses');
  for (const [provider, expected] of Object.entries({
    openai: 'openai-responses', anthropic: 'anthropic-messages', google: 'google-generative-ai',
    xai: 'xai-responses', 'github-copilot': 'copilot-responses',
  })) assert.equal(detectProtocol(provider, {}, MODEL), expected);
});

const unsupportedRoutes = [
  ...['openai', 'anthropic', 'google', 'xai', 'github-copilot'].map((provider) => ({
    label: `${provider} must not override explicit completions API`,
    provider, profile: { api: 'openai-completions' },
  })),
  { label: 'model unsupported API overrides supported route API', provider: 'openai',
    profile: { api: 'openai-responses', models: [{ id: MODEL, api: 'openai-completions' }] } },
  { label: 'unknown API on known provider', provider: 'openai', profile: { api: 'unknown-api' } },
  { label: 'unknown provider without API', provider: 'unknown-provider' },
  { label: 'Moonshot international default', provider: 'moonshotai' },
  { label: 'Moonshot China default', provider: 'moonshotai-cn' },
  { label: 'Moonshot explicit protocol', protocol: 'moonshot-chat' },
  { label: 'Moonshot API', profile: { api: 'moonshot-chat' } },
  { label: 'unknown explicit protocol cannot fall back', protocol: 'unknown-protocol',
    profile: { api: 'openai-responses' } },
];
for (const { label, provider = 'fixture', profile = {}, protocol } of unsupportedRoutes) {
  test(`strict unsupported route sends no HTTP: ${label}`, async () => {
    assert.throws(() => detectProtocol(provider, profile, MODEL, protocol), codeIs(CODE.unsupported));
    const fixture = harness({ provider, profile, protocol: undefined });
    // Omit protocol explicitly: the harness's default is only for response-parser tests.
    fixture.config.protocol = protocol;
    await assert.rejects(fixture.search(), codeIs(CODE.unsupported));
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.credentialRefs.length, 0);
  });
}

test('strict explicit Responses opt-in on a completions route sends exactly one Responses request', async () => {
  const fixture = harness({ provider: 'openai', profile: { api: 'openai-completions' },
    protocol: 'openai-responses' });
  await fixture.search();
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0].url, /\/responses$/);
  assertNativeRequest('openai-responses', fixture.requests[0].body);
});

test('strict removed Moonshot cannot invoke post or construct a request', async () => {
  assert.throws(() => requestBody('moonshot-chat', MODEL, QUERY, 'low'), codeIs(CODE.unsupported));
  let posts = 0;
  await assert.rejects(runSearch('moonshot-chat', MODEL, QUERY, {
    post: async () => { posts += 1; return {}; },
  }), codeIs(CODE.unsupported));
  assert.equal(posts, 0);
});

const responseFailures = [
  ['complete answer without search', responses({ output: [responseMessage()] }), CODE.notExecuted],
  ['complete empty output without search', responses({ output: [] }), CODE.notExecuted],
  ['citations without search', responses({ output: [responseMessage([
    { type: 'url_citation', url: SOURCE },
  ])], citations: [SOURCE] }), CODE.notExecuted],
  ['embedded provider error', responses({ error: { code: 'server_error', message: 'failed' } }), CODE.failed],
  ['failed response', responses({ status: 'failed' }), CODE.failed],
  ['failed search call', responses({ output: [searchCall({ status: 'failed' })] }), CODE.failed],
  ['successful call cannot hide another failed call', responses({
    output: [searchCall(), searchCall({ id: 'search_2', status: 'failed' })],
  }), CODE.failed],
  ['incomplete response', responses({ status: 'incomplete' }), CODE.incomplete],
  ['in-progress response', responses({ status: 'in_progress' }), CODE.incomplete],
  ['queued response', responses({ status: 'queued' }), CODE.incomplete],
  ['in-progress search call', responses({ output: [searchCall({ status: 'in_progress' })] }), CODE.incomplete],
  ['actively searching call', responses({ output: [searchCall({ status: 'searching' })] }), CODE.incomplete],
  ['missing response status', { output: [searchCall()] }, CODE.invalid],
  ['unknown response status', responses({ status: 'not_a_response_status' }), CODE.invalid],
  ['missing search call status', responses({ output: [{ type: 'web_search_call' }] }), CODE.invalid],
  ['unknown search call status', responses({ output: [searchCall({ status: 'not_a_call_status' })] }), CODE.invalid],
  ['non-array output', responses({ output: {} }), CODE.invalid],
  ['invalid message content', responses({ output: [searchCall(), {
    type: 'message', role: 'assistant', content: {},
  }] }), CODE.invalid],
  ['null body', null, CODE.invalid],
];
for (const protocol of ['openai-responses', 'xai-responses', 'copilot-responses']) {
  for (const [label, payload, expected] of responseFailures) {
    test(`strict ${protocol}: ${label}`, () => rejectsOnce(protocol, payload, expected));
  }
}

test('strict exported Responses parser never honors the old requireCall:false bypass', () => {
  const payload = responses({
    output: [responseMessage([{ type: 'url_citation', url: SOURCE }])], citations: [SOURCE],
  });
  assert.throws(() => parseSearchResponse(payload, 8, {
    requireCall: false, acceptCitations: true,
  }), codeIs(CODE.notExecuted));
  assert.deepEqual(parseSearchResponse(responses()).sources, []);
});

test('strict xAI citations supplement a completed search call, but are not execution evidence', async () => {
  const fixture = harness({ protocol: 'xai-responses' }, responses({ citations: [SOURCE] }));
  const result = await fixture.search();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(result.sources, [{ url: SOURCE }]);
});

const anthropicFailures = [
  ['complete answer without search', anthropic({ content: [{ type: 'text', text: 'Known answer' }] }), CODE.notExecuted],
  ['complete empty content without search', anthropic({ content: [] }), CODE.notExecuted],
  ['unpaired result', anthropic({ content: [toolResult()] }), CODE.invalid],
  ['mismatched tool result ID', anthropic({ content: [serverToolUse('call_a'), toolResult('call_b')] }), CODE.invalid],
  ['duplicate server tool-use ID', anthropic({ content: [serverToolUse(), serverToolUse(), toolResult()] }), CODE.invalid],
  ['duplicate result for one tool-use ID', anthropic({ content: [serverToolUse(), toolResult(), toolResult()] }), CODE.invalid],
  ['missing tool-use ID', anthropic({ content: [{ type: 'server_tool_use', name: 'web_search' }, toolResult()] }), CODE.invalid],
  ['missing result tool_use_id', anthropic({ content: [serverToolUse(), {
    type: 'web_search_tool_result', content: [],
  }] }), CODE.invalid],
  ['unpaired tool use', anthropic({ content: [serverToolUse()] }), CODE.incomplete],
  ['result paired to the wrong tool', anthropic({ content: [{
    ...serverToolUse(), name: 'not_web_search',
  }, toolResult()] }), CODE.invalid],
  ['tool error object', anthropic({ content: [serverToolUse(), toolResult('srvtoolu_1', {
    type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded',
  })] }), CODE.failed],
  // Anthropic errors use an object-valued content union, not result-array items.
  ['tool error in invalid result-array position', anthropic({ content: [serverToolUse(), toolResult('srvtoolu_1', [{
    type: 'web_search_tool_result_error', error_code: 'unavailable',
  }])] }), CODE.invalid],
  ['embedded provider error', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, CODE.failed],
  ...['pause_turn', 'max_tokens', 'tool_use'].map((stop_reason) => [
    `unfinished stop_reason ${stop_reason}`, anthropic({ stop_reason }), CODE.incomplete,
  ]),
  ['missing message type', anthropic({ type: undefined }), CODE.invalid],
  ['wrong message role', anthropic({ role: 'user' }), CODE.invalid],
  ['missing stop reason', anthropic({ stop_reason: undefined }), CODE.invalid],
  ['non-array message content', anthropic({ content: {} }), CODE.invalid],
  ['invalid result content', anthropic({ content: [serverToolUse(), toolResult('srvtoolu_1', 'bad')] }), CODE.invalid],
];
for (const [label, payload, expected] of anthropicFailures) {
  test(`strict Anthropic: ${label}`, () => rejectsOnce('anthropic-messages', payload, expected));
}

test('strict Anthropic: matching IDs accept empty results and actual search result arrays', async () => {
  const fixture = harness({ protocol: 'anthropic-messages' }, anthropic({ content: [
    serverToolUse('empty'), toolResult('empty'), serverToolUse('found'), toolResult('found', [
      { type: 'web_search_result', url: SOURCE, title: 'Evidence', encrypted_content: 'opaque' },
    ]),
  ] }));
  assert.deepEqual((await fixture.search()).sources, [{ url: SOURCE, title: 'Evidence' }]);
  assert.equal(fixture.requests.length, 1);
});

const geminiFailures = [
  ['no grounding metadata', gemini({ groundingMetadata: undefined }), CODE.noEvidence],
  ['empty grounding metadata', gemini({ groundingMetadata: {} }), CODE.noEvidence],
  ['empty query and chunk arrays', gemini({ groundingMetadata: { webSearchQueries: [], groundingChunks: [] } }), CODE.noEvidence],
  ['blank query entries are malformed evidence', gemini({ groundingMetadata: { webSearchQueries: ['', ' \t '] } }), CODE.invalid],
  ['groundingSupports alone do not prove search', gemini({ groundingMetadata: {
    groundingSupports: [{ segment: { text: 'Unverified' }, groundingChunkIndices: [0] }],
  } }), CODE.noEvidence],
  ['non-web grounding chunk does not prove web search', gemini({ groundingMetadata: {
    groundingChunks: [{ retrievedContext: { uri: SOURCE, title: 'Not web search' } }],
  } }), CODE.noEvidence],
  ['web grounding chunk without URI is malformed evidence', gemini({ groundingMetadata: {
    groundingChunks: [{ web: {} }],
  } }), CODE.invalid],
  ['embedded provider error', { error: { code: 500, status: 'INTERNAL', message: 'failed' } }, CODE.failed],
  ['embedded error despite completed candidate', gemini({}, { error: { code: 500, message: 'failed' } }), CODE.failed],
  ['prompt safety block without candidates', { promptFeedback: { blockReason: 'SAFETY' } }, CODE.failed],
  ...['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT'].map((finishReason) => [
    `candidate safety block ${finishReason}`, gemini({ finishReason }), CODE.failed,
  ]),
  ['truncated candidate', gemini({ finishReason: 'MAX_TOKENS' }), CODE.incomplete],
  ['missing finish reason', gemini({ finishReason: undefined }), CODE.invalid],
  ['empty candidates', { candidates: [] }, CODE.invalid],
  ['non-array candidates', { candidates: {} }, CODE.invalid],
  ['invalid candidate content parts', gemini({ content: { parts: {} } }), CODE.invalid],
];
for (const [label, payload, expected] of geminiFailures) {
  test(`strict Gemini: ${label}`, () => rejectsOnce('google-generative-ai', payload, expected));
}

test('strict Gemini: actual queries with no chunks are a successful zero-result search', async () => {
  const fixture = harness({ protocol: 'google-generative-ai' }, gemini({ groundingMetadata: {
    webSearchQueries: ['query with zero results'], groundingChunks: [],
  } }));
  assert.deepEqual((await fixture.search()).sources, []);
  assert.equal(fixture.requests.length, 1);
});

test('strict Gemini: real web grounding chunks are evidence even without a query list', async () => {
  const fixture = harness({ protocol: 'google-generative-ai' }, gemini({ groundingMetadata: {
    groundingChunks: [{ web: { uri: SOURCE, title: 'Evidence' } }],
  } }));
  assert.deepEqual((await fixture.search()).sources, [{ url: SOURCE, title: 'Evidence' }]);
  assert.equal(fixture.requests.length, 1);
});

for (const suffix of ['/responses', '/messages', '/chat/completions', '/models/model:generateContent']) {
  test(`strict API root validation rejects operation endpoint ${suffix} before HTTP`, async () => {
    const fixture = harness({ profile: { baseURL: `https://strict-search.example.invalid/v1${suffix}` } });
    await assert.rejects(fixture.search(), /API root/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.credentialRefs.length, 0);
  });
}

for (const protocol of ['openai-responses', 'xai-responses', 'copilot-responses']) {
  test(`strict ${protocol}: explicit refusal is failure even without a search call`, () => rejectsOnce(protocol,
    responses({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE_REASON' }] }] }), CODE.failed));
  test(`strict ${protocol}: client tool handoff is incomplete, never executed`, () => rejectsOnce(protocol,
    responses({ output: [{ type: 'function_call', name: 'web_search', arguments: '{}' }] }), CODE.incomplete));
}

test('strict Gemini: thought parts are not returned as the search answer', async () => {
  const fixture = harness({ protocol: 'google-generative-ai' }, gemini({ content: { parts: [
    { text: 'Internal thought', thought: true }, { text: 'Final answer' },
  ] } }));
  assert.equal((await fixture.search()).content, 'Final answer');
});

test('strict Gemini: completed web evidence survives source URL safety filtering', async () => {
  const fixture = harness({ protocol: 'google-generative-ai' }, gemini({ groundingMetadata: {
    groundingChunks: [{ web: { uri: 'http://127.0.0.1/private' } }],
  } }));
  assert.deepEqual((await fixture.search()).sources, []);
  assert.equal(fixture.requests.length, 1);
});

test('strict successful HTTP with no response body is invalid and never retries', async () => {
  const fixture = harness();
  let requests = 0;
  await assert.rejects(searchHosted(fixture.ctx, fixture.config, { query: QUERY }, undefined, async () => {
    requests += 1;
    return new Response(null, { status: 204 });
  }), codeIs(CODE.invalid));
  assert.equal(requests, 1);
});

test('strict oversized response is bounded and never retries', async () => {
  const fixture = harness({}, 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(fixture.search(), /exceeds 2 MiB/);
  assert.equal(fixture.requests.length, 1);
});

test('strict malformed JSON is invalid, is not echoed, and never retries', async () => {
  const fixture = harness({}, '{"private":"SENSITIVE_INVALID_JSON"');
  await assert.rejects(fixture.search(), (error) => {
    codeIs(CODE.invalid)(error);
    assert.doesNotMatch(error.message, /SENSITIVE_INVALID_JSON/);
    return true;
  });
  assert.equal(fixture.requests.length, 1);
});
