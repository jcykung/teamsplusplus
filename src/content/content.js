/**
 * Teams++ content script.
 *
 * Two features live here:
 *
 *   Inbox Zero      Every post is read or unread, and every post gets an
 *                   Archive button in its left margin; comments and replies
 *                   never get one. A post is unread when Teams says so: its
 *                   clock (anything stamped after the extension was installed)
 *                   or its own New badge. A badge is written down as an unread
 *                   decision the first time it is seen, so the post stays in
 *                   the Inbox after Teams clears the badge. Only the Archive
 *                   button files it. Teams' Last read line is not shown — the
 *                   Inbox and Archive tabs are the marker now.
 *
 * Everything the user changes is written to chrome.storage.sync, so the same
 * archive and view follow them to every Chrome profile.
 *
 * Teams re-renders its message list constantly and hashes its class names, so
 * rows are recognised by data-tid/role anchors (see selectors.js) and one
 * debounced scan repairs the UI after every render.
 */
(function () {
  'use strict';

  const {
    STORAGE_KEY,
    UNREAD_KEY,
    LEGACY_ARCHIVE_KEY,
    SINCE_KEY,
    VIEW_KEY,
    FEATURES,
    normalize,
    normalizeMap,
    normalizeView,
    readSync,
    writeSync
  } = globalThis.TeamsPlusPlus;
  const S = globalThis.TeamsPlusPlusSelectors;

  /**
   * Read/unread decisions the user made, kept in storage. Only a click needs an
   * entry: with no entry a post is judged by its timestamp against `since`, so a
   * channel's history costs nothing.
   */
  const READ_LIMIT = 240;
  /**
   * The key the build before this one kept the user's own pins under, each with
   * a copy of the post's words. Pinning is Teams' own now, so it is removed.
   */
  const LEGACY_PINS_KEY = 'teamsPlusPlus.pins';
  /**
   * What each archived post looked like when it was filed, in local storage.
   * It is derived from what Teams rendered on this device rather than a
   * decision the user made, so it does not travel with the synced archive.
   */
  const ACTIVITY_KEY = 'teamsPlusPlus.activity';
  const ACTIVITY_LIMIT = 300;

  const VIEW_INBOX = 'inbox';
  const VIEW_ARCHIVES = 'archives';

  const TABS_ID = 'tpp-tabs';
  const CONFETTI_ID = 'tpp-confetti';
  const EMPTY_ID = 'tpp-empty-state';
  const TOAST_ID = 'tpp-toast';
  /**
   * How often the idle pass runs while the page mutates for its own reasons.
   *
   * A scan is cheap when the posts have not changed (see scanNow), but it still
   * asks the page a few questions; at 1.5 s it ran dozens of times a minute on
   * a channel nobody was touching.
   */
  const SLOW_SCAN_MS = 4000;
  /** How long a post takes to slide out of the Inbox when it is archived. */
  const ARCHIVE_ANIM_MS = 300;
  const HAS_ARCHIVES_ATTR = 'data-tpp-has-archives';
  /** Set when the current view has no post on show at all (teams.css). */
  const EMPTY_VIEW_ATTR = 'data-tpp-empty-view';
  /**
   * The panes Teams draws a single post in, outside the Posts list: the view
   * "Find in channel" opens, a message's thread, a pinned post. Nothing of ours
   * belongs in one — not the filter, not a card, not the tab pair.
   */
  const TEAMS_PANE_SELECTOR = [
    '[data-tid="channel-replies-pane-message"]',
    '[data-tid*="replies-pane" i]',
    '[data-tid*="message-detail" i]'
  ].join(', ');
  /** The build on disk; also left on <html> so the running script can be checked. */
  const BUILD = '2026-11-03.140';
  /** What the stylesheet reads to pick its light or dark palette. */
  const THEME_ATTR = 'data-tpp-theme';
  /** Attributes Teams leaves behind that name the theme. */
  const THEME_HINTS = [
    'data-theme',
    'data-app-theme',
    'data-color-scheme',
    'data-color-mode',
    'data-theme-name'
  ];

  /** How close the pointer must be to the seam between two posts, in px. */

  /** Width of the left margin the post buttons float in, in px. */
  const RAIL_GUTTER = 32;

  const ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  const ARCHIVE_FILLED_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v4H3V4z"/><path fill="currentColor" fill-rule="evenodd" d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9H5zm5 3a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1z" clip-rule="evenodd"/></svg>';
  /**
   * A box with an arrow lifting out of it: the way out of the Archive, and the
   * one shape everyone already reads as "take it back".
   */
  const ARCHIVE_UP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 18v-7"/><path d="m8.8 14.2 3.2-3.2 3.2 3.2"/></svg>';
  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const EMPTY_ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 13h4"/></svg>';
  /** The small chevron on a folded post's card: this card opens. */
  const CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  /** The channel header watched for a channel change (see watchChannelTitle). */
  let titleEl = null;
  let titleObserver = null;

  /** When the message list first went missing, in ms, or 0 while it is there. */
  let listMissingAt = 0;

  /** When the verdict first said "not a channel", in ms, or 0 while it says yes. */
  let notChannelAt = 0;
  let ready = false;
  let features = null;
  /**
   * id -> { t, r, c } — the decisions the user made: r: 0 unread, 1 read, and
   * c: 1 for a click (which is what lets the row close up behind itself). A post
   * with no entry is judged by its timestamp against `since`, below.
   */
  let readState = {};
  /** id -> the activity fingerprint taken when the post was last read. */
  let activityState = {};
  let activitySaveTimer = 0;
  /** When the extension was installed, in ms. Posts stamped later are unread. */
  let since = 0;
  let view = VIEW_INBOX;
  /**
   * Whether the page on screen is a channel's Posts area. Teams++ is for
   * channels only: a chat has its own message list and gets none of it, which
   * is enforced by writing the feature flags (what teams.css hangs every style
   * off) only while this is true.
   */
  let channelMode = null;
  /** The element carrying the room after the rows: see markRoom. */
  let roomEl = null;
  /** The view the scroll was last clamped for (see clampScroll). */
  let clampView = '';

  /** id -> { row, id, text, author, read, ts } for the latest scan. */
  let rowsById = new Map();

  let observer = null;
  let lastList = null;
  let listRect = null;
  /** When the theme was last re-checked from the scan (it is not free). */
  let themeAt = 0;
  /** The channel's own "Posts" tab while our tabs stand in for it. */
  let hiddenNativeTab = null;
  /** Posts the user has unfolded in the compact view, by id. */
  const unfolded = new Set();
  /** Set while a click we generated is in flight, so it is not read as the user's. */
  let forwardingClick = false;
  let rescanTimer = 0;
  let slowTimer = 0;
  /**
   * Whether anything in the posts list has changed since the rows were last
   * read. Teams mutates the page constantly for reasons that have nothing to do
   * with the posts, and re-reading every post for each of those was the load
   * this script put on the main thread while a channel was arriving.
   */
  let listDirty = true;
  /**
   * Scan timings, kept for the readout in `start` — off unless switched on with
   * `localStorage.tppPerf = '1'`, so nothing is measured in normal use.
   */
  const perf = {
    on: false,
    scans: 0,
    total: 0,
    max: 0,
    rebuilds: 0,
    rebuildTotal: 0,
    batches: 0,
    relevant: 0,
    mutTotal: 0,
    mutMax: 0,
    startedAt: Date.now(),
    loadStartedAt: 0,
    loadMs: 0,
    loadRows: 0,
    writtenAt: 0
  };
  let readSaveTimer = 0;
  let frame = 0;
  /** Cached answers to the two "hands off" checks (see teamsPostPane/composerOpen). */
  let paneProbeAt = 0;
  let paneProbeValue = false;
  let composerProbeAt = 0;
  let composerProbeValue = false;
  /** The element that scrolls the post list, remembered for the scroll handler. */
  let lastScrollBox = null;
  /** Whether a channel's UI has been drawn, so another view tears it down once. */
  let uiDrawn = false;
  /** When the scroll limit was last re-measured from the scroll handler. */
  let clampedAt = 0;
  let toastTimer = 0;
  /**
   * Clicking a compact post unfolds it, the way a mail app opens a message.
   *
   * The click is only observed, never taken: Teams still gets it, so links,
   * reactions and the reply box behave exactly as before. Open posts are kept
   * by id, so a re-render does not fold the one being read.
   */
  function onPostClick(event) {
    if (!ready || !channelMode || !features || !features.compactPosts) return;
    // A click we generated to hand a post to Teams is not the user folding or
    // unfolding one: it must not be read as a toggle.
    if (forwardingClick) return;
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], .tpp-post-actions, [data-shortcut-context="compose-field"]'
      )
    ) {
      return;
    }

    const row = target.closest('.tpp-post');
    if (!row || !row.dataset.tppId) return;
    // A post Teams has put in a pane of its own — a search result, a pinned
    // message, a dialog — is not ours to fold, whatever a scan left on it.
    if (inTeamsPane(row)) return;
    toggleUnfold(row);
  }

  /** Folds one post, or unfolds it again if it is already open. */
  function toggleUnfold(row) {
    const id = row && row.dataset.tppId;
    if (!id) return;
    const open = !unfolded.has(id);
    if (open) unfolded.add(id);
    else unfolded.delete(id);
    row.classList.toggle('tpp-unfold', open);
    // An opened post takes the keyboard the way a message does when Teams is
    // clicked on it: the card that opened it is not a message, so focus is put
    // on the post itself.
    if (open) focusPostMessage(row);
    // The post changed height, so anything placed against it is re-measured.
    reposition();
  }

  /**
   * Puts the keyboard inside a post Teams' own handlers know about.
   *
   * Teams' focus target for a message is its body (`role="group"` with a
   * tabindex), and the message keyboard shortcuts are scoped to what has focus.
   * Focusing it is what clicking a message does in Teams, so the shortcuts work
   * the same way here once a post is open.
   */
  function focusPostMessage(row) {
    if (!row) return;

    // Focus is asked for over the next few frames, not once. Hiding the card that
    // was clicked makes the browser drop focus to the document, and Teams' own
    // focus restorer can put it back where it was; the post has to be the last
    // thing asked for, after the click has finished and after the next paint.
    const grab = () => {
      if (!row.isConnected || !unfolded.has(row.dataset.tppId)) return;
      const active = document.activeElement;
      // The user has moved on: their focus stays where they put it.
      if (active && active !== document.body && !row.contains(active)) return;

      const target = postFocusTarget(row);
      if (target) {
        try {
          target.focus({ preventScroll: true });
        } catch (_) {
          // Not focusable in this build: the row fallback below still tries.
        }
        if (row.contains(document.activeElement)) return;
      }

      // Last resort: the row itself, focusable programmatically only.
      if (!row.hasAttribute('tabindex')) {
        row.setAttribute('tabindex', '-1');
        row.dataset.tppTabindex = '1';
      }
      try {
        row.focus({ preventScroll: true });
      } catch (_) {
        // Nothing left to focus.
      }
    };

    grab();
    requestAnimationFrame(grab);
    window.setTimeout(grab, 90);
    window.setTimeout(grab, 260);
  }

  /** The node Teams treats as the message when a post is clicked. */
  function postFocusTarget(row) {
    if (!row) return null;
    const selectors = [
      '[id^="message-body-"][tabindex]',
      '[data-tid="message-body"][tabindex]',
      '[data-tid*="message-body" i][tabindex]',
      '[data-tid*="message-content" i][tabindex]',
      '[role="group"][tabindex="0"]',
      '[tabindex="0"]:not(button):not(a)'
    ];
    for (const selector of selectors) {
      let found = null;
      try {
        found = row.querySelector(selector);
      } catch (_) {
        continue;
      }
      // Never our own controls: the rail lives in the post's margin, not the post.
      if (found && !found.closest('[data-tpp-ui]')) return found;
    }
    return null;
  }

  /**
   * Makes a just-opened post the message Teams' keyboard acts on.
   *
   * Teams marks the active message when one is clicked, and the card that opened
   * the post is not a message — which is why a second click on the post was
   * needed before its shortcuts worked. That click is replayed on the post's own
   * body here, so an opened post is active straight away.
   */
  function activatePost(row) {
    if (!row) return;
    const target = postFocusTarget(row);

    // The click Teams would have received had the post itself been clicked, so
    // it marks the message as the active one.
    if (target) {
      forwardingClick = true;
      try {
        pressElement(target);
      } finally {
        forwardingClick = false;
      }
    }

    focusPostMessage(row);
  }

  /**
   * Escape closes a post that is open.
   *
   * Clicking an open post is left to Teams, so the keyboard keeps the fold. The
   * focus is already inside the post when this runs, which is where the user is;
   * a reply box or any other editor keeps its Escape.
   */
  function onPostKeyDown(event) {
    if (event.key !== 'Escape' || !ready || !channelMode) return;
    if (!features || !features.compactPosts) return;
    const active = document.activeElement;
    if (!active || !active.closest) return;
    if (active.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;

    const row = active.closest('.tpp-post.tpp-unfold');
    const id = row && row.dataset.tppId;
    if (!id) return;
    unfolded.delete(id);
    row.classList.remove('tpp-unfold');
    reposition();
  }

  /** Marks a post's body so the compact view can clamp it. */
  function markBody(row) {
    if (row.querySelector('.tpp-body')) return;

    for (const selector of S.messageBody || []) {
      let found = null;
      try {
        found = row.querySelector(selector);
      } catch (_) {
        continue;
      }
      if (!found) continue;
      found.classList.add('tpp-body');
      return;
    }
  }

  /**
   * Marks the post's header line, which the compact view holds to a single
   * line: the name, the date and time, and the subject Teams shows beside them.
   * The time is marked so it can be dimmed against the name, not hidden.
   */
  function markHead(row) {
    if (row.querySelector('.tpp-head')) return;

    const author = first(S.messageAuthor, row);
    if (!author) return;

    const head = author.parentElement;
    if (!head || head === row) return;

    if (!head.classList.contains('tpp-head')) head.classList.add('tpp-head');
    if (!author.classList.contains('tpp-author')) author.classList.add('tpp-author');

    // The time stays: the folded line reads name, date/time, subject. A subject
    // Teams renders beside the name is part of that line too, so it is left
    // alone.
    for (const selector of S.messageTime || []) {
      for (const el of head.querySelectorAll(selector)) {
        if (el.contains(author) || author.contains(el)) continue;
        if (!el.classList.contains('tpp-head-time')) el.classList.add('tpp-head-time');
      }
    }
  }

  /**
   * The picture Teams drew for a post's author, as an image URL. It sits beside
   * the post's text, not in it, and may be an <img> or a painted background.
   */
  function avatarOf(row) {
    const head = row.querySelector('.tpp-head');
    const body = row.querySelector('.tpp-body');
    const isPostText = (el) =>
      Boolean((head && head.contains(el)) || (body && body.contains(el)));

    for (const selector of S.messageAvatar || []) {
      let found = [];
      try {
        found = Array.from(row.querySelectorAll(selector));
      } catch (_) {
        continue; // A bad selector from a hand edit should not stop the rest.
      }
      for (const el of found) {
        if (isPostText(el) || el.hasAttribute('data-tpp-ui')) continue;
        const img = el.tagName === 'IMG' ? el : el.querySelector('img');
        if (img && img.src) return img.src;
        const painted = getComputedStyle(el).backgroundImage || '';
        const url = /url\(["']?(.*?)["']?\)/.exec(painted);
        if (url && url[1]) return url[1];
      }
    }
    return '';
  }

  /** What the card shows when the post has no picture: the author's initials. */
  function initialsOf(name) {
    const words = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return '?';
    const first = words[0][0] || '';
    const last = words.length > 1 ? words[words.length - 1][0] || '' : '';
    return `${first}${last}`.toUpperCase();
  }

  /**
   * The headline on a folded post's card: Teams' own subject when the post has
   * one, otherwise the opening line of the post. previewOf is not used here
   * because it flattens the text to one line; the first line is the subject.
   */
  function headlineOf(row) {
    const explicit = first(S.messageSubject, row);
    const body = first(S.messageBody, row) || row;
    if (explicit && !body.contains(explicit)) {
      const text = collapse(explicit.textContent || '');
      if (text) return text.slice(0, 140);
    }

    const raw = String(body.textContent || '').replace(/\r/g, '');
    const lines = raw.split('\n').map(collapse).filter(Boolean);
    const lead = lines[0] || '';
    if (lines.length > 1 && lead) return lead.slice(0, 140);
    if (lead.length <= 120) return lead.slice(0, 140);

    // One long paragraph: the headline is its opening words, cut on a word.
    const cut = lead.slice(0, 120).replace(/\s+\S*$/, '');
    return `${cut || lead.slice(0, 110)}…`;
  }

  /** The card's headline, from a post whose body text has already been read. */
  function headlineFrom(row, body, raw) {
    const explicit = first(S.messageSubject, row);
    if (explicit && !(body && body.contains(explicit))) {
      const label = collapse(explicit.textContent || '');
      if (label) return label.slice(0, 140);
    }

    const lines = String(raw || '').split('\n').map(collapse).filter(Boolean);
    const lead = lines[0] || '';
    if (lines.length > 1 && lead) return lead.slice(0, 140);
    if (lead.length <= 120) return lead.slice(0, 140);

    const cut = lead.slice(0, 120).replace(/\s+\S*$/, '');
    return `${cut || lead.slice(0, 110)}…`;
  }

  /** The rest of the post under the headline, from the text already read. */
  function snippetFrom(raw, headline) {
    let text = collapse(raw);
    const lead = collapse(headline || '').replace(/…$/, '');
    if (lead && text.startsWith(lead)) text = text.slice(lead.length);
    return text.replace(/^[\s\-–—:|,.;]+/, '').slice(0, 300);
  }

  /** The rest of the post, shown under the headline in the fold. */
  function snippetFor(row, headline) {
    const body = first(S.messageBody, row) || row;
    let text = collapse(body.textContent || '');
    const lead = collapse(headline || '').replace(/…$/, '');
    if (lead && text.startsWith(lead)) text = text.slice(lead.length);
    return text.replace(/^[\s\-–—:|,.;]+/, '').slice(0, 300);
  }

  /**
   * The card a folded post shows: the author's picture, their name and the time,
   * the post's opening line as a headline, and the first two lines of the words
   * under it. It is a channel as a list of headlines — open the ones worth
   * reading, and the rest cost a line each.
   *
   * The card is a button of our own, and the post Teams rendered stays in the
   * row behind it, so opening the post hands the row straight back to Teams
   * with replies, reactions and the reply box working (teams.css swaps them).
   */
  function paintPreview(row) {
    if (!features || !features.compactPosts) return;
    if (!row.dataset.tppId) return;

    let card = row.querySelector(':scope > [data-tpp-ui="preview"]');
    const body = first(S.messageBody, row);
    const author = authorOf(row);
    const timeEl = first(S.messageTime, row);
    const time = timeEl ? collapse(timeEl.textContent || '') : '';
    const raw = body ? String(body.textContent || '').replace(/\r/g, '') : '';

    // A card already drawn is left alone unless the post's author, time or
    // words changed. Everything below reads and rewrites the card, and this
    // runs for every post on every scan: comparing a short fingerprint first is
    // what keeps a Teams re-render from costing a full repaint of the list.
    const signature = [row.dataset.tppId, author, time, raw.length, raw.slice(0, 24)].join('|');
    if (card && row.dataset.tppCardOf === signature) {
      if (!row.classList.contains('tpp-previewed')) row.classList.add('tpp-previewed');
      return;
    }

    const headline = headlineFrom(row, body, raw);
    const snippet = snippetFrom(raw, headline);
    const picture = avatarOf(row);

    if (!card) {
      card = document.createElement('button');
      card.type = 'button';
      card.className = 'tpp-preview';
      card.dataset.tppUi = 'preview';
      card.innerHTML =
        '<span class="tpp-preview-avatar"></span>' +
        '<span class="tpp-preview-main">' +
        '<span class="tpp-preview-meta">' +
        '<span class="tpp-preview-name"></span>' +
        '<span class="tpp-preview-time"></span>' +
        '</span>' +
        '<span class="tpp-preview-subject"></span>' +
        '<span class="tpp-preview-snippet"></span>' +
        '</span>' +
        '<span class="tpp-preview-open" aria-hidden="true">' +
        CHEVRON_SVG +
        '</span>';
      card.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const live = event.currentTarget.closest('.tpp-post');
        if (!live || !live.dataset.tppId) return;
        const opening = !unfolded.has(live.dataset.tppId);
        toggleUnfold(live);
        // The card is our control, not a message: the post gets the click that
        // opened it, so Teams makes it the message the keyboard acts on.
        if (opening) activatePost(live);
      });
      row.append(card);
    }

    card.dataset.tppSig = signature;
    row.dataset.tppCardOf = signature;
    const slot = card.querySelector('.tpp-preview-avatar');
    slot.textContent = '';
    if (picture) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = picture;
      slot.append(img);
    } else {
      slot.textContent = initialsOf(author);
    }

    card.querySelector('.tpp-preview-name').textContent = author || 'Someone';
    const timeSlot = card.querySelector('.tpp-preview-time');
    timeSlot.textContent = time;
    timeSlot.hidden = !time;
    card.querySelector('.tpp-preview-subject').textContent =
      headline || 'No text in this post';
    const snippetSlot = card.querySelector('.tpp-preview-snippet');
    snippetSlot.textContent = snippet;
    snippetSlot.hidden = !snippet;
    row.classList.add('tpp-previewed');
  }

  /**
   * Marks what a folded post does not show: the reply thread, reactions, Teams'
   * hover toolbar, a reply box — everything below the row that is neither the
   * header line nor the text itself.
   *
   * Only the branches that lead to the header and the body are kept; each other
   * branch is marked once at its top, so one rule (teams.css) hides the whole
   * subtree until the post is opened. Teams replaces these nodes freely, so the
   * next scan marks the new ones; a stale mark on a node nobody reads is inert.
   */
  function markDetails(row) {
    const head = row.querySelector('.tpp-head');
    const body = row.querySelector('.tpp-body');
    if (!head || !body) return;
    // One inside the other leaves no boundary to hide at: leave the post whole.
    if (head.contains(body) || body.contains(head)) return;

    const markIn = (node) => {
      for (const child of Array.from(node.children)) {
        if (child === head || child === body) continue;
        // Our own rail is painted in the post's margin, not part of it.
        if (child.hasAttribute('data-tpp-ui')) continue;
        if (child.contains(head) || child.contains(body)) {
          markIn(child);
          continue;
        }
        if (!child.classList.contains('tpp-detail')) child.classList.add('tpp-detail');
      }
    };
    // From the row down: the branches that lead to the header or the text are
    // kept, so an avatar column or a reply thread at either level is a detail.
    markIn(row);
  }

  // --------------------------------------------------------------- helpers

  function first(selectors, root) {
    const scope = root || document;
    for (const selector of selectors || []) {
      let found = null;
      try {
        found = scope.querySelector(selector);
      } catch (_) {
        continue; // A bad selector from a hand edit should not stop the rest.
      }
      if (found) return found;
    }
    return null;
  }

  function collapse(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function hash(input) {
    let value = 5381;
    for (let i = 0; i < input.length; i += 1) {
      value = ((value << 5) + value) ^ input.charCodeAt(i);
    }
    return (value >>> 0).toString(36);
  }

  /**
   * Whether a CSS colour reads as dark, or null when there is no colour to judge
   * (transparent, or a form this does not parse). Wide-gamut `color(srgb …)` is
   * converted, so it gives the same answer as `rgb(…)`.
   */
  function isDarkColor(color) {
    const text = String(color || '');
    let r;
    let g;
    let b;
    let alpha = 1;

    const rgb = /rgba?\(([^)]+)\)/.exec(text);
    if (rgb) {
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      r = parts[0];
      g = parts[1];
      b = parts[2];
      if (parts.length > 3) alpha = parts[3];
    } else {
      const wide = /color\(srgb\s+([^)]+)\)/.exec(text);
      if (!wide) return null;
      const parts = wide[1].split(/[\s/]+/).filter(Boolean).map(Number);
      if (parts.length < 3) return null;
      r = parts[0] * 255;
      g = parts[1] * 255;
      b = parts[2] * 255;
      if (parts.length > 3) alpha = parts[3];
    }

    if (![r, g, b].every(Number.isFinite) || !Number.isFinite(alpha)) return null;
    if (alpha === 0) return null;
    // Rec. 709 luma: how bright the colour looks, not how bright its channels are.
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }

  /** A theme name Teams itself has written onto <html> or <body>. */
  function themeFromMarkup() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      for (const name of THEME_HINTS) {
        const value = String(el.getAttribute(name) || '').toLowerCase();
        if (!value) continue;
        if (value.includes('dark')) return 'dark';
        if (value.includes('light')) return 'light';
      }
      const classes = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      if (/(^|[\s_-])dark([\s_-]|$)/.test(classes)) return 'dark';
      if (/(^|[\s_-])light([\s_-]|$)/.test(classes)) return 'light';
    }
    return '';
  }

  /**
   * The theme read off the surface the posts sit on: the message list, then its
   * ancestors, until something is actually painted. That is the colour the user
   * sees behind a post, so it is right whatever Teams names its theme.
   */
  function themeFromSurface() {
    const start = lastList || findMessageList() || document.body;
    for (let node = start; node; node = node.parentElement) {
      const dark = isDarkColor(getComputedStyle(node).backgroundColor);
      if (dark !== null) return dark ? 'dark' : 'light';
    }
    return '';
  }

  function prefersDark() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (_) {
      return false;
    }
  }

  /**
   * Light or dark, asked in the order that answers most truthfully:
   *
   *   1. a theme attribute or class Teams leaves on <html>/<body>,
   *   2. the painted background behind the posts,
   *   3. the operating system's setting.
   *
   * The OS is last on purpose: Teams can be dark on a light desktop, and the
   * card should match Teams, not the desktop.
   */
  function detectTheme() {
    return themeFromMarkup() || themeFromSurface() || (prefersDark() ? 'dark' : 'light');
  }

  /**
   * Publishes the theme for the stylesheet, which hangs its light and dark
   * palettes off `data-tpp-theme` on <html>. Nothing is written unless it
   * changed, so following a switch costs one string compare.
   */
  function applyTheme() {
    const html = document.documentElement;
    if (!html) return;
    const theme = detectTheme();
    if (html.getAttribute(THEME_ATTR) !== theme) html.setAttribute(THEME_ATTR, theme);
  }

  /**
   * The scan's version of applyTheme, rate-limited.
   *
   * A real theme change arrives through the attribute observer, which calls
   * applyTheme at once; this is the safety net for a Teams build that paints a
   * surface after mounting, and it does not need to look several times a second.
   */
  function applyThemeIfDue() {
    const now = Date.now();
    if (now - themeAt < 1500) return;
    themeAt = now;
    applyTheme();
  }

  function isScrollable(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const overflow = getComputedStyle(el).overflowY;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    return el.scrollHeight > el.clientHeight + 40;
  }

  function findMessageList() {
    let fallback = null;
    for (const selector of S.messageList || []) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (_) {
        continue; // A bad selector from a hand edit should not stop the rest.
      }
      // The last-resort `div[role="log"]` anchor also matches the aria-live
      // region Teams keeps beside a message editor. A candidate inside a
      // compose field is never the list.
      if (!found || isComposeField(found)) continue;
      // Teams keeps the channel before this one mounted for a moment during a
      // switch. A list with no box is that leftover; the one on screen is the
      // list this scan is for.
      if (found.getClientRects().length) return found;
      if (!fallback) fallback = found;
    }
    if (fallback) return fallback;

    // Markup changed: climb from a known row to whatever actually scrolls.
    const row = first(S.messageRow);
    for (let node = row; node && node !== document.body; node = node.parentElement) {
      if (isScrollable(node)) return node;
    }
    return null;
  }

  /** True inside Teams' message editor, whose live regions look like a list. */
  function isComposeField(el) {
    return Boolean(
      el.closest(
        '[data-shortcut-context="compose-field"], [contenteditable="true"], editor-aria-handler, [data-tid="ckeditor"]'
      )
    );
  }

  /**
   * Is the user writing — or sending — a post?
   *
   * Teams' composer is a React tree of its own: clicking Post sends whatever
   * that tree holds. Nothing of ours has any business running over the page
   * while it is in use. A scan re-pads and re-measures the message list, moves
   * its scroll and rewrites attributes on the rows around the composer, and a
   * draft that quietly fails to send is the worst thing this extension could
   * do — so everything of ours stands still until the composer is gone, and
   * picks up again on the scan Teams' own re-render then triggers.
   *
   * Two signals are used, and both are needed. Focus covers someone typing. A
   * draft with words in it still covers the moment of the click that sends it:
   * mousedown takes the focus off the editor before Teams reads it, so a
   * focus-only test would hand the page back exactly when the post is going
   * out. The collapsed "Post in channel" box is furniture Teams keeps in the
   * page and is not counted, or the extension would never run at all.
   */
  function composerOpen() {
    // Every mutation batch asks this, and `getClientRects` forces layout: one
    // probe serves the burst of renders that follows a keystroke.
    const now = Date.now();
    if (now - composerProbeAt < 200) return composerProbeValue;
    composerProbeAt = now;
    composerProbeValue = composerOpenNow();
    return composerProbeValue;
  }

  function composerOpenNow() {
    const active = document.activeElement;
    if (active && active !== document.body && isComposeField(active)) return true;

    let fields = [];
    try {
      fields = document.querySelectorAll(
        '[data-shortcut-context="compose-field"], [data-tid="ckeditor"]'
      );
    } catch (_) {
      return false; // A hand-edited selector should never cost us the page.
    }

    for (const field of fields) {
      // Not painted, not in use; and a *-collapsed box (Teams' own "Post in
      // channel" furniture) is furniture, not a draft.
      if (!field.getClientRects().length) continue;
      if (field.closest('[data-tid*="collapsed" i]')) continue;
      if (collapse(field.innerText || field.textContent || '')) return true;
    }
    return false;
  }

  // --------------------------------------------------------- reading posts

  /**
   * The first id-ish attribute Teams puts on a post. Falls back to a hash of
   * the content so an archive survives a reload even when Teams exposes no id.
   */
  function idFor(row, text) {
    const names = ['data-mid', 'data-message-id', 'data-item-id'];
    for (const name of names) {
      const value = row.getAttribute(name);
      if (value) return value;
    }

    const inner = row.querySelector('[data-mid], [data-message-id], [data-item-id]');
    if (inner) {
      for (const name of names) {
        const value = inner.getAttribute(name);
        if (value) return value;
      }
    }

    // New Teams: the author and content carry the message id as a suffix, e.g.
    // id="author-1793472227903". That suffix is stable across reloads.
    const tagged = row.querySelector('[id^="author-"], [id^="content-"], [id^="timestamp-"]');
    if (tagged && tagged.id) return 'm:' + tagged.id.replace(/^[a-z]+-/, '');

    const time = row.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    return 'h:' + hash(`${text}|${time}`);
  }

  /**
   * Milliseconds Teams stamps into its own post ids (`author-1793472227903`),
   * falling back to the timestamp element. This is the clock the read model
   * runs on: a post stamped after `since` is unread.
   */
  function timeOf(id, row) {
    const numeric = /^m:(\d{10,})$/.exec(id || '');
    if (numeric) return Number(numeric[1]);
    if (!row) return 0;

    // Teams' own id can be a GUID on some builds, but the stamp is still in the
    // page: the author, body and timestamp elements are suffixed with it
    // (`id="timestamp-1793472227903"`). Without this, every post looked
    // undated, and the archive button had to guess which side was older.
    const tagged = row.querySelector(
      '[id^="timestamp-"], [id^="author-"], [id^="content-"]'
    );
    const suffix = tagged && tagged.id ? /(\d{10,})$/.exec(tagged.id) : null;
    if (suffix) return Number(suffix[1]);

    const stamp = row.querySelector('time[datetime]')?.getAttribute('datetime');
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * The date and time printed on a folded post's card — "10-24 8:54 p.m." —
   * read as a timestamp. This is the reading the user can see, and the one the
   * archive button is asked to compare, so it is read tolerantly: a comma after
   * the date, a full or two-digit year, and 24-hour times are all accepted.
   */
  function previewTimeOf(row) {
    const el = row?.querySelector('[data-tpp-ui="preview"] .tpp-preview-time');
    const text = collapse(el ? el.textContent : '');
    const parts = /(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?/i.exec(
      text
    );
    if (!parts) return 0;

    const now = new Date();
    let year = parts[3] ? Number(parts[3]) : now.getFullYear();
    if (year < 100) year += 2000;

    let hour = Number(parts[4]);
    const suffix = (parts[7] || '').toLowerCase();
    if (suffix === 'p' && hour < 12) hour += 12;
    else if (suffix === 'a' && hour === 12) hour = 0;

    let date = new Date(
      year,
      Number(parts[1]) - 1,
      Number(parts[2]),
      hour,
      Number(parts[5]),
      Number(parts[6] || 0)
    );
    // No year on the card: a date further ahead than tomorrow is last year's.
    if (!parts[3] && date.getTime() > now.getTime() + 86400000) {
      date = new Date(date.setFullYear(date.getFullYear() - 1));
    }
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
  }

  /** The post a control belongs to, read at click time so it is never stale. */
  function postIdOf(el) {
    const row = el && el.closest ? el.closest('.tpp-post') : null;
    return row ? row.dataset.tppId : '';
  }

  function previewOf(row) {
    const body = first(S.messageBody, row);
    // Read straight from the post's own body. This used to be read from a deep
    // clone with our nodes stripped out — one copy of every post, on every
    // scan — and our nodes live on the row beside the body, not in it.
    if (body) return collapse(body.textContent || '').slice(0, 220);

    // No body element: the row itself is the text, minus anything of ours.
    const clone = row.cloneNode(true);
    for (const injected of clone.querySelectorAll('[data-tpp-ui], .tpp-post-actions')) {
      injected.remove();
    }
    return collapse(clone.textContent || '').slice(0, 220);
  }

  function authorOf(row) {
    const el = first(S.messageAuthor, row);
    return el ? collapse(el.textContent || '').slice(0, 60) : '';
  }

  /**
   * Teams' "N replies" count, or -1 when the post prints no count at all.
   *
   * The count is the one part of a thread Teams shows on the post without its
   * replies being rendered, which is what makes it useful for spotting new
   * activity in the Archive. It is read from the footer/count anchor rather
   * than the whole row: a post can hold a long thread, and walking all of it on
   * every scan is exactly the cost this scan avoids elsewhere.
   */
  function replyCountOf(row) {
    const el = first(S.replyCount, row);
    const match = /(\d[\d,]*)\s+repl(?:y|ies)\b/i.exec(el ? el.textContent || '' : '');
    return match ? Number(match[1].replace(/,/g, '')) : -1;
  }

  /**
   * Teams' own New badge on a post, as a short string, or '' when it shows none.
   *
   * This is the read state the user already reads in Teams, so it is honoured
   * beside the install clock: a post it flags belongs in the Inbox until the
   * Archive button files it. Only the badge itself is read — a short "New" or
   * "Unread" label. A menu item ("Mark as unread") and anything of ours are
   * ignored, because opening a post's menu must not reopen the post.
   */
  function newMarkerOf(row) {
    if (!row) return '';
    for (const selector of S.unreadMarker || []) {
      let found = [];
      try {
        found = Array.from(row.querySelectorAll(selector));
      } catch (_) {
        continue; // A hand-edited selector should never cost us the row.
      }
      for (const el of found) {
        if (el.closest('[data-tpp-ui]')) continue;
        if (
          el.closest(
            '[role="menu"], [role="menuitem"], [data-tid*="menu" i], [data-tid*="contextual" i]'
          )
        ) {
          continue;
        }
        const text = collapse(el.textContent || '');
        const label = collapse(el.getAttribute('aria-label') || '');
        const words = text || label;
        if (!words) {
          // A dot with no words of its own: its data-tid is the badge's name,
          // which is enough when Teams draws the marker as a shape.
          const tid = el.getAttribute('data-tid') || '';
          if (/unread|new-message-(?:badge|status)/i.test(tid)) return 'unread';
          continue;
        }
        if (
          /^(?:\d+\s*)?(?:new|unread)(?:\s+(?:activity|post|reply|replies|message|messages|items?))?$/i.test(
            words
          )
        ) {
          return words.toLowerCase();
        }
      }
    }
    return '';
  }

  /** The reactions on a post, as a stable fingerprint of their labels and counts. */
  function reactionsOf(row) {
    const seen = [];
    try {
      for (const el of row.querySelectorAll(
        '[data-tid*="reaction" i], [aria-label*="reaction" i]'
      )) {
        if (el.closest('[data-tpp-ui]')) continue;
        const label = collapse(el.getAttribute('aria-label') || '');
        const text = collapse(el.textContent || '').slice(0, 40);
        // A reaction chip shows its count. Teams' "Add reaction" button has no
        // number, and it comes and goes with hover — counting it would reopen a
        // post just because the pointer crossed it.
        if (!/\d/.test(`${label} ${text}`)) continue;
        seen.push(`${label}:${text}`);
      }
    } catch (_) {
      // No reaction markup in this build: an empty fingerprint is still stable.
    }
    return hash(seen.join('|'));
  }

  /** How many attachments, images or GIFs the post carries. */
  function attachmentCountOf(row) {
    try {
      return row.querySelectorAll(
        '[data-tid*="attachment" i], [data-tid*="image" i], [data-tid*="gif" i]'
      ).length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * One string describing a post as it stands: its reply count, reactions,
   * attachments and own words. Two equal fingerprints mean nothing has
   * happened to the post; a different one means it has moved on.
   */
  function activityOf(row, text) {
    if (!row) return '';
    const words = text === undefined ? previewOf(row) : text;
    return [
      replyCountOf(row),
      reactionsOf(row),
      attachmentCountOf(row),
      hash(words || '')
    ].join('|');
  }

  /** Keeps only well-formed fingerprints, newest last, under the cap. */
  function normalizeActivity(stored) {
    if (!stored || typeof stored !== 'object') return {};
    const entries = Object.entries(stored).filter(
      ([id, signature]) =>
        typeof id === 'string' && id.length > 0 && typeof signature === 'string' && signature
    );
    return Object.fromEntries(entries.slice(-ACTIVITY_LIMIT));
  }

  function saveActivitySoon() {
    clearTimeout(activitySaveTimer);
    activitySaveTimer = setTimeout(() => {
      activitySaveTimer = 0;
      persistActivity();
    }, 300);
  }

  function persistActivity() {
    const entries = Object.entries(activityState);
    if (entries.length > ACTIVITY_LIMIT) {
      activityState = Object.fromEntries(entries.slice(-ACTIVITY_LIMIT));
    }
    try {
      chrome.storage.local.set({ [ACTIVITY_KEY]: activityState }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // The extension was reloaded while this page stayed open.
    }
  }

  /**
   * Has a read post moved on since it was filed?
   *
   * Teams gives a post no activity timestamp, so the post itself is
   * fingerprinted. The fingerprint is taken the first time a post is seen as
   * read (and again at the moment it is archived) and compared here. A
   * different one means someone replied, reacted, attached something or edited
   * the post — and a post with news in it does not belong in the Archive.
   */
  function archivedChanged(id, row, text) {
    if (!id || !features || !features.inboxZero) return false;
    // Only a post whose body Teams has actually drawn is comparable: a row that
    // is still arriving has a header but no words, and taking that as "changed"
    // would reopen every post that finished rendering.
    if (!first(S.messageBody, row)) return false;
    const current = activityOf(row, text);
    if (!current) return false;
    const seen = activityState[id];
    if (seen === undefined) {
      activityState[id] = current;
      saveActivitySoon();
      return false;
    }
    if (seen === current) return false;
    delete activityState[id];
    saveActivitySoon();
    return true;
  }

  function isComment(row) {
    for (const selector of S.commentRoot || []) {
      try {
        if (row.parentElement && row.parentElement.closest(selector)) return true;
        if (row.matches(selector)) return true;
      } catch (_) {
        continue;
      }
    }
    return false;
  }

  /**
   * A post Teams has drawn in one of its own message panes rather than in the
   * Posts list: the view a channel search opens, a pinned-message pane, a
   * message's reply thread.
   *
   * Those panes render their own copy of a post, and Teams re-renders that copy
   * freely. Our marks are not safe there: a post is hidden until its card is on
   * it (so the full post is never seen turning into a card), and a re-rendered
   * copy arrives without a card — so the found post went out of sight and only
   * the replies beside it, which are not ours to mark, could be seen. Nothing of
   * ours goes on a pane: the post is left exactly as Teams drew it.
   */
  function inTeamsPane(row) {
    if (!row || !row.closest) return false;
    const panes = `${TEAMS_PANE_SELECTOR}, [role="dialog"], [data-tid*="pinned-messages" i]`;
    try {
      if (row.closest(panes)) return true;
      // The marker can also sit on the row's own content rather than on an
      // ancestor: Teams wraps the message pane in a container of its own.
      return Boolean(row.querySelector(panes));
    } catch (_) {
      return false; // A hand-edited selector should never cost us the row.
    }
  }

  /**
   * Is Teams showing one post in a pane of its own, rather than the Posts list?
   *
   * "Find in channel" opens its result in a pane with a "Go to channel" header
   * and no tab strip above it. That is Teams' view of a single post, not the
   * Inbox or the Archive: the filter would close up the very post being shown,
   * and the tab pair would be left floating over an empty message area. Such a
   * pane is only counted when it is on screen and big enough to be a view — a
   * hidden copy Teams keeps around is not one.
   */
  function teamsPostPane() {
    // Asked from the mutation callback and from every scan. Three substring
    // selectors over a live Teams page is not free, and nothing changes in the
    // space of a few frames, so the answer is kept for a moment.
    const now = Date.now();
    if (now - paneProbeAt < 200) return paneProbeValue;
    paneProbeAt = now;
    paneProbeValue = teamsPostPaneNow();
    return paneProbeValue;
  }

  function teamsPostPaneNow() {
    let found = [];
    try {
      found = Array.from(document.querySelectorAll(TEAMS_PANE_SELECTOR));
    } catch (_) {
      return false; // A hand-edited selector should never cost us the page.
    }

    for (const el of found) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 60) continue;
      return true;
    }
    return false;
  }

  /**
   * Every outermost message row inside `root`. Nested matches (a message body
   * inside its own row) are dropped so one post is never handled twice, and
   * comments/replies are skipped so they never get controls.
   */
  /**
   * Teams' post container has no stable attribute of its own: the only reliable
   * marker is the `post-message-subheader` inside it, which appears once per
   * post. Climbing from that marker until an ancestor holds a second subheader
   * gives the container that wraps exactly this post.
   */
  function headerRows(root) {
    const marker = S.postHeader[0];
    let headers = [];
    try {
      headers = Array.from(root.querySelectorAll(marker));
    } catch (_) {
      return [];
    }
    if (!headers.length) return [];

    // How many headers each ancestor holds, counted once in a single pass.
    // Asking the DOM this for every ancestor of every post made one scan cost
    // more than Teams' own render of the list.
    const counts = new Map();
    for (const header of headers) {
      for (let node = header.parentElement; node && node !== root; node = node.parentElement) {
        counts.set(node, (counts.get(node) || 0) + 1);
      }
    }

    const rows = [];
    const seen = new Set();
    for (const header of headers) {
      let row = null;
      for (let node = header.parentElement; node && node !== root; node = node.parentElement) {
        if ((counts.get(node) || 0) > 1) break;
        row = node;
      }
      // Degenerate markup with no wrapper of its own: still give the post a row.
      if (!row) row = header.parentElement;
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  function collectRows(root, allowDialog) {
    const candidates = new Set(headerRows(root));
    // The wide row query matches every post body as well as every post, and
    // those hits are then thrown away as nested. It is only worth running when
    // the headers gave us nothing.
    if (!candidates.size) {
      try {
        for (const el of root.querySelectorAll(S.messageRow.join(','))) candidates.add(el);
      } catch (_) {
        // A bad selector from a hand edit should not cost us the header rows.
      }
    }

    return Array.from(candidates).filter((el) => {
      for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (candidates.has(parent)) return false;
      }
      if (el.closest('.tpp-post-actions, .tpp-empty-state, .tpp-tabs')) return false;
      if (!allowDialog && el.closest('[role="dialog"]')) return false;
      if (isComment(el)) return false;
      return true;
    });
  }

  function rebuildRows(list) {
    const next = new Map();

    for (const row of collectRows(list, false)) {
      // A post Teams is drawing in one of its own panes — the view a channel
      // search opens — is left exactly as Teams drew it: not folded into a card,
      // not filtered, and not hidden until a card that Teams would drop again.
      if (inTeamsPane(row)) {
        clearPostUi(row);
        continue;
      }

      // An image-only post still counts: its header text keeps it identifiable.
      const text = previewOf(row) || collapse(row.textContent || '').slice(0, 160);
      if (!text) {
        // Not a post any more (a placeholder, or a node Teams emptied): it
        // keeps no controls, and no card can be left behind on it.
        clearPostUi(row);
        continue;
      }

      const id = idFor(row, text);
      if (row.dataset.tppId !== id) {
        row.dataset.tppId = id;
        // A recycled node: rebuild its controls for the post it now holds, and
        // keep it hidden until the new card is painted.
        delete row.dataset.tppPainted;
        delete row.dataset.tppTs;
        row.classList.remove('tpp-ready');
      }
      row.classList.add('tpp-post');

      const authored = authorOf(row);

      // The whole model: a read post is tagged, an unread one is not. The stamp
      // is read once here and kept on the row: every later question about this
      // post (filtering, tucking, the scroll limit) reuses it instead of asking
      // the DOM again, which was several selectors per post on every scan.
      const ts = timeOf(id, row);
      row.dataset.tppTs = String(ts || 0);
      const marker = newMarkerOf(row);
      let isRead = isReadPost(id, ts);

      // Teams' own New badge, read beside the clock. A badge that was not
      // showing when the post was filed means something arrived after it, so
      // the post goes back to the Inbox; the badge it was filed with is the one
      // the user chose to leave behind and is not news. An unread post that
      // carries a badge is written down, so it stays in the Inbox once Teams
      // clears the badge on open rather than dropping into the Archive.
      if (!isRead) {
        if (marker) latchUnread(id);
      } else if (marker) {
        const filed = readState[id];
        if (!filed || filed.m !== marker) {
          remember(id, false);
          saveReadSoon();
          isRead = false;
        }
      } else if (readState[id] && readState[id].m) {
        // The badge it was filed with has cleared: a later one is news again.
        delete readState[id].m;
        saveReadSoon();
      }

      // Filing a post is not permission to miss the answer to it: one whose
      // replies, reactions, attachments or words moved on is back in the Inbox.
      if (isRead && archivedChanged(id, row, text)) {
        remember(id, false);
        saveReadSoon();
        isRead = false;
      }
      setTag(row, isRead ? 'read' : '');
      paintRow(row);
      next.set(id, {
        row,
        id,
        text,
        author: authored,
        read: row.dataset.tppTag === 'read',
        ts      });
    }

    rowsById = next;
    applyViewFiltering();
  }

  /** When Teams stamped a post, in ms, or 0 when it prints nothing readable. */
  function stampOf(row) {
    if (!row) return 0;
    const cached = row.dataset.tppTs;
    if (cached !== undefined) return Number(cached) || 0;
    const ts = timeOf(row.dataset.tppId, row);
    row.dataset.tppTs = String(ts || 0);
    return ts;
  }

  /**
   * Read or unread.
   *
   * The user's own decision wins when there is one. Otherwise a post is unread
   * when Teams stamped it after the extension was installed: everything already
   * in the channel at install is read, and anything posted since is waiting in
   * the Inbox until the Archive button files it. Nothing is written for that
   * second case, so a channel's whole history costs no storage — and there is no
   * badge or divider to misread, which is what swept a channel into the Inbox
   * before.
   */
  function isReadPost(id, ts) {
    const entry = id ? readState[id] : null;
    if (entry) return entry.r !== 0;
    return !(since > 0 && ts > since);
  }

  /**
   * Writes a post Teams flags as New into the Inbox, and keeps it there.
   *
   * Teams clears the badge when the channel is opened, so trusting the badge
   * alone would drop the post back into the Archive before the user reached it.
   * The first sighting is written down as an unread decision — `n` marks it as
   * Teams' own flag rather than a click — and only the Archive button changes
   * it after that.
   */
  function latchUnread(id) {
    if (!id) return false;
    const entry = readState[id];
    if (entry && entry.r === 0) return false;
    delete readState[id];
    readState[id] = { t: Date.now(), r: 0, n: 1 };
    saveReadSoon();
    return true;
  }

  /**
   * Closes a post the current view filters out, and opens one it shows.
   *
   * Nothing is measured and nothing is compensated here: a filtered post takes
   * no room, and the posts on show sit together with no holes between them. The
   * list keeps its own height in the stylesheet (`min-height` in teams.css), so
   * Teams still sees a real list when the view shows little — which is what
   * stops it paging the channel's history in — while the geometry the scan has
   * to maintain stays exactly one attribute per row.
   */
  function markTucked(row, id) {
    // The post opened in its panel is not part of the list's flow: nothing there
    // is filtered out, and collapsing it would close the panel.
    if (row.dataset.tppModal === '1') return;

    // Only a search result is exempt from the filter. Focus is not: the post
    // the user opened holds focus (that is what makes Teams' shortcuts act on
    // it), and counting that as a spotlight kept it — with its body, images and
    // attachments — on screen after switching to the tab that filters it out.
    const filtered =
      Boolean(id) &&
      features &&
      features.inboxZero &&
      !isHighlighted(row) &&
      (view === VIEW_ARCHIVES ? !isReadPost(id, stampOf(row)) : isReadPost(id, stampOf(row)));

    if (filtered) {
      if (row.dataset.tppTucked !== '1') row.dataset.tppTucked = '1';
    } else if (row.dataset.tppTucked !== undefined) {
      delete row.dataset.tppTucked;
    }
  }

  /**
   * Keeps the tag on every post in the page in step with the read map — not
   * just this scan's rows, because Teams keeps stale nodes around while it
   * virtualises. Which of the two views a post appears in is then plain CSS on
   * that tag (teams.css), so no inline display has to be maintained here.
   */
  function applyViewFiltering() {
    const rows = [];
    let anyRead = false;
    let anyShown = false;
    // Scoped to the list: `.tpp-post` only ever goes on a row found there, so a
    // document-wide query on every scan was the same walk over Teams' whole tree
    // for nothing.
    const scope = lastList && lastList.isConnected ? lastList : document;

    for (const row of scope.querySelectorAll('.tpp-post')) {
      // A node this scan does not know as a post — a recycled wrapper, a copy
      // Teams left behind — keeps no controls: a rail of its own would float in
      // the list with no post under it, which is how a lone Archive button
      // appeared in the middle of an empty Archive.
      const record = row.dataset.tppId ? rowsById.get(row.dataset.tppId) : null;
      if (inTeamsPane(row) || (record ? record.row !== row : row.dataset.tppModal !== '1')) {
        clearPostUi(row);
        continue;
      }

      const isRead =
        Boolean(row.dataset.tppId) && isReadPost(row.dataset.tppId, stampOf(row));
      if (view === VIEW_ARCHIVES ? isRead : !isRead) anyShown = true;
      if (isRead) anyRead = true;
      rows.push({ row, isRead });
    }

    // A view with nothing on show is not a filtered list at all: collapsing every
    // post to nothing and leaving the list to explain itself is what made Teams
    // re-measure an empty pane on a loop. The posts are left exactly as Teams
    // laid them out and the list itself goes out of sight (teams.css).
    const empty = rows.length > 0 && !anyShown;
    publishEmptyView(empty);
    markRoom(!empty);

    for (const { row, isRead } of rows) {
      setTag(row, isRead ? 'read' : '');
      if (empty) untuck(row);
      else markTucked(row, row.dataset.tppId);
      paintRow(row);
    }

    publishArchivePresence(anyRead);
  }

  /**
   * The box whose height Teams measures to decide it has reached the end of a
   * channel.
   *
   * It is not the scrolling element. Teams scrolls `channel-pane-viewport`, but
   * the height that decides whether more of the channel is fetched is the chain
   * of boxes around the rows (`channel-pane-runway` and its wrappers). Padding
   * written on the scroller gave it a scrollbar while the posts still measured
   * one row tall — and Teams went on paging the whole history into the Inbox two
   * seconds at a time. So the room goes on the innermost element that holds the
   * rows and still sits inside the list.
   */
  function roomTarget(list) {
    if (!list) return null;
    const rows = list.querySelectorAll('.tpp-post');
    if (!rows.length) return null;

    // The row container is the nearest ancestor that holds more than one post:
    // a per-row wrapper holds one, the runway holds them all. The end of that
    // element is the end of the list, so that is where the room has to grow —
    // padding on an ancestor sits below its end and moves nothing.
    const first = rows[0];
    let node = first;
    while (node.parentElement && node.parentElement !== list) {
      node = node.parentElement;
      if (node.querySelectorAll('.tpp-post').length > 1) break;
    }

    // A row sitting straight in the list, or a climb that ran out of boxes: there
    // is nothing to give the room to — and padding a post's own row would leave a
    // blank card on screen.
    if (node === list || node === first || node === document.body) return null;
    return node;
  }

  /**
   * Puts the room that stands in for the hidden posts after the rows, or takes it
   * away again. It is one attribute on one element, so nothing is measured and
   * nothing is recomputed as the list re-renders.
   */
  function markRoom(show) {
    const target = show && features && features.inboxZero ? roomTarget(lastList) : null;

    if (roomEl && roomEl !== target) {
      if (roomEl.dataset.tppRoom !== undefined) delete roomEl.dataset.tppRoom;
      roomEl.style.removeProperty('--tpp-room');
    }
    roomEl = null;

    if (!target) return;
    if (target.dataset.tppRoom !== '1') target.dataset.tppRoom = '1';
    roomEl = target;
  }

  /** Publishes that the current view has no post on show, for the stylesheet. */
  function publishEmptyView(empty) {
    const html = document.documentElement;
    if (!html) return;
    if (empty && features && channelMode && features.inboxZero) {
      if (!html.hasAttribute(EMPTY_VIEW_ATTR)) html.setAttribute(EMPTY_VIEW_ATTR, '');
    } else if (html.hasAttribute(EMPTY_VIEW_ATTR)) {
      html.removeAttribute(EMPTY_VIEW_ATTR);
    }
  }

  /** Opens a post back up, for a view that is not filtering anything. */
  function untuck(row) {
    if (row.dataset.tppTucked !== undefined) delete row.dataset.tppTucked;
  }

  /** Takes our own controls and marks off a row that is no longer a post. */
  function clearPostUi(row) {
    row.classList.remove('tpp-post', 'tpp-unfold', 'tpp-previewed', 'tpp-ready');
    delete row.dataset.tppPainted;
    delete row.dataset.tppCardOf;
    delete row.dataset.tppTs;
    // A row we made focusable for a moment gives the attribute back.
    if (row.dataset.tppTabindex === '1') {
      row.removeAttribute('tabindex');
      delete row.dataset.tppTabindex;
    }
    // The collapse is ours too: a row Teams has since reused for one of its own
    // panes must not keep a height of zero from an earlier pass over the list.
    untuck(row);
    if (row.dataset.tppTag !== undefined) delete row.dataset.tppTag;
    for (const el of row.querySelectorAll('[data-tpp-ui]')) el.remove();
  }

  /**
   * Publishes whether this channel has a read post at all, for the stylesheet.
   * The Archives view only takes the unread posts out of the layout once there
   * is a read post to show (teams.css). Emptying a
   * virtualised message list leaves it with no height, so it decides it has
   * been scrolled to the end and fetches the rest of the channel's history in
   * batch after batch — which is what made a long channel page through every
   * old post, and the tab counts climb and fall while it did.
   */
  function publishArchivePresence(anyRead) {
    const html = document.documentElement;
    if (!html) return;
    if (features && channelMode && features.inboxZero && anyRead) {
      if (!html.hasAttribute(HAS_ARCHIVES_ATTR)) html.setAttribute(HAS_ARCHIVES_ATTR, '');
    } else if (html.hasAttribute(HAS_ARCHIVES_ATTR)) {
      html.removeAttribute(HAS_ARCHIVES_ATTR);
    }
  }

  /**
   * Writes the tag onto the post only when it changed, and removes it entirely
   * for an Inbox post. Assigning an attribute its current value still counts as
   * a mutation, and a mutation on every scan is what makes a virtualised list
   * look like it is reloading.
   */
  function setTag(row, tag) {
    if (tag) {
      if (row.dataset.tppTag !== tag) row.dataset.tppTag = tag;
    } else if (row.dataset.tppTag !== undefined) {
      delete row.dataset.tppTag;
    }
  }

  /**
   * Brings one post in line with its tag: its buttons, and the violet edge an
   * archived post carries in the Archives view. Nothing is written unless it
   * actually changed, so Teams' constant re-rendering cannot make the list
   * flash; which view shows it is decided by the tag in CSS alone.
   */
  function paintRow(row) {
    const tag = row.dataset.tppTag === 'read' ? 'read' : '';

    // The body is marked so the compact view can clamp it, and a post the user
    // has opened stays open across Teams re-renders.
    markBody(row);
    markHead(row);
    markDetails(row);
    // The folded card: who wrote it, the headline, and the first two lines.
    paintPreview(row);
    if (row.dataset.tppId && unfolded.has(row.dataset.tppId)) row.classList.add('tpp-unfold');
    else row.classList.remove('tpp-unfold');

    const painted = [tag, features.inboxZero ? '1' : '0', view].join('|');

    const railGone = features.inboxZero && !row.querySelector('.tpp-post-actions');
    if (row.dataset.tppPainted !== painted || railGone) {
      row.dataset.tppPainted = painted;
      injectActions(row, tag === 'read');
    }

    // The card is on the row: the post can be shown. teams.css keeps a folded
    // post hidden until this is set, which is what stops the full post being
    // painted first and then turning into the card.
    if (!row.classList.contains('tpp-ready')) row.classList.add('tpp-ready');
  }

  /**
   * Repaint one post the moment it is marked read or unread.
   *
   * The collapse is decided here as well as in the scan, because this is the
   * only moment the change is certainly known: a scan can be skipped while Teams
   * re-renders the list, and then a filed post would sit there as a hole with its
   * buttons still showing until something else happened to scan again.
   */
  function paintRead(id, isRead) {
    for (const row of document.querySelectorAll('.tpp-post')) {
      if (row.dataset.tppId !== id) continue;
      setTag(row, isRead ? 'read' : '');
      markTucked(row, row.dataset.tppId);
      paintRow(row);
    }
  }

  // ------------------------------------------------------------- row buttons

  function setButtonIcon(btn, kind, svg) {
    if (btn.dataset.tppIcon === kind) return;
    btn.dataset.tppIcon = kind;
    const slot = btn.querySelector('.tpp-post-btn-icon');
    if (slot) slot.innerHTML = svg;
  }

  /**
   * The Archive button sits in the left margin of the post and only appears
   * while the post is hovered or focused so the avatar stays clear.
   */
  function injectActions(row, isArchived) {
    let actions = row.querySelector('[data-tpp-ui="actions"]');

    if (!features.inboxZero) {
      actions?.remove();
      return;
    }

    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'tpp-post-actions';
      actions.dataset.tppUi = 'actions';
      row.append(actions);
    }

    let archiveBtn = actions.querySelector('.tpp-archive-btn');
    if (!archiveBtn) {
      archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className = 'tpp-post-btn tpp-archive-btn';
      archiveBtn.dataset.tppUi = 'archive';
      archiveBtn.innerHTML =
        '<span class="tpp-post-btn-icon"></span><span class="tpp-post-btn-label"></span>';
      archiveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Act on what the button shows, not on a lookup that a re-render may
        // have moved on from: a button saying Unarchive always unarchives.
        const target = event.currentTarget;
        setRead(
          postIdOf(target) || row.dataset.tppId,
          target.dataset.tppRead !== '1'
        );
      });
      actions.append(archiveBtn);
    }
    archiveBtn.hidden = !features.inboxZero;
    archiveBtn.disabled = false;
    // An archived post reads as archived: a white icon in a filled purple circle.
    setButtonIcon(
      archiveBtn,
      isArchived ? 'filled' : 'outline',
      isArchived ? ARCHIVE_FILLED_SVG : ARCHIVE_SVG
    );
    const archiveLabel = archiveBtn.querySelector('.tpp-post-btn-label');
    const archiveText = isArchived ? 'Unarchive' : 'Archive';
    if (archiveLabel.textContent !== archiveText) archiveLabel.textContent = archiveText;
    archiveBtn.dataset.tppRead = isArchived ? '1' : '0';
    archiveBtn.title = isArchived
      ? 'Unarchive this post and put it back in your Inbox'
      : 'Archive this post — it moves to your Archive';
    archiveBtn.setAttribute('aria-label', archiveBtn.title);
    archiveBtn.classList.toggle('is-on', isArchived);
  }

  function setRead(id, wantRead) {
    if (!id) return;

    // The post is about to be hidden (or shown again), so the message keeps
    // hold of where it was: the news belongs on the post itself.
    const where = anchorFor(id);

    if (wantRead) {
      // The tag is what hides a post, so it is written once the post has left:
      // one that disappears in the same frame reads as a glitch, not an archive.
      const row = findRow(id);
      const activity = row && first(S.messageBody, row) ? activityOf(row) : '';
      const marker = row ? newMarkerOf(row) : '';
      animateOut(row ? [row] : [], 'right', () => {
        remember(id, true, activity, marker);
        saveReadSoon();
        paintRead(id, true);
        scan();
        toast('Marked read — filed in your Archive.', where);
      });
      return;
    }

    // The other way round: the unread post is the one leaving this view, so it
    // slides left and fades, and the list closes up behind it.
    const row = findRow(id);
    animateOut(row ? [row] : [], 'left', () => {
      remember(id, false);
      saveReadSoon();
      paintRead(id, false);
      scan();
      toast('Marked unread — back in your Inbox.', where);
    });
  }

  /**
   * Writes one post's decision, newest last so trimming keeps the recent ones.
   * `c` marks a decision the user made by hand, which is what the repair in
   * bootstrap keeps: an entry without it was inferred by an older build.
   */
  function remember(id, isRead, activity, marker) {
    delete readState[id];
    readState[id] = { t: Date.now(), r: isRead ? 1 : 0, c: 1 };
    // The badge showing at the moment of filing: the same badge later is not
    // news, a different one is (see rebuildRows).
    if (isRead && marker) readState[id].m = marker;
    if (isRead) {
      // The post as it stands the moment it is filed: anything later is news.
      if (typeof activity === 'string' && activity) {
        activityState[id] = activity;
        saveActivitySoon();
      }
    } else {
      delete activityState[id];
    }
  }

  /**
   * A post leaving the list is not made to vanish: it slides and fades, so the
   * eye sees it go. Filing slides it right; unarchiving slides it left, the same
   * movement in reverse. `done` runs when the last one has left.
   */
  function animateOut(rows, direction, done) {
    const live = Array.from(rows).filter(
      (row) => row && row.isConnected && row.getClientRects().length
    );
    if (!live.length) {
      done();
      return;
    }

    const cls = direction === 'left' ? 'tpp-unarchiving' : 'tpp-archiving';

    live.forEach((row, index) => {
      row.classList.remove('tpp-archiving', 'tpp-unarchiving');
      row.style.setProperty('--tpp-archive-delay', `${Math.min(index, 6) * 30}ms`);
      // Restart the animation on a row that is already running one.
      void row.offsetWidth;
      row.classList.add(cls);
    });

    const total = ARCHIVE_ANIM_MS + Math.min(live.length - 1, 6) * 30;
    setTimeout(() => {
      for (const row of live) {
        row.classList.remove('tpp-archiving', 'tpp-unarchiving');
        row.style.removeProperty('--tpp-archive-delay');
      }
      done();
    }, total);
  }

  function pressElement(el, at = {}) {
    if (!el) return;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, ...at };
    const fire = (type, Ctor, extra) => {
      try {
        el.dispatchEvent(new Ctor(type, { ...base, ...extra }));
      } catch (_) {
        // A build without that event: the click below still goes.
      }
    };
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    if (typeof window.PointerEvent === 'function') {
      fire('pointerdown', window.PointerEvent, { ...pointer, button: 0, buttons: 1 });
      fire('pointerup', window.PointerEvent, { ...pointer, button: 0, buttons: 0 });
    }
    fire('mousedown', window.MouseEvent, { button: 0, buttons: 1, detail: 1 });
    fire('mouseup', window.MouseEvent, { button: 0, buttons: 0, detail: 1 });
    fire('click', window.MouseEvent, { button: 0, detail: 1 });
  }

  function applyLeftInset(list) {
    if (!list) return;
    if (list.dataset.tppLeftApplied !== '1') {
      list.dataset.tppLeftInline = list.style.paddingLeft || '';
      list.dataset.tppLeftBase = getComputedStyle(list).paddingLeft;
      list.dataset.tppGutterMarginInline = list.style.marginLeft || '';
      list.dataset.tppGutterMarginBase = getComputedStyle(list).marginLeft;
      list.dataset.tppLeftApplied = '1';
    }

    const padBase = parseFloat(list.dataset.tppLeftBase) || 0;
    const pad = Math.max(padBase, RAIL_GUTTER);
    const padding = `${pad}px`;
    if (list.style.paddingLeft !== padding) list.style.paddingLeft = padding;

    // Only pull the box left when the margin has a length to work with: an auto
    // margin is doing the layout's centring and must be left alone. The pull
    // stops at the window's edge, since a gutter there would be off screen and
    // the buttons with it.
    const marginBase = parseFloat(list.dataset.tppGutterMarginBase);
    if (Number.isFinite(marginBase)) {
      const room = Math.max(list.getBoundingClientRect().left, 0);
      const pull = Math.min(pad - padBase, room);
      const margin = `${marginBase - pull}px`;
      if (list.style.marginLeft !== margin) list.style.marginLeft = margin;
    }
  }

  function clearLeftInset(list) {
    const target = list || lastList || findMessageList();
    if (!target || target.dataset.tppLeftApplied !== '1') return;
    target.style.paddingLeft = target.dataset.tppLeftInline || '';
    if (target.dataset.tppGutterMarginInline !== undefined) {
      target.style.marginLeft = target.dataset.tppGutterMarginInline;
    }
    delete target.dataset.tppLeftApplied;
    delete target.dataset.tppLeftInline;
    delete target.dataset.tppLeftBase;
    delete target.dataset.tppGutterMarginInline;
    delete target.dataset.tppGutterMarginBase;
  }

  function clearTopInset(list) {
    const target = list || lastList || findMessageList();
    if (!target || target.dataset.tppPadApplied !== '1') return;
    target.style.paddingTop = target.dataset.tppPadInline || '';
    delete target.dataset.tppPadApplied;
    delete target.dataset.tppPadInline;
    delete target.dataset.tppPadBase;
  }

  // ------------------------------------------------------------------- jump

  function findRow(id) {
    if (!id) return null;
    // Only posts: a pane's copy of a post carries the same id and is never the
    // post this scan filed.
    for (const el of document.querySelectorAll('.tpp-post[data-tpp-id]')) {
      if (el.dataset.tppId === id) return el;
    }
    return null;
  }

  /**
   * Where a post is right now, kept for a message about it. The row is held on
   * to so the message follows it while it is still on screen, and the box is
   * kept as it was for after the post has been hidden by its own status change.
   */
  function anchorFor(id) {
    const row = findRow(id);
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return { row, rect };
  }

  // -------------------------------------------------------------- Inbox/Archives

  /**
   * Both of our tabs are the Posts tab, filtered, so clicking one has to ask
   * Teams for the Posts panel first. After a visit to Shared, Calendar or any
   * other tab, the channel is showing that panel and its message list is gone —
   * without this, our tabs only changed a filter behind a panel nobody was
   * looking at, and the posts never came back.
   */
  function showPostsPanel() {
    const posts = nativePostsTab();
    if (!posts) return;
    if (posts.getAttribute('aria-selected') === 'true') return;
    try {
      posts.click();
    } catch (_) {
      // The tab is hidden from view; if a Teams build refuses a programmatic
      // click, the view still switches, which is all we can do from here.
    }
  }

  function setView(mode) {
    const next = normalizeView(mode);
    const changing = next !== view;

    // The pair answers the click at once; the scan below redraws the posts as
    // soon as Teams' own re-render lands.
    showPostsPanel();

    if (changing) {
      view = next;
      document.documentElement?.setAttribute('data-tpp-view', view);
      writeSync({ [VIEW_KEY]: view });
    }

    // A frame before the scan, so the tab pair's own paint lands first.
    window.requestAnimationFrame(() => apply());
  }

  function renderTabs() {
    const existing = document.getElementById(TABS_ID);
    const posts = features.inboxZero ? nativePostsTab() : null;

    // The pair only ever lives in Teams' own tab strip, standing in for the Posts
    // tab it is copied from. With no Posts tab there is nowhere for it to belong,
    // and the old floating fallback strip is gone for good: anything left over is
    // taken out rather than shown over the page.
    if (!features.inboxZero || !posts) {
      existing?.remove();
      releaseNativeTab();
      return;
    }

    let wrap = existing;
    // Rebuild only when the pair is missing or has lost its shape: the skin is
    // re-applied on every scan below, so a Teams re-render cannot leave both tabs
    // looking selected, and moving around the strip does not rebuild the pair.
    if (!wrap || !wrap.classList.contains('tpp-tabs--inline')) {
      wrap?.remove();
      wrap = buildTabs(posts);
      document.body.append(wrap);
    }
    const skins = tabSkins(posts);
    // While another Teams tab is selected, its panel is the one on show: ours
    // must not read as the chosen tab at the same time.
    const postsSelected = posts.getAttribute('aria-selected') !== 'false';

    for (const button of wrap.querySelectorAll('.tpp-tab')) {
      const active = postsSelected && view === button.dataset.mode;
      skinTab(button, active ? skins.selected : skins.idle, active);
    }

    // The pair joins the channel tab strip where the Posts tab was: Posts leaves
    // the layout and the tabs beside it slide over by the width these two need.
    // Nothing else in the strip is inserted into, moved or hidden.
    if (hiddenNativeTab && hiddenNativeTab !== posts) releaseNativeTab();

    wrap.classList.add('tpp-tabs--inline');
    // Placement from an older fallback (fixed position, offsets) must not leak in.
    if (wrap.style.position) wrap.removeAttribute('style');

    const host = posts.parentElement;
    if (host && (wrap.parentElement !== host || wrap.nextElementSibling !== posts)) {
      host.insertBefore(wrap, posts);
    }

    if (hiddenNativeTab !== posts) {
      posts.setAttribute('aria-hidden', 'true');
      hiddenNativeTab = posts;
    }
    // React rewrites the tab's class list, so this is re-asserted every scan.
    posts.classList.add('tpp-native-tab-hidden');

    alignTabsToStrip(posts, wrap);
  }

  /**
   * The pair. Each tab is a copy of Teams' own Posts tab (see cloneTab), so the
   * strip's type, padding, height, colour and selected bar come from Teams and
   * follow a theme change without anything being hard-coded here. There is no
   * second, free-standing look: the pair only exists inside that strip.
   */
  function buildTabs(posts) {
    const wrap = document.createElement('div');
    wrap.id = TABS_ID;
    wrap.className = 'tpp-tabs';
    wrap.dataset.tppUi = 'tabs';
    wrap.setAttribute('role', 'tablist');
    wrap.setAttribute('aria-label', 'Inbox and Archive');

    for (const [mode, label] of [
      [VIEW_INBOX, 'Inbox'],
      [VIEW_ARCHIVES, 'Archive']
    ]) {
      const button = cloneTab(posts);
      button.classList.add('tpp-tab');
      button.dataset.mode = mode;
      button.type = 'button';
      button.setAttribute('role', 'tab');

      const text = labelOf(button);
      // A tab we could not identify a label in: its text is its own content.
      if (text) text.textContent = label;
      else button.textContent = label;

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setView(mode);
      });

      wrap.append(button);
    }

    return wrap;
  }

  /**
   * A copy of Teams' Posts tab. cloneNode keeps its classes and inner markup but
   * not its listeners, so the copy looks native and still answers to our click.
   * The attributes that identify the real tab (its id, value and tracking) are
   * stripped so nothing binds to the copy.
   */
  function cloneTab(posts) {
    const tab = posts.cloneNode(true);

    // Our own state on the native tab must not travel with the copy.
    tab.classList.remove('tpp-native-tab-hidden', 'tpp-tab');

    const label = labelOf(tab);
    if (label) {
      label.className = `tpp-tab-label ${label.className}`;
      label.textContent = '';
    }

    for (const el of [tab, ...tab.querySelectorAll('[id], [data-tid]')]) {
      el.removeAttribute('id');
      el.removeAttribute('data-tid');
    }
    for (const name of [
      'value',
      'data-tabster',
      'data-inp',
      'aria-controls',
      'aria-labelledby',
      'aria-hidden'
    ]) {
      tab.removeAttribute(name);
    }

    return tab;
  }

  /** The native tab's own class list, without the marker we add to it. */
  function templateOf(posts) {
    return (posts.className || '')
      .split(/\s+/)
      .filter((name) => name && name !== 'tpp-native-tab-hidden')
      .join(' ');
  }

  /**
   * The two looks a tab in this strip can have. Teams colours a tab with the
   * class list it renders for a selected item, not with aria-selected, so both
   * skins are read from the strip itself: the tab that is selected right now and
   * one that is not.
   */
  function tabSkins(posts) {
    const strip = posts && posts.parentElement;
    const findIn = (root, wanted) => {
      if (!root) return null;
      for (const tab of root.querySelectorAll('[role="tab"]')) {
        if (tab.closest('#' + TABS_ID)) continue;
        if ((tab.getAttribute('aria-selected') === 'true') === wanted) return tab;
      }
      return null;
    };

    return {
      // The pair stands in for Posts, so Posts is the reference for a selected
      // look. Another tab's selected look made Inbox look chosen while that tab
      // was the one in front.
      selected: posts || findIn(document, true) || null,
      idle: findIn(strip, false) || findIn(document, false) || posts || null
    };
  }

  /**
   * Dresses one of our tabs in a given skin. Because the pair is copied from the
   * Posts tab, both copies start out carrying the selected tab's classes and so
   * both looked current; the active one now wears the selected skin and the
   * other an unselected tab's, which is also what greys it out.
   */
  function skinTab(button, proto, active) {
    const tabClass = `${proto ? templateOf(proto) : ''} tpp-tab`.trim();
    if (button.className !== tabClass) button.className = tabClass;

    // Teams keeps part of a tab's look — and part of its spacing — in the
    // classes of the elements inside it, so the tab on its own is not enough.
    if (proto) copyTabClasses(button, proto);

    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    // Fluent draws the selected tab's bar with a pseudo-element scaled by these
    // two variables, so the copy answers to them the same way.
    button.style.setProperty('--fui-Tab__indicator--offset', '0px');
    button.style.setProperty('--fui-Tab__indicator--scale', active ? '1' : '0');
  }

  /**
   * Copy the class list of every level of a native tab onto the same level of
   * ours. The two trees are built the same way, so the walk lines up; it stops
   * at the first element that is not the same kind, which keeps a tab carrying
   * an extra piece (a menu chevron) from smearing that onto ours.
   */
  function copyTabClasses(button, proto) {
    const label = button.querySelector('.tpp-tab-label');
    const from = [proto, ...proto.querySelectorAll('*')];
    const to = [button, ...button.querySelectorAll('*')];

    // index 0 is the tab itself, already dressed above.
    for (let i = 1; i < Math.min(from.length, to.length); i += 1) {
      if (from[i].tagName !== to[i].tagName) break;
      let next = from[i].getAttribute('class') || '';
      if (to[i] === label) next = `tpp-tab-label ${next}`.trim();
      if ((to[i].getAttribute('class') || '') !== next) to[i].setAttribute('class', next);
    }
  }

  /** A real, visible tab in the same strip: the box our pair has to match. */
  function nativeSiblingTab(posts) {
    const strip = posts.parentElement;
    if (!strip) return null;

    for (const tab of strip.querySelectorAll('[role="tab"]')) {
      if (tab === posts || tab.closest('#' + TABS_ID)) continue;
      if (!tab.getClientRects().length) continue;
      return tab;
    }
    return null;
  }

  function setStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
  }

  /**
   * Teams lays out the strip's tabs as direct children, so a copy that sits one
   * level deeper misses whatever the strip applies to its own children and can
   * drop below them. Rather than guessing at that, the pair is measured against
   * a real tab in the same strip: the same height, and the same offset from the
   * strip's content box, re-read on every scan so it also holds after Teams
   * re-renders the strip or the window is resized.
   */
  function alignTabsToStrip(posts, wrap) {
    const proto = nativeSiblingTab(posts);
    if (!proto) return;

    const tabRect = proto.getBoundingClientRect();
    const stripRect = posts.parentElement.getBoundingClientRect();
    if (!tabRect.height || !stripRect.height) return;

    const css = getComputedStyle(posts.parentElement);
    const contentTop =
      stripRect.top + (parseFloat(css.borderTopWidth) || 0) + (parseFloat(css.paddingTop) || 0);
    const offset = Math.round(tabRect.top - contentTop);
    const height = Math.round(tabRect.height * 100) / 100;

    setStyle(wrap, 'display', 'flex');
    setStyle(wrap, 'alignItems', 'flex-start');
    setStyle(wrap, 'alignSelf', 'flex-start');
    setStyle(wrap, 'height', 'auto');
    setStyle(wrap, 'marginTop', `${offset}px`);
    setStyle(wrap, 'marginBottom', '0');

    for (const tab of wrap.children) {
      setStyle(tab, 'display', 'inline-flex');
      setStyle(tab, 'alignItems', 'center');
      setStyle(tab, 'alignSelf', 'flex-start');
      setStyle(tab, 'boxSizing', 'border-box');
      setStyle(tab, 'height', `${height}px`);
      setStyle(tab, 'margin', '0');
      setStyle(tab, 'paddingTop', '0');
      setStyle(tab, 'paddingBottom', '0');
    }
  }

  /**
   * Teams' own "Posts" tab. Its `value`/`id` (`…channeltabs.posts`) is stable
   * across releases, so it is found by that rather than by its label.
   */
  function nativePostsTab() {
    const selectors = [
      '[role="tab"][value*="channeltabs.posts" i]',
      '[role="tab"][id*="channeltabs.posts" i]',
      '[role="tab"][data-tid*="tab-item" i][data-tid*="posts" i]'
    ];

    for (const selector of selectors) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (_) {
        continue;
      }
      // Reject our own tabs and container elements that hold other tabs —
      // hiding a container would hide every tab in the strip.
      if (found && !found.closest('#' + TABS_ID) && !found.querySelector('[role="tab"]')) {
        return found;
      }
    }

    // Last resort: the tab whose label is exactly "Posts".
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      if (tab.closest('#' + TABS_ID)) continue;
      if (tab.querySelector('[role="tab"]')) continue;
      if (/^posts$/i.test(collapse(tab.textContent || ''))) return tab;
    }
    return null;
  }

  /**
   * The channel's own tab strip: the row that holds Posts, Files and the rest.
   *
   * Every channel view has one and no other Teams view does, so its absence is
   * the surest sign that the page is showing something else — a post opened from
   * Find in channel, a thread, a dialog.
   */
  function nativeTabStrip() {
    const posts = nativePostsTab();
    let strip = posts && posts.parentElement;

    if (!strip) {
      for (const candidate of document.querySelectorAll('[role="tablist"]')) {
        if (candidate.closest('#' + TABS_ID)) continue;
        if (!candidate.querySelector('[role="tab"]')) continue;
        strip = candidate;
        break;
      }
    }
    if (!strip) return null;

    // A strip that is not on screen is not a strip: Teams can leave the
    // channel's chrome mounted while it draws a single post in its place. Asked
    // of the tabs rather than of the strip itself, since a strip is sometimes a
    // `display: contents` box with no box of its own to measure.
    for (const tab of strip.querySelectorAll('[role="tab"]')) {
      if (tab.getClientRects().length) return strip;
    }
    return null;
  }

  /** Teams' own label element inside a tab: the text sits in a Primitive. */
  function labelOf(tab) {
    if (!tab) return null;
    return (
      tab.querySelector('[data-tid^="data-tid-"]') ||
      tab.querySelector('.tpp-tab-label') ||
      null
    );
  }

  /** Put Teams' own "Posts" tab back when our tabs are not standing in. */
  function releaseNativeTab() {
    if (!hiddenNativeTab) return;
    hiddenNativeTab.classList.remove('tpp-native-tab-hidden');
    hiddenNativeTab.removeAttribute('aria-hidden');
    hiddenNativeTab.style.minWidth = '';
    hiddenNativeTab = null;
  }

  // ------------------------------------------------------------- empty state

  function buildEmptyState(kind) {
    const empty = document.createElement('div');
    empty.id = EMPTY_ID;
    empty.className = 'tpp-empty-state';
    empty.dataset.tppUi = 'empty';
    empty.dataset.tppKind = kind;

    if (kind === 'zero') {
      // A card, not a party: the sign is the point, and the one round of
      // confetti it can get is a switch of its own (renderEmpty).
      const check = document.createElement('div');
      check.className = 'tpp-empty-check';
      check.innerHTML = CHECK_SVG;

      const title = document.createElement('h2');
      title.className = 'tpp-empty-title';
      title.textContent = 'Inbox Zero!';

      const copy = document.createElement('p');
      copy.className = 'tpp-empty-copy';
      copy.textContent =
        'Every post here is read. Open the Archive tab to find them, and Unarchive to bring one back.';

      empty.append(check, title, copy);
      return empty;
    }

    const icon = document.createElement('div');
    icon.className = 'tpp-empty-check';
    icon.innerHTML = EMPTY_ARCHIVE_SVG;

    const title = document.createElement('h2');
    title.className = 'tpp-empty-title tpp-empty-title--calm';
    title.textContent = 'Nothing archived';

    const copy = document.createElement('p');
    copy.className = 'tpp-empty-copy';
    copy.textContent =
      'Posts you archive from your Inbox collect here. Open one from its Unarchive button to send it back.';

    empty.append(icon, title, copy);
    return empty;
  }

  /**
   * Is the channel's Posts panel the one on show?
   *
   * Teams keeps every channel tab mounted and keeps the Posts panel in the DOM
   * behind Shared, Files and Calendar. A list can therefore exist, and be the
   * list this script knows, while the user is looking at another panel — which
   * is exactly how the Inbox Zero sign ended up over the contents of another
   * tab. The selected tab is asked for, and the list has to actually be on
   * screen rather than merely present.
   */
  /** Has the user selected another native Teams tab like Files, Notes, etc.? */
  function otherTabSelected() {
    for (const tab of document.querySelectorAll('[role="tab"]')) {
      if (tab.closest('#' + TABS_ID)) continue;
      if (tab === hiddenNativeTab || tab === nativePostsTab()) continue;
      if (tab.matches('[value*="posts" i], [id*="posts" i], [data-tid*="posts" i]')) continue;
      if (tab.getAttribute('aria-selected') === 'true') return true;
    }
    return false;
  }

  /** Is the channel's own Posts tab the selected one? */
  function postsTabSelected() {
    if (otherTabSelected()) return false;
    if (document.getElementById(TABS_ID)) return true;
    const posts = nativePostsTab();
    return !posts || posts.getAttribute('aria-selected') !== 'false';
  }

  function postsPanelShown(list) {
    if (!postsTabSelected()) return false;

    const target = list || (lastList && lastList.isConnected ? lastList : findMessageList());
    if (!target) return false;
    if (target.getClientRects().length) return true;

    // The list itself can be a `display: contents` box or collapsed with no rect of its own:
    // the panel or container around it is then the thing that decides.
    const panel = target.closest('[role="tabpanel"], [data-tid*="channel-pane" i], main');
    return Boolean(panel && panel.getClientRects().length);
  }

  function renderEmpty(list) {
    const existing = document.getElementById(EMPTY_ID);

    // The card belongs to this channel's Posts panel and nowhere else.
    if (!features.inboxZero || !list || !postsPanelShown(list)) {
      existing?.remove();
      return;
    }

    const records = Array.from(rowsById.values());
    const unread = records.filter((record) => !record.read).length;
    const read = records.filter((record) => record.read).length;

    let kind = null;
    if (view === VIEW_ARCHIVES) {
      kind = read === 0 ? 'no-archives' : null;
    } else {
      // Whenever there are no unread posts in the inbox -> Inbox Zero!
      kind = view === VIEW_INBOX && unread === 0 ? 'zero' : null;
    }

    if (!kind) {
      existing?.remove();
      return;
    }

    let empty = existing;
    const fresh = !empty || empty.dataset.tppKind !== kind;
    if (fresh) {
      empty?.remove();
      empty = buildEmptyState(kind);
      document.body.append(empty);
    }

    anchor(empty, list, { top: 18, full: true, matchHeight: true });

    // Once per appearance: the card is only built when the view changes into
    // Inbox Zero, so a scan that finds it already there never celebrates again.
    if (fresh && kind === 'zero') celebrateZero(empty);
  }

  /**
   * One round of confetti when the Inbox Zero sign appears.
   *
   * The pieces are plain elements with a CSS fall, removed when the last one
   * lands: nothing is measured per frame and no canvas is created. The round is
   * the user's choice (the popup's Inbox Zero confetti switch), and it is
   * skipped outright when the system asks for reduced motion.
   */
  function celebrateZero(card) {
    if (!features || !features.inboxConfetti) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    document.getElementById(CONFETTI_ID)?.remove();

    const layer = document.createElement('div');
    layer.id = CONFETTI_ID;
    layer.className = 'tpp-confetti';
    layer.dataset.tppUi = 'confetti';
    layer.setAttribute('aria-hidden', 'true');

    // The burst leaves the words themselves, not the card's edge: every piece is
    // thrown from one small knot at the middle of the sign, so the round reads as
    // a fan opening outward rather than a line of pieces dropping together.
    const rect = card ? card.getBoundingClientRect() : null;
    const sign = card ? card.querySelector('.tpp-empty-title') : null;
    const signRect = sign ? sign.getBoundingClientRect() : null;
    const origin = signRect && signRect.width > 40 && signRect.height > 8 ? signRect : rect;
    const originX =
      origin && origin.width > 40 ? origin.left + origin.width / 2 : window.innerWidth / 2;
    const originY =
      origin && origin.height > 8
        ? origin.top + origin.height / 2
        : window.innerHeight / 2 - 80;
    // Every piece is meant to land below the window, so the fall is measured
    // from the sign to the bottom of the screen rather than guessed.
    const fall = Math.max(window.innerHeight - Math.max(originY, 0) + 60, 320);

    // A zero-width layer is the point the fan comes from; nothing is clipped
    // because it has no box, so pieces leave it in every direction.
    layer.style.left = `${Math.round(originX)}px`;
    layer.style.width = '0px';
    layer.style.top = `${Math.round(Math.max(originY, 0))}px`;

    const colours = ['#6264a7', '#8b5cf6', '#4b53a0', '#f4b942', '#4bb543', '#ff5e5b'];
    let longest = 0;

    for (let i = 0; i < 72; i += 1) {
      const piece = document.createElement('div');
      piece.className = 'tpp-confetti-piece';

      // Up and out, at every angle in the upper half: nothing is fired straight
      // down, because nothing bursts downwards out of the top of a sign.
      const angle = -Math.PI * (0.06 + Math.random() * 0.88);
      // A harder throw than the fall suggests: the apex is well above the sign,
      // so the pieces are seen rising before they are seen falling. The sideways
      // reach is kept a little tighter, and the height is capped so a piece is
      // not thrown past the top of the window from a sign low in the list.
      const speed = 180 + Math.random() * 220;
      const apexX = Math.round(Math.cos(angle) * speed * 0.9);
      const apexY = -Math.min(Math.round(Math.abs(Math.sin(angle)) * speed * 1.2), 380);
      const drift = Math.round((Math.random() - 0.5) * 120);

      const delay = Math.round(Math.random() * 80);
      const time = Math.round(1700 + Math.random() * 1100);

      // Barely a jitter: the fan starts from a point, not from a spread.
      piece.style.setProperty('--tpp-x', `${Math.round((Math.random() - 0.5) * 24)}px`);
      piece.style.setProperty('--tpp-apex-x', `${apexX}px`);
      piece.style.setProperty('--tpp-apex-y', `${apexY}px`);
      piece.style.setProperty('--tpp-land-x', `${apexX + drift}px`);
      piece.style.setProperty('--tpp-fall', `${Math.round(fall)}px`);
      piece.style.setProperty('--tpp-delay', `${delay}ms`);
      piece.style.setProperty('--tpp-spin', `${Math.round(240 + Math.random() * 720)}deg`);
      piece.style.setProperty('--tpp-time', `${time}ms`);
      piece.style.background = colours[i % colours.length];
      layer.append(piece);

      longest = Math.max(longest, delay + time);
    }

    document.body.append(layer);
    // Nothing is cut short: the layer outlives the slowest piece by a margin.
    setTimeout(() => layer.remove(), longest + 320);
  }

  // ------------------------------------------------------- hover between posts

  // -------------------------------------------------------------- overlays  // -------------------------------------------------------------- overlays

  /**
   * Keep a fixed-position overlay glued to the message list. `full` stretches
   * it to the list's width; otherwise it is anchored to the right edge.
   */
  function anchor(el, list, options) {
    let rect = list.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      const container = list.closest(
        '[data-tid="message-pane-list-viewport"], [role="tabpanel"], [data-tid*="channel-pane" i], main'
      );
      if (container) {
        const crect = container.getBoundingClientRect();
        if (crect.width >= 120 && crect.height >= 80) rect = crect;
      }
    }
    if (rect.width < 120 || rect.height < 80) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.position = 'fixed';

    if (options.top != null) {
      el.style.top = `${Math.max(rect.top, 0) + options.top}px`;
      el.style.bottom = 'auto';
    } else if (options.bottom != null) {
      el.style.top = 'auto';
      el.style.bottom = `${Math.max(window.innerHeight - rect.bottom, 0) + options.bottom}px`;
    }

    if (options.full) {
      el.style.left = `${rect.left + 12}px`;
      el.style.width = `${Math.max(rect.width - 24, 200)}px`;
      el.style.right = 'auto';
    } else if (options.compact) {
      // Just wide enough for its content, pinned to the left of the list.
      el.style.left = `${rect.left + 12}px`;
      el.style.width = 'auto';
      el.style.right = 'auto';
    } else {
      el.style.left = 'auto';
      el.style.right = `${Math.max(window.innerWidth - rect.right, 0) + (options.right || 0)}px`;
      el.style.width = options.width || 'auto';
    }

    if (options.matchHeight) {
      el.style.height = `${Math.max(rect.height - (options.top || 0) - 12, 120)}px`;
    }
  }

  /**
   * A status message: a larger, translucent card centred over the post div
   * that was just acted on, or dead centre over the posts list.
   */
  function toast(message, anchor) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.className = 'tpp-toast';
      el.dataset.tppUi = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.append(el);
    }

    el.textContent = message;
    placeToast(el, anchor);

    // Restart the entrance, so a second message in a row is noticed.
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.remove();
    }, 2600);
  }

  /**
   * Puts the status message in the middle of the post div if an anchor is given,
   * otherwise horizontally centred over the post column and vertically in the middle.
   */
  function placeToast(el, anchor) {
    let rect = null;

    if (anchor) {
      if (anchor.row && anchor.row.isConnected) {
        rect = anchor.row.getBoundingClientRect();
      } else if (anchor.rect) {
        rect = anchor.rect;
      } else if (anchor instanceof Element && anchor.isConnected) {
        rect = anchor.getBoundingClientRect();
      } else if (typeof anchor.getBoundingClientRect === 'function') {
        rect = anchor.getBoundingClientRect();
      }
    }

    if (!rect || rect.width < 10 || rect.height < 10) {
      if (lastList && lastList.isConnected) {
        const row = lastList.querySelector('.tpp-post');
        const r = row ? row.getBoundingClientRect() : null;
        if (r && r.width > 40) rect = r;
      }
    }

    if (!rect || rect.width < 10) {
      const list = lastList && lastList.isConnected ? lastList : findMessageList();
      const r = list ? list.getBoundingClientRect() : null;
      if (r && r.width > 40) rect = r;
    }

    if (rect) {
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const clampedX = Math.max(120, Math.min(window.innerWidth - 120, cx));
      const clampedY = Math.max(80, Math.min(window.innerHeight - 80, cy));
      el.style.left = `${clampedX}px`;
      el.style.top = `${clampedY}px`;
    } else {
      el.style.left = '50%';
      el.style.top = '50%';
    }
  }

  function reposition() {
    // A composer is open: the page is the user's, and every measurement and
    // scroll nudge waits until it is gone (see composerOpen).
    if (!ready || !channelMode || frame || composerOpen()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const list = findMessageList();
      if (!list) return;

      // Another Teams tab is in front: nothing of ours is on that panel, and
      // nothing is measured or placed against a hidden list.
      if (!postsPanelShown(list)) return;

      listRect = list.getBoundingClientRect();

      const empty = document.getElementById(EMPTY_ID);
      if (empty) anchor(empty, list, { top: 18, full: true, matchHeight: true });

      // Scrolling is the moment the list is asked for more, so the limit is
      // re-checked here — at most a few times a second, because measuring
      // every row is the most expensive thing this script does.
      clampSoon(list);
    });
  }

  // ------------------------------------------------------ which channel this is

  /**
   * The channel name Teams prints above the posts, when it is on screen.
   *
   * The URL is no help in this Teams build: it stays at the root for every
   * channel, so the header is the only identity the page itself offers.
   */
  function channelTitleEl() {
    let nodes = [];
    try {
      nodes = document.querySelectorAll('[data-tid="channelTitle-text"]');
    } catch (_) {
      return null;
    }
    // Newest last: when Teams keeps the previous channel mounted through a
    // switch, the header appended last is the channel now in front.
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (!node.getClientRects().length) continue;
      if (!collapse(node.textContent || '')) continue;
      return node;
    }
    return null;
  }

  function channelTitle() {
    const el = channelTitleEl();
    return el ? collapse(el.textContent || '') : null;
  }

  function watchChannelTitle() {
    const el = channelTitleEl();
    if (el === titleEl) return;
    titleObserver?.disconnect();
    titleObserver = null;
    titleEl = el;
    if (!el) return;
    titleObserver = new MutationObserver(() => {
      if (!ready) return;
      resetForChannelChange();
      scheduleScan(true);
    });
    titleObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }

  /**
   * A channel switch replaces the list, and usually the tab strip with it.
   * Everything measured against the channel that just left is dropped here, so
   * the scan that follows measures the channel now on screen.
   */
  function resetForChannelChange() {
    lastList = null;
    listRect = null;
  }

  // -------------------------------------------------------------- persistence

  function saveReadSoon() {
    clearTimeout(readSaveTimer);
    readSaveTimer = setTimeout(() => {
      readSaveTimer = 0;
      persistRead();
    }, 200);
  }

  async function persistRead() {
    let trimmed = Object.fromEntries(Object.entries(readState).slice(-READ_LIMIT));
    readState = trimmed;

    if (await writeSync({ [UNREAD_KEY]: trimmed })) return;

    // Per-item quota: keep only the newest quarter and try once more rather
    // than silently losing the change.
    trimmed = Object.fromEntries(
      Object.entries(trimmed).slice(-Math.max(10, Math.floor(READ_LIMIT / 4)))
    );
    readState = trimmed;
    await writeSync({ [UNREAD_KEY]: trimmed });
  }

  // ------------------------------------------------------------- placeholders

  /**
   * Teams draws shimmer stand-ins for posts it is still fetching. On a filtered
   * view — Archives most of all, where most posts are hidden — they read as a
   * blank post at the bottom of the list. They are marked here and taken out of
   * the layout there (teams.css).
   */
  function markLoadingRows(list) {
    const selectors = S.loadingRow || [];
    if (!selectors.length) return;

    // One narrow query decides whether the full rule set is worth running. It
    // is seven substring selectors, and a scan runs several times a second.
    let any = null;
    try {
      any = list.querySelector(
        '[data-tid*="skeleton" i], [data-tid*="shimmer" i], [data-tid*="loading" i], [data-tid*="placeholder" i], [class*="skeleton" i], [class*="shimmer" i], [class*="Spinner__spinner"], [role="progressbar"]'
      );
    } catch (_) {
      return;
    }

    for (const el of list.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }
    if (!any) return;

    // Anything the user writes in, or that holds a composer. Teams names the
    // collapsed reply box under a post with a placeholder id, and treating one
    // as a loading row hid the Reply control under every post in the channel.
    const composeAreas =
      '[data-tid*="reply" i], [data-tid*="compose" i], [data-shortcut-context="compose-field"], [contenteditable="true"], [data-tid="ckeditor"]';

    for (const el of list.querySelectorAll(selectors.join(','))) {
      // A skeleton inside a real post (a link card still loading) is that
      // post's own business, not a stand-in row.
      if (el.closest('.tpp-post')) continue;
      if (el.closest(composeAreas) || el.querySelector(composeAreas)) continue;

      // A spinner holds no text, so the climb below would walk all the way up to
      // the box that holds the posts when they are all closed up — and hiding
      // that hides the list. A spinner is marked on its own instead, and
      // teams.css hides that class outright.
      if (/spinner/i.test(String(el.className || ''))) {
        el.dataset.tppPlaceholder = '1';
        continue;
      }

      // The shimmer sits somewhere inside a blank block: hide the block, not
      // just the bar, but never climb as far as the list itself.
      let target = el;
      for (let node = el.parentElement; node && node !== list; node = node.parentElement) {
        if (collapse(node.textContent || '')) break;
        target = node;
      }
      target.dataset.tppPlaceholder = '1';
    }
  }

  /**
   * The element that actually scrolls the post list. findMessageList can name a
   * runway nested inside the scroller, so the box carrying the scrollbar is
   * looked up from the list and then from its ancestors.
   */
  function scrollBoxFor(list) {
    if (!list) return null;
    const scrolls = (el) =>
      el.scrollHeight > el.clientHeight + 1 &&
      /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);

    if (scrolls(list)) return list;
    for (let node = list.parentElement; node && node !== document.body; node = node.parentElement) {
      if (scrolls(node)) return node;
    }
    return list;
  }

  /**
   * A post Teams has marked as the result of a search.
   *
   * Teams' own Find in channel jumps the list to a post and marks it; if that
   * post happened to be read, the Inbox filter closed it up and the search
   * looked broken — the result was there, three pixels tall and invisible. A
   * highlighted post is therefore never filtered out, whichever tab is open.
   *
   * Focus is deliberately not part of this: an opened post is focused, and
   * treating focus as a spotlight kept a post from the other tab on screen.
   * The class and data marks are Teams' own, so they survive a re-render.
   */
  function isHighlighted(row) {
    if (!row) return false;
    if (/highlight|spotlit/i.test(String(row.className || ''))) return true;
    try {
      return Boolean(row.querySelector('[data-tid*="highlight" i]'));
    } catch (_) {
      return false;
    }
  }

  /**
   * A post Teams has drawn attention to: the one a channel search found, or the
   * one holding the keyboard.
   */
  function isSpotlit(row) {
    if (!row) return false;
    // Asked for every post on every scan, so it is asked cheaply: the focused
    // node, the row's own class list, then one narrow query. `:focus-within`
    // and `[class*="highlight" i]` are both style-dependent and slow.
    const active = document.activeElement;
    if (active && row.contains(active)) return true;
    if (/highlight|spotlit|focused|selected/i.test(String(row.className || ''))) return true;
    try {
      return Boolean(
        row.querySelector('[aria-selected="true"], [data-is-focus-visible], [data-tid*="highlight" i]')
      );
    } catch (_) {
      return false;
    }
  }

  /** Whether the current view is showing this post at all (teams.css decides). */
  function onShow(row) {
    if (!row || row.dataset.tppTucked !== undefined) return false;
    if (row.dataset.tppModal === '1') return false;
    if (!features || !features.inboxZero) return true;
    if (isSpotlit(row)) return true;
    const read = row.dataset.tppTag === 'read';
    return view === VIEW_ARCHIVES ? read : !read;
  }

  /**
   * The list ends where its last post on show ends.
   *
   * Hidden posts keep the height Teams measured — that is exactly what stops it
   * paging the channel's history into a filtered view — so the list is much
   * taller than what is on show, and a wheel would carry the user into blank
   * space, asking Teams for older history that arrives and is hidden again. The
   * scroll is held to the last post instead, which also leaves a short Inbox
   * that does not scroll at all.
   *
   * A pin search is exempt: it walks the list through its history on purpose.
   */
  function clampScroll(list, moveScroll = true) {
    if (!ready || !features || !features.inboxZero || !list) return;
    const box = scrollBoxFor(list);
    if (!box) return;
    lastScrollBox = box;

    const boxRect = box.getBoundingClientRect();
    const top = box.scrollTop;
    let last = 0;
    let shown = 0;
    let found = false;
    for (const row of box.querySelectorAll('.tpp-post')) {
      // A tucked row is filtered out and has no height: skipping it before the
      // onShow tests and the measurement keeps this to the posts on show,
      // instead of forcing layout for every post Teams has rendered in the list.
      if (row.dataset.tppTucked !== undefined) continue;
      if (!onShow(row)) continue;
      const rect = row.getBoundingClientRect();
      if (!rect.height) continue;
      found = true;
      shown += rect.height;
      last = Math.max(last, rect.bottom - boxRect.top + top);
    }
    // Nothing on show: an Inbox with everything read, or an Archive with
    // nothing in it yet. The posts are all closed up, so there is nowhere to
    // read to — the scroll is held at the start. A list that has not been tagged
    // yet is left alone.
    if (!found) {
      const filtered = Array.from(box.querySelectorAll('.tpp-post')).some(
        (row) => row.dataset.tppTucked !== undefined
      );
      if (moveScroll && filtered && box.scrollTop > 1) box.scrollTop = 0;
      return;
    }

    // The room after the last post is a top-up, never a block: enough to fill the
    // pane with the posts on show, and nothing more. A tab whose posts fit then
    // has no scroll range at all — so nothing is locked, nothing is pulled back,
    // and nothing can rubber-band — while a tab whose posts need more room than
    // they have simply scrolls. It is measured from the posts on show, which do
    // not change when a hidden batch arrives, so it cannot drift under Teams'
    // re-renders the way a total of the hidden posts did.
    setRoomPad(Math.max(0, Math.round(box.clientHeight - shown) - 2));

    // Only a scroll this script is allowed to answer is pulled back. A scan
    // that moved the scroll while Teams was paging a channel's history was read
    // by Teams as being at the end of what it had, and it fetched the next
    // batch: that is how a whole channel's history ended up loading into the
    // list. The pad alone is enough to keep the end of the tab honest.
    if (!moveScroll) return;
    const limit = Math.max(0, last - box.clientHeight);
    if (box.scrollTop > limit + 1) box.scrollTop = limit;
  }

  /**
   * The scroll handler's version of clampScroll, rate-limited.
   *
   * A scroll can fire sixty times a second and each clamp measures every post
   * in the list. Two hundred milliseconds is far quicker than the eye and turns
   * that per-frame cost into a handful of measurements.
   */
  function clampSoon(list) {
    const now = Date.now();
    if (now - clampedAt < 200) return;
    clampedAt = now;
    clampScroll(list);
  }

  /**
   * A scroll anywhere in the app used to be our cue to re-measure everything.
   * Only the list's own scroller and the page can move what we draw, so every
   * other pane's scrolling — a chat list, search results, a side panel — is
   * ignored outright.
   */
  function onAnyScroll(event) {
    const target = event.target;
    if (target !== window && target !== document && target !== document.documentElement) {
      if (!lastScrollBox || target !== lastScrollBox) return;
    }
    reposition();
  }

  /**
   * Sizes the room after the last post, as one CSS variable on the box that holds
   * the rows (teams.css). Written only when it actually changed.
   */
  function setRoomPad(px) {
    if (!roomEl) return;
    const value = `${Math.max(0, px)}px`;
    if (roomEl.style.getPropertyValue('--tpp-room') !== value) {
      roomEl.style.setProperty('--tpp-room', value);
    }
  }

  // ------------------------------------------------------------------- scan

  /**
   * The scan, timed while the readout is switched on (see start).
   *
   * Every path ends up here, so one timer around the body is the whole
   * measurement: how many scans a second are being run, and what the worst and
   * the average one cost. A scan on a settled channel should cost nothing, and
   * this is how that is checked rather than assumed.
   */
  function scan() {
    if (!perf.on) {
      scanNow();
      return;
    }
    const started = performance.now();
    try {
      scanNow();
    } finally {
      const ms = performance.now() - started;
      perf.scans += 1;
      perf.total += ms;
      if (ms > perf.max) perf.max = ms;
      const now = Date.now();
      if (now - perf.writtenAt >= 1000) {
        perf.writtenAt = now;
        const seconds = Math.max(now - perf.startedAt, 1) / 1000;
        document.documentElement.setAttribute(
          'data-tpp-perf',
          `scans ${perf.scans} (${(perf.scans / seconds).toFixed(1)}/s) ` +
            `avg ${(perf.total / perf.scans).toFixed(1)}ms max ${perf.max.toFixed(0)}ms ` +
            `row-reads ${perf.rebuilds} ` +
            `avg ${perf.rebuilds ? (perf.rebuildTotal / perf.rebuilds).toFixed(1) : '0'}ms ` +
            `mutation-batches ${perf.batches} (${perf.relevant} relevant) ` +
            `callback ${(perf.mutTotal / perf.batches).toFixed(2)}ms ` +
            `max ${perf.mutMax.toFixed(0)}ms ` +
            `rows ${rowsById.size} ` +
            `mode ${channelMode === true ? 'channel' : channelMode === false ? 'off' : 'settling'} ` +
            `load ${perf.loadMs ? perf.loadMs.toFixed(0) + 'ms' : '-'} (${perf.loadRows} rows) ` +
            `build ${BUILD}`
        );
      }
    }
  }

  function scanNow() {
    if (!ready) return;

    // A scan answers the change that asked for it, so both timers are settled.
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    clearTimeout(slowTimer);
    slowTimer = 0;

    // Teams changes view without a page load, so the question is asked again on
    // every scan. In a chat (or anywhere that is not a channel) the flags come
    // off and whatever was drawn in a channel is taken down. `null` means the
    // page is still settling, and then nothing is decided either way — a
    // channel is never torn down because its posts have not rendered yet.
    const verdict = channelVerdict();

    // Leaving the channel is acted on only once the answer has held for half a
    // second. Teams takes a moment to render a pane — a batch of posts loading,
    // a tab being swapped — and one "not a channel" scan used to switch the
    // whole extension off and rebuild it on the next: the tabs, the cards and
    // the pinned bars all blinked with it. A real move still lands, a fraction
    // of a second later.
    if (verdict === false && channelMode === true) {
      const now = Date.now();
      if (!notChannelAt) {
        notChannelAt = now;
        return;
      }
      if (now - notChannelAt < 600) return;
    } else {
      notChannelAt = 0;
    }

    if (verdict !== null && verdict !== channelMode) {
      channelMode = verdict;
      syncFeatureFlags();
    }
    if (channelMode === false) {
      // Left the Posts area: take our UI down once, not on every scan. A chat
      // or a search result is scanned constantly too, and tearing the whole
      // page down each time was pure cost with nothing to show for it.
      if (uiDrawn) teardownChannelUi();
      return;
    }
    if (channelMode !== true) return;

    // The channel is the nearest painted thing to a post, so it is the best
    // answer to "is this page dark?" — and a scan is already running. Reading
    // the painted surface is not free, and the theme cannot change without the
    // theme observer firing, so the scan only re-checks it occasionally.
    applyThemeIfDue();

    watchChannelTitle();

    // A reply box that our own styles were put into by an earlier match is
    // given back before this scan looks for the list again. Only the list this
    // scan drew ever carries the class, so asking the document for every
    // `.tpp-list` was a walk of the whole page on every single scan.
    if (lastList && lastList.classList.contains('tpp-list') && isComposeField(lastList)) {
      lastList.classList.remove('tpp-list');
      clearLeftInset(lastList);
      clearTopInset(lastList);
      lastList = null;
    }

    // Teams re-renders the list far more often than it swaps the page, so a
    // list that is still on screen is the list: one `isConnected` read instead
    // of five selectors and a climb from a row.
    const list = lastList && lastList.isConnected ? lastList : findMessageList();

    // Our own overlays and buttons must not re-trigger the observer.
    if (observer) observer.disconnect();
    try {
      // The Inbox/Archive pair lives in Teams' own tab strip, so it is drawn
      // here — before anything that needs the message list or a quiet composer.
      // A channel switch re-creates the strip and takes the pair with it; this
      // puts it back in the same scan rather than after the posts have loaded,
      // which is what left Teams' Posts tab sitting there for a second or more.
      renderTabs();
      if (!list) requestSettleScan();

      // A draft is being written or sent: hands off everything that re-lays the
      // page. The pair above is our own node in Teams' tab strip and cannot
      // touch a draft; re-padding the list, moving its scroll or rebuilding
      // rows under one can, and is how a post ends up not being sent.
      if (composerOpen()) return;

      if (!list) {
        // Teams is between renders — a batch of posts arriving, the pane being
        // swapped — and for a moment there is no list to measure against. Taking
        // the bars and the insets down and putting them back a third of a second
        // later is exactly the blink, so nothing is touched until the gap has
        // lasted long enough to be a real one: the Posts panel being closed.
        const now = Date.now();
        if (!listMissingAt) listMissingAt = now;
        // Another Teams tab is in front, so this scan will return below without
        // drawing anything: everything of ours that is fixed to the window goes
        // at once rather than floating over that panel until the grace runs out.
        if (!postsTabSelected()) {
          for (const id of [EMPTY_ID, CONFETTI_ID, TOAST_ID]) {
            document.getElementById(id)?.remove();
          }
        }
        // Twenty seconds, not one: the bars are fixed to the window and do not
        // need the list to stay where they are, so a swap can last as long as it
        // likes without touching them. Only a pane that really stays away — the
        // Files tab left open — is worth taking them down for, and leaving the
        // channel goes through teardownChannelUi at once anyway.
        if (now - listMissingAt < 20000) return;

        for (const id of [EMPTY_ID]) document.getElementById(id)?.remove();
        // The tabs live in the channel's own tab strip, so they survive a scan
        // that finds no list; renderTabs drops them once that strip is gone.
        renderTabs();
        document.documentElement.removeAttribute(HAS_ARCHIVES_ATTR);
        clearTopInset();
        clearLeftInset();
        return;
      }
      listMissingAt = 0;

      // The list can be mounted while another Teams tab is the one in front:
      // Teams keeps the Posts panel in the DOM behind Shared, Files and
      // Calendar. Nothing of ours may sit on top of that tab, and none of our
      // work belongs on a list nobody is looking at, so the overlays come down
      // and this scan stops here until Posts is in front again.
      if (!postsPanelShown(list)) {
        for (const id of [EMPTY_ID, CONFETTI_ID, TOAST_ID]) {
          document.getElementById(id)?.remove();
        }
        return;
      }

      // A list this scan has not seen before is a whole channel's worth of
      // posts to read whatever the mutation log says.
      const freshList = list !== lastList;
      lastList = list;
      listRect = list.getBoundingClientRect();

      // The stylesheet needs to know which element is the message list to keep
      // it in place in an empty Archives (see publishArchivePresence).
      list.classList.toggle('tpp-list', Boolean(features.inboxZero));

      lastScrollBox = scrollBoxFor(list);

      // The row walk is the expensive part of a scan: a few hundred posts, and
      // for each one several queries and its whole text. It is only owed when
      // the posts can have changed — a new list, or a mutation inside the list
      // since the last read (the observer marks that, see absorbNodes). Idle
      // scans then cost an overlay check rather than a pass over every post.
      const read = listDirty || freshList || rowsById.size === 0;
      listDirty = false;
      if (read) {
        const readAt = perf.on ? performance.now() : 0;
        rebuildRows(list);
        if (perf.on) {
          perf.rebuilds += 1;
          perf.rebuildTotal += performance.now() - readAt;
        }
      }
      if (perf.on) {
        if (rowsById.size === 0) {
          if (!perf.loadStartedAt) perf.loadStartedAt = performance.now();
        } else if (perf.loadStartedAt) {
          perf.loadMs = performance.now() - perf.loadStartedAt;
          perf.loadRows = rowsById.size;
          perf.loadStartedAt = 0;
        }
      }
      markLoadingRows(list);
      renderEmpty(list);
      uiDrawn = true;

      // Teams stops mutating once a channel has rendered, and a scan only runs
      // because something changed. So a view looked at while it was still
      // arriving — posts not painted yet, the empty card not placeable yet, the
      // pair still waiting for a tab to copy — stayed that way until the user
      // happened to do something else. A few follow-ups let it converge, and
      // the count is capped so an empty channel cannot scan forever.
      if (
        rowsById.size === 0 ||
        document.getElementById(EMPTY_ID)?.style.display === 'none'
      ) {
        requestSettleScan();
      } else {
        settleTries = 0;
      }

      // Nothing of ours sits above the first post any more; a list that still
      // carries top padding from an older build has it given back.
      clearTopInset(list);
      if (features.inboxZero) applyLeftInset(list);
      else clearLeftInset(list);

      // The posts have just been re-measured: the Inbox may now end higher up.
      // Only after a read — this measures every post on show, and the scroll
      // handler re-checks the limit as the user moves (clampSoon). The scroll
      // itself is left alone here unless the view just changed: moving it on
      // every scan made Teams page a channel's whole history in.
      const viewChanged = clampView !== view;
      clampView = view;
      if (read) clampScroll(list, viewChanged);

      // The seams have just moved or gone: re-check where the pointer is, so the
      // control cannot outlive the gap it was describing.
    } finally {
      if (observer) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
  }

  /**
   * Closes up the posts Teams has just inserted, before the next paint.
   *
   * A MutationObserver callback runs before the browser paints, so doing the one
   * thing that matters here — giving a read post its id and its tucked mark —
   * means a batch of older posts never appears at full height only to collapse a
   * moment later. That flash is what made the list jump on first load, and again
   * whenever hovering made Teams re-render a few rows. Everything else (cards,
   * buttons, pins) still waits for the debounced scan.
   */
  function absorbNodes(nodes) {
    if (!ready || !features || !features.inboxZero || channelMode !== true) return;
    // The composer owns the page while it is open: nothing is marked there.
    if (composerOpen()) return;

    // One of Teams' own post panes is on screen (Find in channel, a thread):
    // nothing is marked there, because the post has to stay exactly as Teams
    // drew it. A mark put on before the pane's own markup arrived is what left
    // a found post out of sight with only its replies showing.
    if (teamsPostPane()) return;

    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;
      if (node.closest('[data-tpp-ui], .tpp-tabs, .tpp-empty-state')) continue;

      for (const row of newRows(node)) {
        if (row.dataset.tppModal === '1') continue;
        // A post drawn in one of Teams' own panes (a search result, a pinned
        // list) is not the Inbox's or the Archive's: marking it before it has a
        // card is what blanked a found post down to its replies.
        if (inTeamsPane(row)) continue;
        if (row.classList.contains('tpp-post') && row.dataset.tppId) continue;

        const text = previewOf(row) || collapse(row.textContent || '').slice(0, 160);
        if (!text) continue;

        const id = idFor(row, text);
        if (row.dataset.tppId !== id) {
          row.dataset.tppId = id;
          delete row.dataset.tppPainted;
          delete row.dataset.tppTs;
          row.classList.remove('tpp-ready');
        }
        row.classList.add('tpp-post');
        setTag(row, isReadPost(id, timeOf(id, row)) ? 'read' : '');
        markTucked(row, id);
      }
    }
  }

  /**
   * The post rows inside a subtree Teams has just inserted. The node may be one
   * post, a batch of them, or the list itself, so a node that holds only part of
   * its parent's posts is taken as a row, and anything else is walked with the
   * same rule the scan uses.
   */
  function newRows(node) {
    const marker = S.postHeader[0];
    if (!marker) return [];

    let inside = 0;
    try {
      inside = node.querySelectorAll(marker).length;
    } catch (_) {
      return [];
    }
    if (!inside) return [];

    if (!node.classList.contains('tpp-post')) {
      const siblings = node.parentElement
        ? node.parentElement.querySelectorAll(marker).length
        : 0;
      if (siblings > inside) return [node];
    }

    return collectRows(node, false);
  }

  /** Follow-up scans left for a view that has not finished arriving. */
  let settleTries = 0;

  /**
   * Asks for one more scan shortly, for a view that is still half-drawn.
   * Both timers are shared with the observer's own debounce: whichever is due
   * first runs the scan, and a scan settles them both.
   */
  function requestSettleScan() {
    if (settleTries >= 10 || rescanTimer || slowTimer) return;
    settleTries += 1;
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      scan();
    }, 200);
  }

  /**
   * Adds one observer callback to the readout (see scan).
   *
   * Teams mutates the page dozens of times a second, so this callback runs far
   * more often than the scan does — and its cost is invisible to the scan timer.
   * Anything it measures here is our share of a page that is still arriving.
   */
  function recordMutationTime(startedAt) {
    const ms = performance.now() - startedAt;
    perf.mutTotal += ms;
    if (ms > perf.mutMax) perf.mutMax = ms;
  }

  /**
   * The scan after a change.
   *
   * A mounted pane — a channel switch, the Posts tab coming back — is waited on
   * for a fraction of what a settled page's later edit is: the pair has to be
   * back in the strip and the posts drawn, and the follow-ups cover the rest.
   */
  function scheduleScan(urgent) {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      scan();
    }, urgent ? 120 : 300);
  }

  /**
   * The unurgent pass, for a change that cannot have reached the posts.
   *
   * Teams mutates the page constantly — the chat list, timers, the activity feed,
   * a tooltip — and every one of those used to schedule a full scan. This keeps
   * the page reconciled without doing that work several times a second, and a
   * real change cancels it in favour of an immediate scan.
   */
  function scheduleSlowScan() {
    if (slowTimer || rescanTimer) return;
    const tick = () => {
      slowTimer = 0;
      // A hidden tab is not worth a scan of any kind; the churn that would have
      // asked for one carries on when it comes back.
      if (document.hidden) {
        slowTimer = setTimeout(tick, SLOW_SCAN_MS);
        return;
      }
      scan();
    };
    slowTimer = setTimeout(tick, SLOW_SCAN_MS);
  }

  /**
   * Can this subtree bring the posts, the list or the channel furniture with it?
   * Asked only about nodes inserted outside the list, which is where a channel
   * switch and the Posts tab coming back arrive.
   */
  /** A node whose arrival or removal means the channel itself changed. */
  const CHANNEL_SWAP_NODE = '[role="tablist"], [data-tid="channel-pane-message-list"]';

  /**
   * Is this node the channel's furniture being replaced?
   *
   * Our own Inbox/Archive wrap is itself a tab list inside Teams' strip, so it
   * is explicitly not a channel change: without that, putting the pair back
   * would clear the pins it was drawn beside.
   */
  function channelSwapNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === TABS_ID || node.closest?.(`#${TABS_ID}`)) return false;
    try {
      return node.matches(CHANNEL_SWAP_NODE);
    } catch (_) {
      return false;
    }
  }

  const CHANNEL_FURNITURE = [
    '[data-tid="post-message-subheader"]',
    '[data-tid="message-pane-list-runway"]',
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="channel-pane-message-list"]',
    '[data-tid="channel-info-pane-pinned-posts-list"]',
    '[data-tid*="pinned-posts-list" i]',
    '[data-tid="post-compose-collapsed"]',
    '[role="tablist"]'
  ].join(',');

  function channelFurniture(node) {
    // A node carrying a pane's worth of children is a mounted pane, and a pane
    // is always worth a scan. The query below walks the whole subtree, and on a
    // channel switch that subtree is the entire channel — paying for it here,
    // before paint, was part of what made switching feel slow.
    if (node.childElementCount > 6) return true;
    try {
      return Boolean(node.matches(CHANNEL_FURNITURE) || node.querySelector(CHANNEL_FURNITURE));
    } catch (_) {
      return false; // A hand-edited selector should never cost us the page.
    }
  }

  // -------------------------------------------------------------- bootstrap

  function apply() {
    if (!ready) return;
    const html = document.documentElement;
    if (!html) return;

    // A switch or a view change re-derives every row, so the walk is owed.
    listDirty = true;

    syncFeatureFlags();

    // Each switch owns its own marks and nothing else: turning one feature off
    // takes down that feature's work and leaves the other two exactly as they
    // were. Everything is re-derived by the scan below.
    if (!features.inboxZero) {
      html.removeAttribute(HAS_ARCHIVES_ATTR);
      html.removeAttribute(EMPTY_VIEW_ATTR);
      document.getElementById(EMPTY_ID)?.remove();
      for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
      // The filter is off: no post is tucked, tagged or filed any more.
      for (const el of document.querySelectorAll('.tpp-post')) {
        untuck(el);
        if (el.dataset.tppTag !== undefined) delete el.dataset.tppTag;
        delete el.dataset.tppPainted;
      }
    }

    if (!features.compactPosts) {
      // The cards come off and each row goes back to Teams' own layout.
      for (const el of document.querySelectorAll('.tpp-post')) {
        el.classList.remove('tpp-previewed', 'tpp-unfold', 'tpp-ready');
        delete el.dataset.tppCardOf;
        delete el.dataset.tppPainted;
        for (const card of el.querySelectorAll(':scope > [data-tpp-ui="preview"]')) card.remove();
      }
    }

    for (const el of document.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }

    if (!features.inboxZero) clearLeftInset();

    scan();
  }

  /**
   * Is the page on screen a channel's Posts area?
   *
   *   true  — a channel: Teams++ runs here,
   *   false — anywhere else (a chat, Calendar, Files, Calls, the activity feed),
   *   null  — the page is still settling, so nothing is decided yet.
   *
   * The page itself is asked before the route. Teams has changed its URLs more
   * than once — new Teams can sit on a bare path while a channel is open — and a
   * URL-only answer is what switched the extension off everywhere. Channel-only
   * furniture cannot be faked: a Posts tab, a channel tab strip, a post row, or
   * the "Post in channel" box exists in a channel and nowhere else. A chat is
   * settled first and against the DOM as well, because a chat pane on screen is
   * never ours whatever else Teams has left mounted.
   */
  function channelVerdict() {
    const href = String(location.href || '');
    const chatRoute = /\/chat\//i.test(href) || /[?&#]context=chat/i.test(href);
    if (chatRoute) return false;

    const visible = (el) => Boolean(el && el.getClientRects().length);

    // A chat's list or a chat message on screen: this is a chat.
    if (visible(document.querySelector('[data-tid="chat-pane-message-list"]'))) return false;
    if (visible(document.querySelector('[data-tid="chat-pane-message"]'))) return false;

    // A single post in a pane of Teams' own, with no channel tab strip beside
    // it: this is the view Find in channel opens, not the Posts list. There is
    // no Inbox or Archive to be in, and the post on show must not be filtered —
    // so the extension stands down and leaves the page exactly as Teams drew it.
    if (!nativeTabStrip() && teamsPostPane()) return false;

    // Channel-only furniture. The Posts tab is the surest: chats have no tab
    // strip at all, and every channel has one.
    if (document.getElementById(TABS_ID)) return true;
    if (channelTitle()) return true;
    if (nativePostsTab()) return true;
    if (
      visible(
        document.querySelector(
          '[role="tab"][value*="channeltabs" i], [role="tab"][id*="channeltabs" i]'
        )
      )
    ) {
      return true;
    }
    if (
      visible(
        document.querySelector(
          '[data-tid="post-message-subheader"], [data-tid="post-message"], [data-tid="channel-pane-message-list"]'
        )
      )
    ) {
      return true;
    }
    if (
      visible(
        document.querySelector(
          '[data-tid="post-compose-collapsed"], [data-tid*="post-in-channel" i], [data-tid*="channel-compose" i]'
        )
      )
    ) {
      return true;
    }

    // The route, when it names a channel.
    if (/\/channel\//i.test(href) || /[?&](groupId|channelId)=/i.test(href)) return true;

    // The list we would work on: a channel's message list is ours, a chat's is
    // not, and no list at all means the page has not settled.
    const list = findMessageList();
    if (list) {
      if (list.closest('[data-tid*="chat-pane" i]')) return false;
      if (list.querySelector('[data-tid="post-message"], [data-tid="post-message-subheader"]')) {
        return true;
      }
      // The list is there but nothing has been rendered in it yet. That is what
      // a loading batch looks like, and it is not evidence of having left the
      // channel: answering "no" here switched the extension off for a scan and
      // rebuilt it on the next, and the pinned bars went with it every time.
      return null;
    }

    return null;
  }

  /**
   * Writes the feature flags onto <html>, which is what teams.css hangs every
   * style off. Outside a channel they all come off, so a chat is never dressed
   * as a channel's Posts list even for a moment.
   */
  function syncFeatureFlags() {
    const html = document.documentElement;
    if (!html || !features) return;

    for (const feature of FEATURES) {
      if (channelMode && features[feature.id]) html.setAttribute(feature.attr, '');
      else html.removeAttribute(feature.attr);
    }

    // The tag alone decides which view shows a post (teams.css), so the view is
    // published once here and a Teams re-render cannot resurrect a hidden post.
    if (channelMode && features.inboxZero) html.setAttribute('data-tpp-view', view);
    else html.removeAttribute('data-tpp-view');

    if (!channelMode) html.removeAttribute(HAS_ARCHIVES_ATTR);
  }

  /**
   * Takes down everything Teams++ drew, for a page that is not a channel.
   *
   * The flags already stop the styles; this removes what was injected into the
   * page itself — tabs, pin bars, the empty state, the rail and
   * every mark on a row — so a chat is exactly as Teams made it.
   */
  function teardownChannelUi() {
    uiDrawn = false;
    perf.loadStartedAt = 0;
    settleTries = 0;
    listDirty = true;
    lastScrollBox = null;
    titleObserver?.disconnect();
    titleObserver = null;
    titleEl = null;
    for (const id of [TABS_ID, EMPTY_ID, TOAST_ID, CONFETTI_ID]) {
      document.getElementById(id)?.remove();
    }

    lastList = null;
    listRect = null;

    releaseNativeTab();
    clearTopInset();
    clearLeftInset();

    for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
    for (const el of document.querySelectorAll('.tpp-post')) clearPostUi(el);
    for (const el of document.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }
    if (roomEl) {
      roomEl.style.removeProperty('--tpp-room');
      if (roomEl.dataset.tppRoom !== undefined) delete roomEl.dataset.tppRoom;
    }
    roomEl = null;

    document.documentElement.removeAttribute(HAS_ARCHIVES_ATTR);
    document.documentElement.removeAttribute(EMPTY_VIEW_ATTR);

    if (roomEl && roomEl.dataset.tppRoom !== undefined) delete roomEl.dataset.tppRoom;
    roomEl = null;
  }

  async function bootstrap() {
    const items = await readSync({
      [STORAGE_KEY]: null,
      [UNREAD_KEY]: null,
      [LEGACY_ARCHIVE_KEY]: null,
      [SINCE_KEY]: null,
      [LEGACY_PINS_KEY]: null,
      [VIEW_KEY]: null
    });

    features = normalize(items[STORAGE_KEY]);
    readState = normalizeMap(items[UNREAD_KEY], READ_LIMIT);
    try {
      const local = await chrome.storage.local.get(ACTIVITY_KEY);
      activityState = normalizeActivity(local && local[ACTIVITY_KEY]);
    } catch (_) {
      activityState = {};
    }

    // Entries an older build inferred from Teams' "New" badge and "Last read"
    // line are r: 0 with no `c`; they are the sweep, not the user's own marks.
    // A latch this build wrote from the badge carries `n` and is kept: that is
    // what holds a New post in the Inbox after Teams clears the badge.
    let dropped = false;
    for (const [id, entry] of Object.entries(readState)) {
      if (entry.r === 0 && entry.c !== 1 && entry.n !== 1) {
        delete readState[id];
        dropped = true;
      }
    }
    if (dropped) writeSync({ [UNREAD_KEY]: readState });

    // The line the whole model is built on. Set once, at the first run: every
    // post already in a channel is older than it, and every post since is newer.
    since = Number(items[SINCE_KEY]) || 0;
    if (!(since > 0)) {
      since = Date.now();
      writeSync({ [SINCE_KEY]: since });
    }
    // The build before read state kept its archive tags here. A post with no
    // entry is read now, so that map has nothing left to say — it is dropped so
    // it stops spending the sync quota.
    if (items[LEGACY_ARCHIVE_KEY]) {
      chrome.storage.sync.remove(LEGACY_ARCHIVE_KEY, () => void chrome.runtime.lastError);
    }

    // Keys older builds left behind: their own pins in sync storage, and the
    // pinned-list cache in local storage. Nothing reads either now, so they are
    // cleared rather than left spending the quota.
    if (items[LEGACY_PINS_KEY]) {
      chrome.storage.sync.remove(LEGACY_PINS_KEY, () => void chrome.runtime.lastError);
    }
    try {
      chrome.storage.local.remove('teamsPlusPlus.channelPins', () => void chrome.runtime.lastError);
    } catch (_) {
      // No local storage: there is no cache to clear.
    }
    view = normalizeView(items[VIEW_KEY]);
    ready = true;
    apply();
  }

  function start() {
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }

    document.documentElement.setAttribute('data-tpp-build', BUILD);

    // A readout for investigating slowness, off unless asked for: set
    // `localStorage.tppPerf = '1'` in the page's console, reload, and
    // `<html data-tpp-perf="...">` carries the scan counts and timings.
    try {
      perf.on = localStorage.getItem('tppPerf') === '1';
    } catch (_) {
      perf.on = false; // Storage can be blocked; the counters simply stay off.
    }

    // Paint the right theme before anything of ours is drawn.
    applyTheme();

    // Teams flips light and dark by swapping a class or an attribute rather
    // than reloading, so watch for that and for the OS setting. Both are cheap:
    // applyTheme does nothing unless the answer actually changed.
    const themeWatch = new MutationObserver(() => applyTheme());
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      themeWatch.observe(node, {
        attributes: true,
        attributeFilter: ['class'].concat(THEME_HINTS)
      });
    }
    if (window.matchMedia) {
      const scheme = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => applyTheme();
      if (scheme.addEventListener) scheme.addEventListener('change', onChange);
      else if (scheme.addListener) scheme.addListener(onChange);
    }

    observer = new MutationObserver((records) => {
      if (!ready) return;
      const callbackAt = perf.on ? performance.now() : 0;
      if (perf.on) perf.batches += 1;

      // Before the scan's debounce: a post Teams has just inserted is closed up
      // now, so a fetched batch never paints at full height and then collapses.
      // Only nodes that can hold a post are handed over, and only a batch's
      // worth of them: Teams mounts whole panes on a channel switch, and walking
      // every one of those subtrees is what made switching feel slow.
      if (channelMode === true) {
        // Two kinds of insert, and they want opposite treatment. A batch of
        // posts arriving inside the list is absorbed here, before paint, so a
        // fetched or re-rendered post is never drawn at full height and then
        // tucked — a post "loading and quickly hiding" is exactly that. A
        // mounted pane outside the list (a channel switch, the Posts tab coming
        // back) is left to the scan: walking it before paint is the stall.
        const inList = [];
        const mounted = [];
        let relevant = false;
        let switched = false;
        let listLost = false;
        let full = false;
        for (const record of records) {
          const target = record.target;
          if (lastList && target && (target === lastList || lastList.contains(target))) {
            relevant = true;
          }
          // The list itself going away is the biggest change there is.
          for (const node of record.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (lastList && node.contains(lastList)) {
              relevant = true;
              switched = true;
              listLost = true;
            }
            if (channelSwapNode(node)) switched = true;
          }
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (channelSwapNode(node)) switched = true;
            // Anything landing inside the list can only be posts.
            if (lastList && lastList.contains(node)) {
              inList.push(node);
              relevant = true;
              if (inList.length >= 60) {
                full = true;
                break;
              }
              continue;
            }
            // Nothing else reaches the posts unless it brings channel furniture
            // with it: a chat preview or a timer cannot.
            if (!channelFurniture(node)) continue;
            mounted.push(node);
            relevant = true;
            if (mounted.length >= 60) {
              full = true;
              break;
            }
          }
          if (full) break;
        }
        // The posts (or the list itself) have changed: the row walk is owed.
        if (switched || listLost || inList.length) listDirty = true;
        // A new channel is in front: its pins are not the ones on screen.
        if (switched) resetForChannelChange();
        // Any count of rows inside the list: the tuck has to land before the
        // browser paints, or the post shows for a moment and then disappears.
        if (inList.length) absorbNodes(inList);
        // A pane is not a batch: only a handful of nodes is worth walking
        // before paint, and a switch is left to the scan it schedules.
        if (mounted.length && mounted.length <= 6) absorbNodes(mounted);
        if (relevant) {
          if (perf.on) perf.relevant += 1;
          scheduleScan(true);
        } else scheduleSlowScan();
      } else {
        scheduleScan();
      }
      if (perf.on) recordMutationTime(callbackAt);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Restore the feature flags if Teams rewrites <html>.
    new MutationObserver(() => {
      if (!ready || !channelMode) return;
      const html = document.documentElement;
      const missing = FEATURES.some(
        (feature) => features[feature.id] && !html.hasAttribute(feature.attr)
      );
      if (missing) apply();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: FEATURES.map((feature) => feature.attr)
    });

    document.addEventListener('click', onPostClick, true);
    document.addEventListener('keydown', onPostKeyDown, true);
    window.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });
    window.addEventListener('resize', reposition);

    bootstrap();
  }

  // Keep an open tab in sync when settings, archives or activity change elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!ready) return;
    if (area === 'local') {
      if (changes[ACTIVITY_KEY]) {
        activityState = normalizeActivity(changes[ACTIVITY_KEY].newValue);
      }
      return;
    }
    if (area !== 'sync') return;
    if (changes[STORAGE_KEY]) features = normalize(changes[STORAGE_KEY].newValue);
    if (changes[UNREAD_KEY]) {
      readState = normalizeMap(changes[UNREAD_KEY].newValue, READ_LIMIT);
    }
    if (changes[SINCE_KEY]) since = Number(changes[SINCE_KEY].newValue) || since;
    if (changes[VIEW_KEY]) view = normalizeView(changes[VIEW_KEY].newValue);
    if (features) apply();
  });

  // At document_start the parser may not have created <html> yet.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
