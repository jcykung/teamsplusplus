/**
 * Shared state for Teams++.
 *
 * Loaded as a classic script in every context (content script, popup, and
 * service worker), so it publishes itself on globalThis instead of using ES
 * modules.
 *
 * Everything the extension remembers lives in chrome.storage.sync so it
 * follows the user to every Chrome profile signed in with the same account:
 *
 *   teamsPlusPlus.features  on/off switches for the two features
 *   teamsPlusPlus.archive   post id -> { c: reply count at archive time, t: time }
 *   teamsPlusPlus.pins      post id -> { x: preview, a: author, t: time }
 *   teamsPlusPlus.view      "inbox" (archived posts hidden) or "archives"
 *                           (only archived posts shown)
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'teamsPlusPlus.features';
  const ARCHIVE_KEY = 'teamsPlusPlus.archive';
  const PINS_KEY = 'teamsPlusPlus.pins';
  const VIEW_KEY = 'teamsPlusPlus.view';

  const FEATURES = [
    {
      id: 'inboxZero',
      attr: 'data-tpp-inbox-zero',
      label: 'Inbox Zero',
      hint: 'Adds Archive and Pin buttons to the left margin of every post. A post with no tag is in your Inbox; archiving tags it archive, Unarchive removes the tag again, and the Inbox and Archive tabs stand in for the channel tab bar’s Posts tab to show one or the other.',
      default: true
    },
    {
      id: 'pinnedMessages',
      attr: 'data-tpp-pinned-messages',
      label: 'Pinned message bars',
      hint: 'Shows pinned posts as purple bars at the top of the channel. Click a bar to open the post and its replies; pin any post yourself with the pin button.',
      default: true
    }
  ];

  const DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.id, f.default]));

  /**
   * Coerce whatever is in storage into a complete, boolean-only state object.
   * Unknown keys are dropped and missing ones fall back to their default, so a
   * stale or hand-edited storage entry can never break the content script.
   */
  function normalize(stored) {
    const state = { ...DEFAULTS };
    if (stored && typeof stored === 'object') {
      for (const feature of FEATURES) {
        if (typeof stored[feature.id] === 'boolean') {
          state[feature.id] = stored[feature.id];
        }
      }
    }
    return state;
  }

  /**
   * Keep only the newest `limit` entries of an archive/pin map. Values must be
   * objects; anything else is ignored. This is the guard that keeps a long
   * history from filling chrome.storage.sync's per-item quota.
   */
  function normalizeMap(stored, limit) {
    if (!stored || typeof stored !== 'object') return {};
    const entries = Object.entries(stored).filter(
      ([key, value]) =>
        typeof key === 'string' &&
        key.length > 0 &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
    return Object.fromEntries(entries.slice(-limit));
  }

  function normalizeView(value) {
    return value === 'archives' ? 'archives' : 'inbox';
  }

  /** Promise wrapper around chrome.storage.sync.get. */
  function readSync(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(keys, (items) => {
          resolve(chrome.runtime.lastError ? {} : items || {});
        });
      } catch (_) {
        // The extension was reloaded while this page stayed open.
        resolve({});
      }
    });
  }

  /**
   * Promise wrapper around chrome.storage.sync.set. Resolves false when the
   * write failed (normally the per-item or total quota), so callers can trim
   * their data and try again instead of silently losing it.
   */
  function writeSync(items) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(items, () => resolve(!chrome.runtime.lastError));
      } catch (_) {
        resolve(false);
      }
    });
  }

  root.TeamsPlusPlus = {
    STORAGE_KEY,
    ARCHIVE_KEY,
    PINS_KEY,
    VIEW_KEY,
    FEATURES,
    DEFAULTS,
    normalize,
    normalizeMap,
    normalizeView,
    readSync,
    writeSync
  };
})(globalThis);
