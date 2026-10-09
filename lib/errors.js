// Stable plugin-owned error codes; never include provider response bodies or secrets.
export class HostedSearchError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'HostedSearchError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
  }
}

export function searchError(kind, message, details) {
  return new HostedSearchError(`HOSTED_SEARCH_${kind}`, message, details);
}
