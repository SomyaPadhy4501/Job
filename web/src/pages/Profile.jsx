import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import { Link } from '../router.jsx';

// The autofill profile. Unknown answers stay unknown: a yes/no left as
// "Not set" is never filled by the extension, and the EEO questions are
// optional. Each save sends the version it started from; if the extension or
// another tab saved in between, the server refuses (409) instead of
// overwriting.

const KEY = ['profile'];

const VISA = [
  ['', 'Not set'],
  ['citizen', 'US citizen'],
  ['permanent_resident', 'Permanent resident (green card)'],
  ['f1_opt', 'F-1 OPT'],
  ['f1_stem_opt', 'F-1 STEM OPT'],
  ['f1_cpt', 'F-1 CPT'],
  ['h1b', 'H-1B'],
  ['other', 'Other'],
];
// EEO values are the option wording most forms use; "decline" maps to the
// form's own "decline to answer" option.
const EEO = {
  gender: ['Female', 'Male', 'Non-binary'],
  hispanicLatino: ['Yes', 'No'],
  race: [
    'American Indian or Alaska Native',
    'Asian',
    'Black or African American',
    'Native Hawaiian or Other Pacific Islander',
    'White',
    'Two or More Races',
  ],
  veteran: ['I am not a protected veteran', 'I am a protected veteran'],
  disability: ['Yes', 'No'],
};
const EEO_LABELS = {
  gender: 'Gender',
  hispanicLatino: 'Hispanic or Latino',
  race: 'Race',
  veteran: 'Veteran status',
  disability: 'Disability',
};

export const BOARD_EMPTY = { role: '', level: '', sponsorship: '', restriction: '', view: '' };
export const BOARD_OPTIONS = {
  role: [['', 'Any role type'], ['SWE', 'SWE / SDE'], ['MLE', 'ML Engineer'], ['AI', 'AI / Research'], ['DS', 'Data Scientist'], ['DATA_ENG', 'Data Engineer'], ['SRE', 'DevOps / SRE'], ['SECURITY', 'Security'], ['MOBILE', 'Mobile']],
  level: [['', 'Any level (entry + mid)'], ['entry', 'Entry-level only'], ['mid', 'Mid-level (1-2 YOE)'], ['early', 'Entry or mid']],
  sponsorship: [['', 'Sponsors visas (confirmed)'], ['ANY', 'Any sponsorship'], ['NO', 'Sponsorship: NO'], ['UNKNOWN', 'Sponsorship: UNKNOWN']],
  restriction: [['', 'Hide no-sponsorship / ITAR / clearance'], ['all', 'Show all roles'], ['only', 'Only restricted roles']],
  view: [['', 'Group by company'], ['list', 'Flat list']],
};
export const BOARD_LABELS = { role: 'Role type', level: 'Level', sponsorship: 'Sponsorship', restriction: 'Clearance / citizenship roles', view: 'Layout' };

const EMPTY_EDU = { school: '', degree: '', field: '', gpa: '', startDate: '', endDate: '' };
const EMPTY_JOB = { company: '', title: '', location: '', startDate: '', endDate: '', current: null, description: '' };

export default function Profile() {
  return (
    <RequireAuth reason="Sign in to keep the details forms ask for, so the extension can fill them in.">
      <ProfilePage />
    </RequireAuth>
  );
}

function ProfilePage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = usePrivateQuery(KEY, '/api/me/profile');
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft({ ...structuredClone(data.profile), board: { ...BOARD_EMPTY, ...data.profile.board } });
  }, [data]);

  const save = useMutation({
    mutationFn: () => api('/api/me/profile', { method: 'PUT', body: { profile: draft, version: data.version } }),
    onSuccess: (d) => {
      qc.setQueryData(KEY, d);
      setSaved(true);
    },
  });

  if (isLoading || !draft) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;

  const set = (path, value) => {
    setSaved(false);
    setDraft((d) => {
      const next = structuredClone(d);
      const keys = path.split('.');
      let node = next;
      for (const k of keys.slice(0, -1)) node = node[k];
      node[keys.at(-1)] = value;
      return next;
    });
  };
  const fromResume = (path) => data.sources?.[path]?.startsWith('resume:');
  const text = (path, label, props = {}) => (
    <TextField label={label} value={get(draft, path) ?? ''} onChange={(v) => set(path, v)} hint={fromResume(path) ? 'from resume' : ''} {...props} />
  );
  // Compare with the board defaults the draft adds, so profiles saved before
  // `board` existed don't look edited.
  const stored = { ...data.profile, board: { ...BOARD_EMPTY, ...data.profile.board } };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  return (
    <form
      className="profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="page-head">
        <h2>Profile</h2>
        <p className="muted">
          What job forms ask for. Most of it comes from your <Link to="/resumes">resume</Link>; anything you type here wins.
        </p>
      </div>

      <Section title="Name">
        {text('identity.firstName', 'Legal first name', { autoComplete: 'given-name' })}
        {text('identity.middleName', 'Middle name', { autoComplete: 'additional-name' })}
        {text('identity.lastName', 'Legal last name', { autoComplete: 'family-name' })}
        {text('identity.preferredName', 'Preferred name')}
        {text('identity.pronouns', 'Pronouns')}
      </Section>

      <Section title="Contact">
        {text('contact.email', 'Email', { type: 'email', autoComplete: 'email' })}
        {text('contact.phoneCountryCode', 'Country code', { placeholder: '+1' })}
        {text('contact.phone', 'Phone', { type: 'tel', autoComplete: 'tel-national' })}
      </Section>

      <Section title="Address" note="Search once and every form gets the part it needs.">
        <AddressSearch
          address={draft.address}
          onPick={(parts) => {
            for (const [k, v] of Object.entries(parts)) if (k !== 'label') set(`address.${k}`, v);
          }}
        />
        <details className="field-wide address-details">
          <summary>Edit the parts</summary>
          <div className="form-grid">
            {text('address.line1', 'Address line 1', { autoComplete: 'address-line1', wide: true })}
            {text('address.line2', 'Apartment, suite (optional)', { autoComplete: 'address-line2', wide: true })}
            {text('address.city', 'City', { autoComplete: 'address-level2' })}
            {text('address.state', 'State', { autoComplete: 'address-level1' })}
            {text('address.postalCode', 'ZIP / postal code', { autoComplete: 'postal-code' })}
            {text('address.country', 'Country', { autoComplete: 'country-name', placeholder: 'United States' })}
          </div>
        </details>
      </Section>

      <Section title="Links">
        {text('links.linkedin', 'LinkedIn', { placeholder: 'https://www.linkedin.com/in/…' })}
        {text('links.github', 'GitHub', { placeholder: 'https://github.com/…' })}
        {text('links.portfolio', 'Portfolio')}
        {text('links.website', 'Other website')}
      </Section>

      <Section title="Work authorization (US)" note="Anything left unset is left for you on each form.">
        <YesNo label="Are you legally authorized to work in the United States?" value={draft.workAuth.authorizedUS} onChange={(v) => set('workAuth.authorizedUS', v)} />
        <YesNo
          label="Will you need visa sponsorship to start work (now)?"
          value={draft.workAuth.requiresSponsorshipNow}
          onChange={(v) => set('workAuth.requiresSponsorshipNow', v)}
        />
        <YesNo
          label="Will you need visa sponsorship in the future (e.g. H-1B after OPT)?"
          value={draft.workAuth.requiresSponsorshipFuture}
          onChange={(v) => set('workAuth.requiresSponsorshipFuture', v)}
        />
        <SelectField label="Current status" value={draft.workAuth.visaStatus ?? ''} options={VISA} onChange={(v) => set('workAuth.visaStatus', v || null)} />
        {text('workAuth.optEndDate', 'OPT end (YYYY-MM)', { placeholder: '2027-06' })}
      </Section>

      <Section title="Preferences">
        <YesNo label="Willing to relocate?" value={draft.preferences.relocate} onChange={(v) => set('preferences.relocate', v)} />
        <YesNo
          label="Open to working on-site or hybrid (in an office some days)?"
          value={draft.preferences.workMode == null ? null : draft.preferences.workMode !== 'remote'}
          onChange={(v) =>
            set(
              'preferences.workMode',
              // Yes keeps an earlier on-site/hybrid choice; No means remote only.
              v === null ? null : v ? (['onsite', 'hybrid'].includes(draft.preferences.workMode) ? draft.preferences.workMode : 'any') : 'remote'
            )
          }
        />
        <TextField label="Earliest start date" type="date" value={draft.preferences.earliestStart} onChange={(v) => set('preferences.earliestStart', v)} />
        {text('preferences.salaryExpectation', 'Salary expectation (optional)')}
      </Section>

      <ResumeHistory />

      <Section title="Skills">
        <label className="field field-wide">
          <span>Comma-separated</span>
          <textarea
            rows={2}
            value={draft.skills.join(', ')}
            onChange={(e) => set('skills', e.target.value.split(',').map((s) => s.trimStart()))}
            onBlur={(e) => set('skills', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
          />
        </label>
      </Section>

      <Section title="Voluntary self-identification (optional)" note="Optional. Only used for the voluntary questions US forms ask.">
        {Object.keys(EEO).map((k) => (
          <SelectField
            key={k}
            label={EEO_LABELS[k]}
            value={draft.eeo[k] ?? ''}
            options={[['', 'Not set (leave for me)'], ['decline', 'Decline to answer'], ...EEO[k].map((o) => [o, o])]}
            onChange={(v) => set(`eeo.${k}`, v || null)}
          />
        ))}
      </Section>

      <Section title="Job board" note="How the job list opens for you.">
        {Object.keys(BOARD_OPTIONS).map((k) => (
          <SelectField key={k} label={BOARD_LABELS[k]} value={draft.board[k]} options={BOARD_OPTIONS[k]} onChange={(v) => set(`board.${k}`, v)} />
        ))}
      </Section>

      <Section title="Other">
        <YesNo label="Are you 18 or older?" value={draft.misc.over18} onChange={(v) => set('misc.over18', v)} />
        {text('misc.howDidYouHear', 'How did you hear about us? (default answer)')}
      </Section>

      <div className="save-bar">
        {save.error && (
          <span className="error">
            {save.error.message}{' '}
            {save.error.status === 409 && (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => { save.reset(); refetch(); }}>
                Reload
              </button>
            )}
          </span>
        )}
        {saved && !dirty && <span className="success">Saved.</span>}
        <button className="btn" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  );
}

function get(obj, path) {
  return path.split('.').reduce((v, k) => v?.[k], obj);
}

function Section({ title, note, children }) {
  return (
    <section className="card section">
      <header className="section-head">
        <h3>{title}</h3>
        {note && <p className="muted small">{note}</p>}
      </header>
      <div className="form-grid">{children}</div>
    </section>
  );
}

function TextField({ label, value, onChange, hint, wide, ...props }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span>
        {label} {hint && <em className="hint">{hint}</em>}
      </span>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...props} />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

// Yes | No buttons, like the forms themselves. Clicking the chosen one again
// clears it: unset questions are left for you on each form.
function YesNo({ label, value, onChange }) {
  return (
    <div className="field field-wide yesno" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="segmented">
        {[
          [true, 'Yes'],
          [false, 'No'],
        ].map(([v, l]) => (
          <button
            key={l}
            type="button"
            aria-pressed={value === v}
            className={value === v ? 'is-on' : ''}
            onClick={() => onChange(value === v ? null : v)}
          >
            {l}
          </button>
        ))}
        {value == null && <em className="muted small">Not set, left for you on each form</em>}
      </div>
    </div>
  );
}

// One search box for the whole address. Suggestions come from Photon
// (OpenStreetMap data, free, no key or account); only what you type is sent.
function AddressSearch({ address, onPick }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 3) {
      setItems([]);
      return undefined;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const url = 'https://photon.komoot.io/api/?limit=6&lang=en&q=' + encodeURIComponent(query);
        const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        const data = await res.json();
        const seen = new Set();
        setItems(
          (data.features || [])
            .map((f) => placeParts(f.properties || {}))
            .filter((p) => (p.city || p.state) && !seen.has(p.label) && seen.add(p.label))
        );
        setFailed(false);
        setOpen(true);
      } catch (e) {
        if (e.name !== 'AbortError') setFailed(true);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);
  const current = [address.line1, address.city, address.state, address.postalCode, address.country].filter(Boolean).join(', ');
  return (
    <div className="field field-wide address-search">
      <span>Search your address or city</span>
      <input
        value={q}
        placeholder={current ? 'Search to change it' : 'e.g. 75 Saint Alphonsus St, Boston'}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => items.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls="address-suggestions"
      />
      {open && items.length > 0 && (
        <ul className="suggestions" id="address-suggestions" role="listbox">
          {items.map((p, i) => (
            <li key={i} role="option" aria-selected="false">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(p);
                  setQ('');
                  setOpen(false);
                }}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <p className="small address-current">
          Saved: <strong>{current}</strong>
        </p>
      ) : (
        <p className="small muted">Not set yet: forms that ask where you live are left for you.</p>
      )}
      {failed && <p className="small warn">Address search isn't reachable right now. Use “Edit the parts”.</p>}
    </div>
  );
}

const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
  'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// Photon feature properties -> the profile's address parts.
function placeParts(p) {
  const us = p.countrycode === 'US';
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const city = p.city || p.town || p.village || (['city', 'town', 'village'].includes(p.osm_value) ? p.name : '') || p.district || '';
  const line1 = street || (p.type === 'house' && p.name !== city ? p.name : '');
  const state = us ? US_STATES[p.state] || p.state || '' : p.state || '';
  const country = us ? 'United States' : p.country || '';
  const place = p.name && p.name !== city && p.name !== line1 && !street ? p.name : '';
  return {
    line1,
    line2: '',
    city,
    state,
    postalCode: p.postcode || '',
    country,
    label: [place, line1, city, state, p.postcode, country].filter(Boolean).join(', '),
  };
}

function Rows({ title, rows, empty, max, onChange, render }) {
  return (
    <div className="rows">
      <h4>{title}</h4>
      {rows.length === 0 && <p className="muted small">None on this resume.</p>}
      {rows.map((row, i) => (
        <div key={i} className="row-block">
          <div className="form-grid">
            {render(row, (k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r))))}
          </div>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {rows.length < max && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => onChange([...rows, { ...empty }])}>
          + Add {title.toLowerCase()}
        </button>
      )}
    </div>
  );
}

// Education and experience belong to each resume: one resume can list
// different jobs or different points than another. The extension fills a
// form with the history of the resume it attaches. Saved per resume, apart
// from the rest of the profile.
function ResumeHistory() {
  const list = usePrivateQuery(['resumes'], '/api/me/resumes');
  const resumes = list.data?.resumes || [];
  const [picked, setPicked] = useState(null);
  const id = picked && resumes.some((r) => r.id === picked) ? picked : (resumes.find((r) => r.isDefault) || resumes[0])?.id;
  return (
    <section className="card section">
      <header className="section-head">
        <h3>Education &amp; experience</h3>
        <p className="muted small">
          Read from each resume. Forms get the history of the resume you attach. Fix anything that was read wrong.
        </p>
      </header>
      <div className="section-body">
        {list.isLoading && <div className="skeleton skeleton-row" />}
        {list.error && <p className="error">{list.error.message}</p>}
        {!list.isLoading && !resumes.length && (
          <p className="muted">
            <Link to="/resumes">Upload a resume</Link> and its education and experience appear here.
          </p>
        )}
        {resumes.length > 0 && (
          <>
            <div className="tabs" role="tablist" aria-label="Resumes">
              {resumes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={r.id === id}
                  className={r.id === id ? 'is-on' : ''}
                  onClick={() => setPicked(r.id)}
                >
                  {r.title}
                  {r.isDefault && <span className="hint">default</span>}
                </button>
              ))}
            </div>
            {id && <HistoryEditor key={id} id={id} />}
          </>
        )}
      </div>
    </section>
  );
}

function HistoryEditor({ id }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = usePrivateQuery(['resume', id], `/api/me/resumes/${id}`);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (data) setDraft({ education: data.parsed?.education || [], experience: data.parsed?.experience || [] });
  }, [data]);
  const save = useMutation({
    mutationFn: () => api(`/api/me/resumes/${id}/history`, { method: 'PUT', body: draft }),
    onSuccess: (d) => qc.setQueryData(['resume', id], (old) => ({ ...old, ...d })),
  });
  if (isLoading || !draft) return <div className="skeleton skeleton-row" />;
  if (error) return <p className="error">{error.message}</p>;
  const original = { education: data.parsed?.education || [], experience: data.parsed?.experience || [] };
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const setList = (k) => (rows) => {
    save.reset();
    setDraft((d) => ({ ...d, [k]: rows }));
  };
  return (
    <div className="history">
      {!data.parsed && <p className="notice small">This resume couldn't be read automatically. Add its history below.</p>}
      <Rows
        title="Education"
        rows={draft.education}
        empty={EMPTY_EDU}
        max={10}
        onChange={setList('education')}
        render={(row, update) => (
          <>
            <TextField label="School" value={row.school} onChange={(v) => update('school', v)} wide />
            <TextField label="Degree" value={row.degree} onChange={(v) => update('degree', v)} placeholder="Master of Science" />
            <TextField label="Field of study" value={row.field} onChange={(v) => update('field', v)} />
            <TextField label="GPA" value={row.gpa} onChange={(v) => update('gpa', v)} placeholder="3.8/4.0" />
            <TextField label="Start (YYYY-MM)" value={row.startDate} onChange={(v) => update('startDate', v)} placeholder="2024-09" />
            <TextField label="End or expected (YYYY-MM)" value={row.endDate} onChange={(v) => update('endDate', v)} placeholder="2026-05" />
          </>
        )}
      />
      <Rows
        title="Experience"
        rows={draft.experience}
        empty={EMPTY_JOB}
        max={20}
        onChange={setList('experience')}
        render={(row, update) => (
          <>
            <TextField label="Company" value={row.company} onChange={(v) => update('company', v)} />
            <TextField label="Title" value={row.title} onChange={(v) => update('title', v)} />
            <TextField label="Location" value={row.location} onChange={(v) => update('location', v)} />
            <TextField label="Start (YYYY-MM)" value={row.startDate} onChange={(v) => update('startDate', v)} placeholder="2025-06" />
            <TextField label="End (YYYY-MM)" value={row.endDate} onChange={(v) => update('endDate', v)} disabled={row.current === true} />
            <label className="field check">
              <input type="checkbox" checked={row.current === true} onChange={(e) => update('current', e.target.checked)} />
              <span>I work here now</span>
            </label>
            <label className="field field-wide">
              <span>Points (as on this resume)</span>
              <textarea rows={4} maxLength={2000} value={row.description} onChange={(e) => update('description', e.target.value)} />
            </label>
          </>
        )}
      />
      <div className="history-actions">
        {save.error && <span className="error">{save.error.message}</span>}
        {save.isSuccess && !dirty && <span className="success">Saved for this resume.</span>}
        <button type="button" className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save for this resume'}
        </button>
      </div>
    </div>
  );
}
