import { useAccount } from '../account.js';
import SignIn from './SignIn.jsx';

export default function RequireAuth({ children, reason }) {
  const { data, isLoading, error } = useAccount();
  if (isLoading) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;
  if (!data?.user) return <SignIn reason={reason} />;
  return children;
}

/// Shown when the server answers `reauth`: sensitive actions need a sign-in
/// from the last few minutes.
export function ReauthNotice({ error, onDone }) {
  if (error?.code !== 'reauth') return null;
  return <SignIn title="Confirm it's you" reason={error.message} onDone={onDone} />;
}
