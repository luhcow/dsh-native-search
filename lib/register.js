import { SEARCH_PROVIDER_ID, configValue, searchHosted } from './search.js';

export function apply(ctx, config) {
  ctx.web.registerSearchProvider({
    id: SEARCH_PROVIDER_ID,
    available: () => Boolean(String(configValue(config.provider) ?? '').trim()
      && String(configValue(config.model) ?? '').trim()),
    search: (request, signal) => searchHosted(ctx, config, request, signal),
  });
}
