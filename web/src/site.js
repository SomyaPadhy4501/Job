// The site's real address: the one registered with Google sign-in.
export const SITE_HOST = 'job-two-xi.vercel.app';

/// Google sign-in works only on addresses registered with the Google client.
export function signInWorksHere() {
  const host = window.location.hostname;
  return host === SITE_HOST || host === 'localhost' || host === '127.0.0.1';
}
