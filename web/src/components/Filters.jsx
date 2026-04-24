import { useEffect, useState } from 'react';

// Local buffer + debounce so typing doesn't fire a network request per
// keystroke. 200ms matches the original vanilla UI's feel.
function useDebouncedProp(value, ms, onDebounced) {
  const [buf, setBuf] = useState(value);
  // Sync buffer when external value changes (e.g. URL-driven initial load).
  useEffect(() => {
    setBuf(value);
  }, [value]);
  useEffect(() => {
    if (buf === value) return;
    const t = setTimeout(() => onDebounced(buf), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf]);
  return [buf, setBuf];
}

export default function Filters({ filters, onChange }) {
  const [companyBuf, setCompanyBuf] = useDebouncedProp(filters.search, 200, (v) =>
    onChange('search', v)
  );
  const [titleBuf, setTitleBuf] = useDebouncedProp(filters.title, 200, (v) =>
    onChange('title', v)
  );

  return (
    <section className="filters">
      <input
        type="search"
        placeholder="Company — e.g. Meta, Stripe"
        value={companyBuf}
        onChange={(e) => setCompanyBuf(e.target.value)}
        autoComplete="off"
        className="search"
      />
      <input
        type="search"
        placeholder="Role title — e.g. infrastructure, new grad"
        value={titleBuf}
        onChange={(e) => setTitleBuf(e.target.value)}
        autoComplete="off"
        className="search"
      />
      <select value={filters.role} onChange={(e) => onChange('role', e.target.value)}>
        <option value="">Any role type</option>
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
