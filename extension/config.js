'use strict';

// Settings that differ per copy of the extension. gmailClientId: the Google
// OAuth "Web application" client whose redirect URI is this extension's
// chrome.identity.getRedirectURL() (https://<extension id>.chromiumapp.org/).
// Empty = Gmail features are off.
self.JOB_CONFIG = Object.freeze({
  gmailClientId: '',
});
