// Thin API client. Every call returns a JSON body or throws — we let
// TanStack Query handle retries, caching, and error state upstream.

async function httpJson(url, init) {
  const res = await fetch(url, { ...init, cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

export async function fetchJobs({ page = 1, limit = 50, search = '', sponsorship = '', role = '', level = '' } = {}) {
  const params = new URLSearchParams();
  params.set('page', page);
  params.set('limit', limit);
  if (search) params.set('search', search);
  if (sponsorship) params.set('sponsorship', sponsorship);
  if (role) params.set('role', role);
  if (level) params.set('level', level);
  const payload = await httpJson(`/jobs?${params.toString()}`);
  if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
    throw new Error('Malformed /jobs response');
  }
  return payload;
}

export async function fetchStats() {
  return httpJson('/stats');
}

// Tiny payload — just asking the server what the current filtered total is
// so we can detect "N new jobs since last render" without re-fetching rows.
export async function fetchJobCount(filters = {}) {
  const p = await fetchJobs({ ...filters, page: 1, limit: 1 });
  return p.pagination.total;
}
