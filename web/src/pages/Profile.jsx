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
const WORK_MODE = [
  ['', 'Not set'],
  ['onsite', 'On-site'],
  ['hybrid', 'Hybrid'],
  ['remote', 'Remote'],
  ['any', 'Any'],
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.profile);

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
          What application forms ask for. Upload a <Link to="/resumes">resume</Link> to fill most of it; anything you type
          here wins over what a resume says. The extension fills only fields you've set, and never submits a form.
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

      <Section title="Address">
        {text('address.line1', 'Address line 1', { autoComplete: 'address-line1', wide: true })}
        {text('address.line2', 'Address line 2', { autoComplete: 'address-line2', wide: true })}
        {text('address.city', 'City', { autoComplete: 'address-level2' })}
        {text('address.state', 'State', { autoComplete: 'address-level1' })}
        {text('address.postalCode', 'ZIP / postal code', { autoComplete: 'postal-code' })}
        {text('address.country', 'Country', { autoComplete: 'country-name', placeholder: 'United States' })}
      </Section>

      <Section title="Links">
        {text('links.linkedin', 'LinkedIn', { placeholder: 'https://www.linkedin.com/in/…' })}
        {text('links.github', 'GitHub', { placeholder: 'https://github.com/…' })}
        {text('links.portfolio', 'Portfolio')}
        {text('links.website', 'Other website')}
      </Section>

      <Section title="Work authorization (US)" note="Answered exactly as you set them here; anything left “Not set” is left for you on each form.">
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
        <TextField label="Earliest start date" type="date" value={draft.preferences.earliestStart} onChange={(v) => set('preferences.earliestStart', v)} />
        <SelectField label="Work mode" value={draft.preferences.workMode ?? ''} options={WORK_MODE} onChange={(v) => set('preferences.workMode', v || null)} />
        {text('preferences.salaryExpectation', 'Salary expectation')}
      </Section>

      <Rows
        title="Education"
        rows={draft.education}
        empty={EMPTY_EDU}
        max={10}
        onChange={(rows) => set('education', rows)}
        render={(row, update) => (
          <>
            <TextField label="School" value={row.school} onChange={(v) => update('school', v)} wide />
            <TextField label="Degree" value={row.degree} onChange={(v) => update('degree', v)} placeholder="Master of Science" />
            <TextField label="Field of study" value={row.field} onChange={(v) => update('field', v)} />
            <TextField label="GPA" value={row.gpa} onChange={(v) => update('gpa', v)} placeholder="3.8/4.0" />
            <TextField label="Start (YYYY-MM, day optional)" value={row.startDate} onChange={(v) => update('startDate', v)} />
            <TextField label="End or expected (YYYY-MM, day optional)" value={row.endDate} onChange={(v) => update('endDate', v)} />
          </>
        )}
      />

      <Rows
        title="Experience"
        rows={draft.experience}
        empty={EMPTY_JOB}
        max={20}
        onChange={(rows) => set('experience', rows)}
        render={(row, update) => (
          <>
            <TextField label="Company" value={row.company} onChange={(v) => update('company', v)} />
            <TextField label="Title" value={row.title} onChange={(v) => update('title', v)} />
            <TextField label="Location" value={row.location} onChange={(v) => update('location', v)} />
            <TextField label="Start (YYYY-MM, day optional)" value={row.startDate} onChange={(v) => update('startDate', v)} />
            <TextField label="End (YYYY-MM, day optional)" value={row.endDate} onChange={(v) => update('endDate', v)} disabled={row.current === true} />
            <label className="field check">
              <input type="checkbox" checked={row.current === true} onChange={(e) => update('current', e.target.checked)} />
              <span>I work here now</span>
            </label>
            <label className="field field-wide">
              <span>Description</span>
              <textarea rows={3} maxLength={2000} value={row.description} onChange={(e) => update('description', e.target.value)} />
            </label>
          </>
        )}
      />

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

      <Section title="Voluntary self-identification (optional)" note="Used only for the optional EEO questions US forms ask. Leave any of these unset and the extension leaves that question for you.">
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

      <Section title="Job board" note="How the job list opens for you. You can still change the filters on the board any time.">
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
    <fieldset className="card section">
      <legend>{title}</legend>
      {note && <p className="muted small">{note}</p>}
      <div className="form-grid">{children}</div>
    </fieldset>
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

function YesNo({ label, value, onChange }) {
  const v = value === true ? 'yes' : value === false ? 'no' : '';
  return (
    <label className="field field-wide">
      <span>{label}</span>
      <select value={v} onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
        <option value="">Not set (leave for me)</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

function Rows({ title, rows, empty, max, onChange, render }) {
  return (
    <fieldset className="card section">
      <legend>{title}</legend>
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
    </fieldset>
  );
}
