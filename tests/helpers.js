// Mock fetch for feed tests: map of url -> handler returning {status, body, headers}.
export function mockFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    calls.push(url);
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const h = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))?.[1];
    if (!h) return new Response('not found', { status: 404 });
    const r = typeof h === 'function' ? await h(url, opts) : h;
    if (r instanceof Error) throw r;
    return new Response(r.body, { status: r.status || 200, headers: r.headers || {} });
  };
}
export const csv = (header, rows) => [header.join(','), ...rows.map(r => r.map(v => (String(v).includes(',') || String(v).includes('"') || String(v).includes('\n') ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';
