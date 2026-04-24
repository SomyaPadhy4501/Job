'use strict';

const { fetchJson } = require('./http');

// Goldman Sachs publishes all open roles on higher.gs.com, backed by a public
// GraphQL gateway at api-higher.gs.com/gateway/api/v1/graphql. The API is
// anonymous (no auth, no cookies) and exposes a `GetRoles` query that returns
// ~1,500 global roles. The server-side location filter schema is obscure, so
// we pull all rows and filter client-side on `locations[].country` — faster
// to implement and just as cheap (75 × 20-row pages).
//
// Response items look like:
//   {
//     roleId: "170008_GS_MID_CAREER",
//     corporateTitle, jobTitle, jobFunction,
//     locations: [{ primary, state, country, city }],
//     division, status, externalSource: { sourceId }
//   }

const ENDPOINT = 'https://api-higher.gs.com/gateway/api/v1/graphql';
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // 2000-row cap

const GET_ROLES_QUERY = `query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    totalCount
    items {
      roleId
      jobTitle
      jobFunction
      locations { primary state country city }
      status
      division
      externalSource { sourceId }
    }
  }
}`;

async function fetchPage(pageNumber) {
  const data = await fetchJson(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      operationName: 'GetRoles',
      query: GET_ROLES_QUERY,
      variables: {
        searchQueryInput: {
          page: { pageSize: PAGE_SIZE, pageNumber },
          sort: { sortStrategy: 'RELEVANCE', sortOrder: 'DESC' },
          filters: [],
          experiences: ['EARLY_CAREER', 'PROFESSIONAL'],
          searchTerm: '',
        },
      },
    },
    retries: 1,
  });
  return data?.data?.roleSearch?.items || [];
}

function locationOf(item) {
  const primary = (item.locations || []).find((l) => l.primary) || item.locations?.[0];
  if (!primary) return '';
  return [primary.city, primary.state, primary.country].filter(Boolean).join(', ');
}

function isUS(item) {
  return (item.locations || []).some((l) => /united states/i.test(l?.country || ''));
}

async function fetchCompany({ displayName }) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let items;
    try {
      items = await fetchPage(page);
    } catch {
      break;
    }
    if (!items.length) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }

  return all.filter(isUS).map((it) => {
    const sourceId = it.externalSource?.sourceId || it.roleId;
    return {
      source: 'goldman_sachs',
      external_id: String(sourceId),
      company_name: displayName || 'Goldman Sachs',
      job_title: it.jobTitle || '',
      location: locationOf(it),
      apply_url: `https://higher.gs.com/roles/${sourceId}`,
      description: '',
      date_posted: null, // API doesn't expose a posting date
    };
  });
}

module.exports = { fetchCompany, source: 'goldman_sachs' };
