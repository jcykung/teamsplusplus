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
 *   teamsPlusPlus.newPosts  post id -> { n: 1 } while the compact card is still
 *                           new (with `u: 1` when the user marked it unread by
 *                           hand, which the card always calls Unread), or { f }
 *                           with the fingerprint captured when it was read and
 *                           `t`, when that read happened. While the "Manually
 *                           mark as read" switch is on, the only thing that
 *                           marks a post read in the compact view is opening
 *                           its card.
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
  /** The compact view's own marks: see newPosts in the header above. */
  const NEW_POSTS_KEY = 'teamsPlusPlus.newPosts';

  const FEATURES = [
    {
      id: 'inboxZero',
      attr: 'data-tpp-inbox-zero',
      label: 'Inbox Zero',
      hint: 'Splits the channel into an Inbox of unread posts and an Archive of the rest. Archiving a post marks it read.',
      default: false,
      // Not ready for release. The code is kept so the feature can be picked up
      // again, but the switch is hidden and normalize() pins it off: a stored or
      // synced `true` cannot switch it on.
      disabled: true
    },
    {
      id: 'compactPosts',
      attr: 'data-tpp-compact-posts',
      label: 'Compact posts',
      hint: 'Shows each post as a card: author, time, headline and two lines. Open one to see the rest.',
      default: true
    },
    {
      id: 'manualRead',
      attr: 'data-tpp-manual-read',
      label: 'Manually mark as read',
      hint: "A post keeps its purple border until you open its card: the badge says New while Teams still marks it new, then Unread once Teams clears it. Marking a post unread brings it back as Unread straight away, and only for that post. Turn it off to follow Teams instead.",
      default: true
    },
    {
      id: 'inboxConfetti',
      attr: 'data-tpp-inbox-confetti',
      label: 'Inbox Zero confetti',
      hint: 'Throws one round of confetti when the Inbox Zero sign appears. Turn it off for a quiet Inbox.',
      default: false,
      // Part of Inbox Zero, and off with it for this release.
      disabled: true
    },
    {
      id: 'railDot',
      attr: 'data-tpp-rail-dot',
      label: 'Channel dot',
      hint: 'Marks a channel with unread posts in the left rail: its name stays bold and a purple dot sits in its line, and the dot goes once the posts it stood for have been read.',
      default: false,
      // Not in this release: the cue Teams gives a channel proved too
      // unreliable to ship, and a dot left standing over a channel that has
      // been read is worse than no dot at all. Switching this on brings the
      // whole thing back; until then the switch is hidden and normalize() pins
      // it off, so the rail is not even read.
      disabled: true
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
    // A disabled feature is off in every context, whatever storage or Chrome
    // Sync says. This is the one gate the content script, popup and service
    // worker all pass through.
    for (const feature of FEATURES) {
      if (feature.disabled) state[feature.id] = false;
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
    NEW_POSTS_KEY,
    FEATURES,
    DEFAULTS,
    normalize,
    normalizeMap,
    normalizeView,
    readSync,
    writeSync
  };
})(globalThis);
