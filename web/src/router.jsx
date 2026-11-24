import { useEffect, useState } from 'react';

// A five-route app doesn't need a router library. Paths come from
// window.location.pathname; links push history entries and notify listeners.
// The board's filters keep using replaceState on the query string, which
// doesn't touch the path.

const listeners = new Set();

export function navigate(to) {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', to);
  window.scrollTo(0, 0);
  listeners.forEach((fn) => fn());
}

export function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export function Link({ to, className, children, ...rest }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
