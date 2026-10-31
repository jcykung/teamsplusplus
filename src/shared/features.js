/**
 * Feature registry, shared by the content script and the popup.
 *
 * Loaded as a classic script in both contexts (see manifest.json), so it
 * publishes itself on globalThis instead of using ES modules.
 *
 * `attr` is the attribute the content script puts on <html>; teams.css keys its
 * rules off it, so toggling is instant. Features that also need DOM work have a
 * matching entry in the CUSTOM map in src/content/content.js.
 */
(function (root) {
  'use strict';

  /** chrome.storage.sync key holding the user's on/off choices. */
  const STORAGE_KEY = 'betterTeams.features';

  const FEATURES = [
    {
      id: 'unreadBanner',
      attr: 'data-bt-unread-banner',
      label: 'Unread banner',
      hint: 'Shows how many posts you have not read, with jump and mark-as-read actions.',
      default: true
    },
    {
      id: 'dateDividers',
      attr: 'data-bt-date-dividers',
      label: 'Sticky date dividers',
      hint: 'Pins each day’s date to the top of the list while you scroll.',
      default: true
    },
    {
      id: 'avatarOffset',
      attr: 'data-bt-avatar-offset',
      label: 'Separate each post',
      hint: 'Offsets avatars and adds spacing so posts are easier to tell apart.',
      default: true
    },
    {
      id: 'unreadLine',
      attr: 'data-bt-unread-line',
      label: 'Red line above unread posts',
      hint: 'Draws a bright red rule where new messages start.',
      default: true
    },
    {
      id: 'floatingComposer',
      attr: 'data-bt-floating-composer',
      label: 'Floating compose box',
      hint: 'Lifts the compose box off the list so messages scroll behind it.',
      default: true
    },
    {
      id: 'pinnedShortcut',
      attr: 'data-bt-pinned-shortcut',
      label: 'Pinned messages shortcut',
      hint: 'Adds a pin button so pinned posts are one click away.',
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

  root.BetterTeams = { STORAGE_KEY, FEATURES, DEFAULTS, normalize };
})(globalThis);
