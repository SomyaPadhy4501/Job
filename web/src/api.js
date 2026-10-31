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

// Shared query-string builder for /jobs and /companies. 'ANY' is the UI's
// explicit "no sponsorship filter" value (see useUrlFilters) and is omitted.
function filterParams({
  page = 1,
  limit = 50,
  search = '',
  title = '',
  sponsorship = '',
  company = '',
  role = '',
  level = '',
  restriction = 'hide',
} = {}) {
  const params = new URLSearchParams();
  params.set('page', page);
  params.set('limit', limit);
  if (search) params.set('search', search);
  if (title) params.set('title', title);
  if (sponsorship && sponsorship !== 'ANY') params.set('sponsorship', sponsorship);
  if (company) params.set('company', company);
  if (role) params.set('role', role);
  if (level) params.set('level', level);
  if (restriction) params.set('restriction', restriction);
  return params.toString();
}

export async function fetchJobs(filters = {}) {
  const payload = await httpJson(`/jobs?${filterParams(filters)}`);
  if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
    throw new Error('Malformed /jobs response');
  }
  return payload;
}

// One row per company: { company_name, roles, latest_posted, latest_seen,
// sponsors, job? } — `job` is present when roles === 1.
export async function fetchCompanies(filters = {}) {
  const payload = await httpJson(`/companies?${filterParams(filters)}`);
  if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
    throw new Error('Malformed /companies response');
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
