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
 *   teamsPlusPlus.features  on/off switches for the features
 *   teamsPlusPlus.unread    post id -> { t: time, r: 0 unread | 1 read }, the
 *                           few posts whose state is not the default. A post
 *                           with no entry is read, so a channel's whole history
 *                           costs nothing until it is unread again.
 *   teamsPlusPlus.view      "inbox" (read posts hidden) or "archives"
 *                           (only read posts shown)
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'teamsPlusPlus.features';
  const UNREAD_KEY = 'teamsPlusPlus.unread';
  /** The map the build before read state kept its archive tags in. */
  const LEGACY_ARCHIVE_KEY = 'teamsPlusPlus.archive';
  /** When the extension was installed, in ms: posts stamped later are unread. */
  const SINCE_KEY = 'teamsPlusPlus.since';
  const VIEW_KEY = 'teamsPlusPlus.view';

  const FEATURES = [
    {
      id: 'inboxZero',
      attr: 'data-tpp-inbox-zero',
      label: 'Inbox Zero',
      hint: 'Splits the channel into an Inbox of unread posts and an Archive of the rest. Archiving a post marks it read.',
      default: true
    },
    {
      id: 'pinnedMessages',
      attr: 'data-tpp-pinned-messages',
      label: 'Pinned message bars',
      hint: 'Shows the posts pinned for the whole channel as purple bars at the top. Click one to open it.',
      default: true,
      // Not a choice: the bars are part of the Inbox and have no switch in the
      // popup. Locked features ignore storage, so an older build's "off" — or a
      // hand-edited sync value — cannot turn them off for this user.
      locked: true
    },
    {
      id: 'compactPosts',
      attr: 'data-tpp-compact-posts',
      label: 'Compact posts',
      hint: 'Shows each post as a card: author, time, headline and two lines. Open one to see the rest.',
      default: true
    },
    {
      id: 'inboxConfetti',
      attr: 'data-tpp-inbox-confetti',
      label: 'Inbox Zero confetti',
      hint: 'Throws one round of confetti when the Inbox Zero sign appears. Turn it off for a quiet Inbox.',
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
        // A locked feature is always its default: it has no switch, so nothing
        // in storage may describe it as off.
        if (feature.locked) continue;
        if (typeof stored[feature.id] === 'boolean') {
          state[feature.id] = stored[feature.id];
        }
      }
    }
    return state;
  }

  /**
   * Keep only the newest `limit` entries of a stored map. Values must be
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
    UNREAD_KEY,
    LEGACY_ARCHIVE_KEY,
    SINCE_KEY,
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
