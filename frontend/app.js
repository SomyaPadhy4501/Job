(function () {
  'use strict';

  const state = {
    page: 1,
    limit: 50,
    search: '',
    sponsorship: '',
    role: '',
    entryOnly: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const body = $('#jobs-body');
  const stats = $('#stats');
  const pager = $('#pager');
  const pageInfo = $('#page-info');
  const prevBtn = $('#prev');
  const nextBtn = $('#next');
  const searchInput = $('#search');
  const sponsorshipSelect = $('#sponsorship');
  const roleSelect = $('#role');
  const entryCheckbox = $('#entry');
  const refreshBtn = $('#refresh');

  const ROLE_LABEL = {
    SWE: 'SWE',
    MLE: 'MLE',
    AI: 'AI',
    DS: 'DS',
    DATA_ENG: 'Data Eng',
    SRE: 'DevOps/SRE',
    SECURITY: 'Security',
    MOBILE: 'Mobile',
    OTHER: 'Other',
  };

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderRows(rows) {
    if (!rows.length) {
      body.innerHTML = `<tr><td class="empty" colspan="7">No jobs match.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map((j) => {
        const sponsor = j.sponsorship || 'UNKNOWN';
        const role = ROLE_LABEL[j.role_type] || j.role_type || '—';
        const entryBadge = j.is_entry_level
          ? `<span class="pill pill-entry">entry</span>`
          : '';
        return `
          <tr>
            <td>${escapeHtml(j.company_name)}<div class="muted">${escapeHtml(j.source)}</div></td>
            <td class="role">${escapeHtml(j.job_title)}${entryBadge}</td>
            <td><span class="pill">${escapeHtml(role)}</span></td>
            <td>${escapeHtml(j.location || '—')}</td>
            <td><span class="badge badge-${sponsor}">${sponsor}</span></td>
            <td>${escapeHtml(fmtDate(j.date_posted))}</td>
            <td><a class="apply-btn" href="${escapeHtml(j.apply_url)}" target="_blank" rel="noopener noreferrer">Apply</a></td>
          </tr>
        `;
      })
      .join('');
  }

  async function load() {
    body.innerHTML = `<tr><td class="empty" colspan="7">Loading…</td></tr>`;
    const params = new URLSearchParams();
    params.set('page', state.page);
    params.set('limit', state.limit);
    if (state.search) params.set('search', state.search);
    if (state.sponsorship) params.set('sponsorship', state.sponsorship);
    if (state.role) params.set('role', state.role);
    if (state.entryOnly) params.set('entry', 'true');

    try {
      const res = await fetch(`/jobs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      renderRows(payload.data);
      const p = payload.pagination;
      stats.textContent = `${p.total.toLocaleString()} jobs`;
      if (p.totalPages > 1) {
        pager.hidden = false;
        pageInfo.textContent = `Page ${p.page} of ${p.totalPages}`;
        prevBtn.disabled = p.page <= 1;
        nextBtn.disabled = p.page >= p.totalPages;
      } else {
        pager.hidden = true;
      }
    } catch (err) {
      body.innerHTML = `<tr><td class="empty" colspan="7">Error loading jobs: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.search = searchInput.value.trim();
      state.page = 1;
      load();
    }, 200)
  );

  sponsorshipSelect.addEventListener('change', () => {
    state.sponsorship = sponsorshipSelect.value;
    state.page = 1;
    load();
  });

  roleSelect.addEventListener('change', () => {
    state.role = roleSelect.value;
    state.page = 1;
    load();
  });

  entryCheckbox.addEventListener('change', () => {
    state.entryOnly = entryCheckbox.checked;
    state.page = 1;
    load();
  });

  prevBtn.addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  nextBtn.addEventListener('click', () => {
    state.page += 1;
    load();
  });
  refreshBtn.addEventListener('click', load);

  load();
})();
