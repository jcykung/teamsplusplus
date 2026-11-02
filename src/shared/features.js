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
 *   teamsPlusPlus.unread    post id -> { t: time, r: 0 unread | 1 read }, the
 *                           few posts whose state is not the default. A post
 *                           with no entry is read, so a channel's whole history
 *                           costs nothing until it is unread again.
 *   teamsPlusPlus.pins      post id -> { x: preview, a: author, t: time }
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
  const PINS_KEY = 'teamsPlusPlus.pins';
  const VIEW_KEY = 'teamsPlusPlus.view';

  const FEATURES = [
    {
      id: 'inboxZero',
      attr: 'data-tpp-inbox-zero',
      label: 'Inbox Zero',
      hint: 'Adds Archive and Pin buttons to the left margin of every post. A post is read or unread: unread posts are your Inbox, and archiving marks a post read and files it in Archive. Anything posted after you installed Teams++ starts in the Inbox; everything already in the channel at install is read. Teams’ own New and Last read markers are no longer shown — the tabs say where you are.',
      default: true
    },
    {
      id: 'pinnedMessages',
      attr: 'data-tpp-pinned-messages',
      label: 'Pinned message bars',
      hint: 'Shows pinned posts as purple bars at the top of the channel. Click a bar to jump to the post where it sits in the stream; a pinned post shows only its Pin button until it is unpinned.',
      default: true
    },
    {
      id: 'compactPosts',
      attr: 'data-tpp-compact-posts',
      label: 'Compact posts',
      hint: 'Shows every post as a card: the author, the time, the headline and the first two lines. Replies, reactions and images stay folded away until you open a post.',
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

  /** The newest pin time in a channel's bucket, for ordering channels. */
  function latestPin(bucket) {
    let newest = 0;
    for (const entry of Object.values(bucket || {})) {
      if (entry && typeof entry.t === 'number' && entry.t > newest) newest = entry.t;
    }
    return newest;
  }

  /**
   * Coerce stored pins into `{ channel: { postId: entry } }`.
   *
   * A pin belongs to the channel it was made in, so the map is nested one level
   * deeper than it used to be. Channels are kept newest first and trimmed to
   * `channelLimit`, because one-chrome.storage.sync quota is shared by every
   * channel the user has ever pinned in; pins inside a channel are trimmed to
   * `perChannel`. A flat map from an older build names no channel and is left
   * for the content script to adopt (isLegacyPins).
   */
  function normalizePins(stored, perChannel, channelLimit) {
    if (!stored || typeof stored !== 'object') return {};

    const channels = {};
    for (const [channel, bucket] of Object.entries(stored)) {
      if (!channel || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const pins = normalizeMap(bucket, perChannel);
      if (Object.keys(pins).length) channels[channel] = pins;
    }

    const newest = Object.entries(channels).sort((a, b) => latestPin(b[1]) - latestPin(a[1]));
    return Object.fromEntries(newest.slice(0, channelLimit));
  }

  /**
   * True for the old one-flat-map pins, which name no channel. A channel bucket
   * holds pins and a pin holds strings and numbers, so the two are easy to tell
   * apart one level down.
   */
  function isLegacyPins(stored) {
    if (!stored || typeof stored !== 'object') return false;
    const entries = Object.values(stored);
    if (!entries.length) return false;
    return entries.every((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      return !Object.values(value).every((inner) => inner && typeof inner === 'object');
    });
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
    PINS_KEY,
    VIEW_KEY,
    FEATURES,
    DEFAULTS,
    normalize,
    normalizeMap,
    normalizePins,
    isLegacyPins,
    normalizeView,
    readSync,
    writeSync
  };
})(globalThis);
