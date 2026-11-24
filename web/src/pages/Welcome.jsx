import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, useAccount, usePrivateQuery } from '../account.js';
import { Link, navigate } from '../router.jsx';
import { ResumesBody } from './Resumes.jsx';
import { BOARD_EMPTY, BOARD_LABELS, BOARD_OPTIONS } from './Profile.jsx';

// First-time setup, shown after a new account's first sign-in (and any time
// from Profile). Every step can be skipped; everything is editable later.

const STEPS = ['Your resume', 'About you', 'Your job board', 'Autofill'];

const YES_NO = [
  ['', 'Not set (leave for me)'],
  ['yes', 'Yes'],
  ['no', 'No'],
];
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

const toYesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const fromYesNo = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

export default function Welcome() {
  const { data: me } = useAccount();
  const [step, setStep] = useState(0);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const firstName = (me?.user?.name || '').split(' ')[0];

  return (
    <div className="welcome-flow">
      <div className="page-head">
        <h2>Welcome{firstName ? `, ${firstName}` : ''}! Let's set things up</h2>
        <p className="muted">About two minutes. Skip anything; it's all editable later from Profile.</p>
      </div>
      <ol className="stepper" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : ''}>
            <button type="button" onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}>
              <span className="step-num">{i < step ? '✓' : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <p className="muted">
            Upload your resumes and name each one (e.g. ML Engineer). Your profile fills in from them.
          </p>
          <ResumesBody />
          <StepNav onNext={next} nextLabel="Continue" />
        </>
      )}
      {step === 1 && <AboutYou onBack={back} onNext={next} />}
      {step === 2 && <BoardPrefs onBack={back} onNext={next} />}
      {step === 3 && (
        <div className="card section">
          <h3>Fill applications in one click</h3>
          <p>
            The extension fills job forms with your profile and the right resume. You still review and submit.
          </p>
          <div className="row-actions">
            <Link to="/autofill" className="btn">Set up the extension</Link>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
              Go to the jobs
            </button>
          </div>
          <StepNav onBack={back} />
        </div>
      )}
    </div>
  );
}

function StepNav({ onBack, onNext, nextLabel = 'Save and continue', busy, skip }) {
  return (
    <div className="step-nav">
      {onBack ? (
        <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
      ) : (
        <span />
      )}
      <span className="row-actions">
        {skip && (
          <button type="button" className="btn btn-ghost" onClick={skip}>Skip</button>
        )}
        {onNext && (
          <button type="button" className="btn" disabled={busy} onClick={onNext}>
            {busy ? 'Saving…' : nextLabel}
          </button>
        )}
      </span>
    </div>
  );
}

// Loads the profile into a local draft and saves it with its version.
function useProfileDraft() {
  const qc = useQueryClient();
  const { data, isLoading, error } = usePrivateQuery(['profile'], '/api/me/profile');
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (data) setDraft({ ...structuredClone(data.profile), board: { ...BOARD_EMPTY, ...data.profile.board } });
  }, [data]);
  const save = useMutation({
    mutationFn: () => api('/api/me/profile', { method: 'PUT', body: { profile: draft, version: data.version } }),
    onSuccess: (d) => qc.setQueryData(['profile'], d),
  });
  const set = (path, value) =>
    setDraft((d) => {
      const nextDraft = structuredClone(d);
      const keys = path.split('.');
      let node = nextDraft;
      for (const k of keys.slice(0, -1)) node = node[k];
      node[keys.at(-1)] = value;
      return nextDraft;
    });
  return { draft, set, save, isLoading: isLoading || !draft, error };
}

function Field({ label, value, onChange, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...props} />
    </label>
  );
}

function Choice({ label, value, options, onChange, wide }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function AboutYou({ onBack, onNext }) {
  const { draft, set, save, isLoading, error } = useProfileDraft();
  if (isLoading) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;
  const go = () => save.mutate(undefined, { onSuccess: onNext });
  return (
    <div className="card section">
      <h3>About you</h3>
      <p className="muted small">Filled from your resume. Check it.</p>
      <div className="form-grid">
        <Field label="First name" value={draft.identity.firstName} onChange={(v) => set('identity.firstName', v)} autoComplete="given-name" />
        <Field label="Last name" value={draft.identity.lastName} onChange={(v) => set('identity.lastName', v)} autoComplete="family-name" />
        <Field label="Preferred name" value={draft.identity.preferredName} onChange={(v) => set('identity.preferredName', v)} />
        <Field label="Email" type="email" value={draft.contact.email} onChange={(v) => set('contact.email', v)} />
        <Field label="Phone" type="tel" value={draft.contact.phone} onChange={(v) => set('contact.phone', v)} />
        <Field label="City" value={draft.address.city} onChange={(v) => set('address.city', v)} />
        <Field label="State" value={draft.address.state} onChange={(v) => set('address.state', v)} />
        <Field label="LinkedIn" value={draft.links.linkedin} onChange={(v) => set('links.linkedin', v)} placeholder="https://www.linkedin.com/in/…" />
        <Field label="GitHub" value={draft.links.github} onChange={(v) => set('links.github', v)} placeholder="https://github.com/…" />
      </div>
      <h3 className="subhead">Work authorization (US)</h3>
      <p className="muted small">Anything left unset is left for you on each form.</p>
      <div className="form-grid">
        <Choice wide label="Are you legally authorized to work in the United States?" value={toYesNo(draft.workAuth.authorizedUS)} options={YES_NO} onChange={(v) => set('workAuth.authorizedUS', fromYesNo(v))} />
        <Choice wide label="Will you need visa sponsorship to start work (now)?" value={toYesNo(draft.workAuth.requiresSponsorshipNow)} options={YES_NO} onChange={(v) => set('workAuth.requiresSponsorshipNow', fromYesNo(v))} />
        <Choice wide label="Will you need visa sponsorship in the future (e.g. H-1B after OPT)?" value={toYesNo(draft.workAuth.requiresSponsorshipFuture)} options={YES_NO} onChange={(v) => set('workAuth.requiresSponsorshipFuture', fromYesNo(v))} />
        <Choice label="Current status" value={draft.workAuth.visaStatus ?? ''} options={VISA} onChange={(v) => set('workAuth.visaStatus', v || null)} />
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
      <StepNav onBack={onBack} onNext={go} busy={save.isPending} skip={onNext} />
    </div>
  );
}

function BoardPrefs({ onBack, onNext }) {
  const { draft, set, save, isLoading, error } = useProfileDraft();
  if (isLoading) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;
  const go = () => save.mutate(undefined, { onSuccess: onNext });
  return (
    <div className="card section">
      <h3>Your job board</h3>
      <p className="muted small">How the job list opens for you.</p>
      <div className="form-grid">
        {Object.keys(BOARD_OPTIONS).map((k) => (
          <Choice key={k} label={BOARD_LABELS[k]} value={draft.board[k]} options={BOARD_OPTIONS[k]} onChange={(v) => set(`board.${k}`, v)} />
        ))}
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
      <StepNav onBack={onBack} onNext={go} busy={save.isPending} skip={onNext} />
    </div>
  );
}
