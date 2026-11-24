import { useState } from 'react';

// Tag chips: Enter or comma adds, × removes, suggestions add on click.
// Mirrors the server's rules (trimmed, ≤32 chars, ≤10 tags, case-insensitive
// duplicates dropped); the server checks again.

const MAX_TAGS = 10;
const MAX_CHARS = 32;

function clean(t) {
  return t.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

export default function TagInput({ value, onChange, suggestions = [], id }) {
  const [draft, setDraft] = useState('');
  const has = (t) => value.some((v) => v.toLowerCase() === t.toLowerCase());

  function add(raw) {
    const next = [...value];
    for (const part of raw.split(',')) {
      const t = clean(part);
      if (t && !next.some((v) => v.toLowerCase() === t.toLowerCase()) && next.length < MAX_TAGS) next.push(t);
    }
    onChange(next);
    setDraft('');
  }

  return (
    <div className="tag-input">
      <div className="tag-list">
        {value.map((t) => (
          <span key={t} className="pill tag">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((v) => v !== t))}>
              ×
            </button>
          </span>
        ))}
        {value.length < MAX_TAGS && (
          <input
            id={id}
            value={draft}
            placeholder={value.length ? 'Add a tag' : 'Tags, e.g. SWE, AI Engineer'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
                e.preventDefault();
                add(draft);
              } else if (e.key === 'Backspace' && !draft && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => draft.trim() && add(draft)}
          />
        )}
      </div>
      {suggestions.length > 0 && value.length < MAX_TAGS && (
        <div className="tag-suggestions">
          {suggestions.filter((s) => !has(s)).map((s) => (
            <button type="button" key={s} className="pill pill-suggest" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
