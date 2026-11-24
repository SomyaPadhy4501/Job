import { useState } from 'react';

// iPhone Safari has no install button: tell iPhone users once how to add the
// board to their Home Screen. Hidden once installed (standalone) or dismissed.
const KEY = 'installHintDismissed';

function shouldShow() {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!ios || installed) return false;
  try {
    return !localStorage.getItem(KEY);
  } catch {
    return true;
  }
}

export default function InstallHint() {
  const [show, setShow] = useState(shouldShow);
  if (!show) return null;
  const close = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Private mode: it just shows again next visit.
    }
    setShow(false);
  };
  return (
    <div className="install-hint" role="status">
      <span>
        Get the app: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </span>
      <button type="button" className="btn btn-small btn-ghost" onClick={close} aria-label="Dismiss">
        Close
      </button>
    </div>
  );
}
