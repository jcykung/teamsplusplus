/**
 * Teams++ — background service worker.
 *
 * Owns the one thing that decides whether the extension may run: host access.
 * - Access is optional. Nothing is declared at install time and nothing is
 *   injected until the user clicks "Enable on Microsoft Teams" in the popup or
 *   on the welcome page, so Chrome asks for the site only on that click.
 * - Right after the grant, the content script is registered dynamically and
 *   persists across browser restarts; if access is revoked in Chrome, the
 *   registration is removed again and no page is touched.
 * - On first install: initializes sync settings, opens onboarding.html.
 * - On update: re-registers for users who already granted access, refreshes
 *   open Teams tabs, and opens changelog.html.
 */

/* global importScripts */
importScripts('src/shared/features.js');

/** Every Teams web origin, +/* — the only sites Teams++ ever touches. */
const TEAMS_ORIGINS = [
  'https://teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
  'https://teams.live.com/*'
];
const CONTENT_SCRIPT_ID = 'teamspp-content';
/** Bumped with every change to the content script; see the refresh block below. */
const CONTENT_VERSION = '1.0.2-2026-11-03.148';

const { DEFAULTS, STORAGE_KEY, VIEW_KEY } = globalThis.TeamsPlusPlus;

/** Yes/no answer to "may this extension run on Teams?", never a guess. */
function hasTeamsAccess(callback = () => {}) {
  if (!chrome.permissions || !chrome.permissions.contains) return callback(false);
  chrome.permissions.contains({ origins: TEAMS_ORIGINS }, (granted) => {
    callback(Boolean(granted) && !chrome.runtime.lastError);
  });
}

function registerContentScripts(callback = () => {}) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return callback();
  const script = {
    id: CONTENT_SCRIPT_ID,
    matches: TEAMS_ORIGINS,
    js: [
      'src/content/selectors.js',
      'src/shared/features.js',
      'src/content/content.js'
    ],
    css: ['src/content/teams.css'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true
  };
  chrome.scripting.registerContentScripts([script], () => {
    if (!chrome.runtime.lastError) return callback();
    // Already registered (a restart, or a re-grant): update it in place.
    chrome.scripting.updateContentScripts([script], () => {
      void chrome.runtime.lastError;
      callback();
    });
  });
}

function unregisterContentScripts(callback = () => {}) {
  if (!chrome.scripting || !chrome.scripting.unregisterContentScripts) return callback();
  chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }, () => {
    // Nothing registered is the normal case, not an error worth reporting.
    void chrome.runtime.lastError;
    callback();
  });
}

/**
 * Keep the registration in step with the permission the user actually holds.
 * Without access nothing is registered, so Teams is left untouched.
 */
function syncContentScriptRegistration(callback = () => {}) {
  hasTeamsAccess((granted) => {
    if (!granted) return unregisterContentScripts(callback);
    registerContentScripts(callback);
  });
}

/**
 * Reload every open Teams tab so the content script is injected immediately
 * instead of waiting for the user to refresh.
 */
function reloadTeamsTabs() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ url: TEAMS_ORIGINS }, (tabs) => {
    // Swallow "no tab" races and missing host access instead of logging noise.
    if (chrome.runtime.lastError) return;
    for (const tab of tabs || []) {
      if (typeof tab.id !== 'number') continue;
      chrome.tabs.reload(tab.id, {}, () => void chrome.runtime.lastError);
    }
  });
}

/** The popup and the welcome page ask for access themselves, then say so. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'teams-access-changed') return false;
  syncContentScriptRegistration(() => {
    if (message.granted) reloadTeamsTabs();
    sendResponse({ ok: true });
  });
  return true;
});

// A restart keeps the grant, so the registration is restored on its own.
chrome.runtime.onStartup.addListener(() => syncContentScriptRegistration());

// Revoking access in chrome://extensions must stop injection right away, and
// re-granting it must bring the content script back without a restart.
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => syncContentScriptRegistration());
}
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => syncContentScriptRegistration());
}

/**
 * A reload of the extension does not reach the content script already running in
 * an open Teams tab: the tab keeps the old code until it is refreshed. A build
 * stamp makes reloading the extension enough — when the stamp is new, open Teams
 * tabs are refreshed once, so the code actually under test is the code on disk.
 */
chrome.storage.local.get('teamsppContentVersion', (items) => {
  if (chrome.runtime.lastError) return;
  if (items && items.teamsppContentVersion === CONTENT_VERSION) return;
  chrome.storage.local.set({ teamsppContentVersion: CONTENT_VERSION }, () => {
    void chrome.runtime.lastError;
    reloadTeamsTabs();
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Seed the switches and the default inbox view. Feature reads normalize
    // missing keys anyway, but this gives the popup something to render on the
    // very first open.
    chrome.storage.sync.set(
      { [STORAGE_KEY]: DEFAULTS, [VIEW_KEY]: 'inbox' },
      () => void chrome.runtime.lastError
    );
    // No access yet: this just clears any stale registration.
    syncContentScriptRegistration();
    chrome.tabs.create({ url: 'onboarding.html' });
    return;
  }

  if (details.reason === 'update') {
    // People who granted access on an earlier version keep working without
    // clicking Enable again; everyone else enables it from the popup.
    hasTeamsAccess((granted) => {
      if (!granted) return;
      registerContentScripts(() => reloadTeamsTabs());
    });
    // Automatically open the changelog page on update.
    chrome.tabs.create({ url: 'changelog.html' });
  }
});
