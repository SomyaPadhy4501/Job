import { useEffect, useState } from 'react';

// Search box is locally buffered so typing doesn't fire a query per keystroke.
// 200ms debounce matches the old vanilla UI.
function useDebounce(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function Filters({ filters, onChange }) {
  const [searchBuffer, setSearchBuffer] = useState(filters.search);
  const debouncedSearch = useDebounce(searchBuffer, 200);

  useEffect(() => {
    if (debouncedSearch !== filters.search) onChange('search', debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  return (
    <section className="filters">
      <input
        type="search"
        placeholder="Search by title or company…"
        value={searchBuffer}
        onChange={(e) => setSearchBuffer(e.target.value)}
        autoComplete="off"
        className="search"
      />
      <select value={filters.role} onChange={(e) => onChange('role', e.target.value)}>
        <option value="">Any role</option>
        <option value="SWE">SWE / SDE</option>
        <option value="MLE">ML Engineer</option>
        <option value="AI">AI / Research</option>
        <option value="DS">Data Scientist</option>
        <option value="DATA_ENG">Data Engineer</option>
        <option value="SRE">DevOps / SRE</option>
        <option value="SECURITY">Security</option>
        <option value="MOBILE">Mobile</option>
      </select>
      <select
        value={filters.sponsorship}
        onChange={(e) => onChange('sponsorship', e.target.value)}
      >
        <option value="">Any sponsorship</option>
        <option value="YES">Sponsorship: YES</option>
        <option value="NO">Sponsorship: NO</option>
        <option value="UNKNOWN">Sponsorship: UNKNOWN</option>
      </select>
      <select value={filters.level} onChange={(e) => onChange('level', e.target.value)}>
        <option value="">Any level (entry + mid)</option>
        <option value="entry">Entry-level only</option>
        <option value="mid">Mid-level (1-2 YOE)</option>
        <option value="early">Entry or mid</option>
      </select>
    </section>
  );
}
