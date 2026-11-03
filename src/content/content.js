/**
 * Teams++ content script.
 *
 * Two features live here:
 *
 *   Inbox Zero      Every post is read or unread, and every post gets an
 *                   Archive button in its left margin; comments and replies
 *                   never get one. Read state is Teams++'s own: the moment the
 *                   extension was installed is stored once, and a post stamped
 *                   later is unread until the Archive button files it.
 *                   Everything already in the channel is read. Teams' New
 *                   badge and Last read line are not shown — the Inbox and
 *                   Archive tabs are the marker now.
 *
 *   Pinned posts    Posts a channel moderator has pinned for everyone sit in
 *                   purple bars directly under the channel menu bar, above the
 *                   "Post in channel" box. A bar opens the post where it sits in
 *                   the stream, through Teams' own pinned list, so the bar never
 *                   carries a copy of the post.
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
  /** A channel is identified by its id, under this prefix. */
  const CHANNEL_PREFIX = 'channel:';
  /** How long a bar Teams pinned is kept after the post stops being rendered. */
  const NATIVE_PIN_TTL = 5 * 60 * 1000;
  /** How long a pin Teams no longer lists is kept before its bar goes. */
  const PIN_MISSING_GRACE = 1500;
  /** How long a post the user just unpinned is kept clear of a returning bar. */
  const UNPIN_HOLD = 60 * 1000;

  const VIEW_INBOX = 'inbox';
  const VIEW_ARCHIVES = 'archives';

  const TABS_ID = 'tpp-tabs';
  const PROGRESS_ID = 'tpp-progress';
  const STACK_ID = 'tpp-pin-stack';
  const EMPTY_ID = 'tpp-empty-state';
  const TOAST_ID = 'tpp-toast';
  /** How long a post takes to slide out of the Inbox when it is archived. */
  const ARCHIVE_ANIM_MS = 300;
  const HAS_ARCHIVES_ATTR = 'data-tpp-has-archives';
  /** Set when the current view has no post on show at all (teams.css). */
  const EMPTY_VIEW_ATTR = 'data-tpp-empty-view';
  /** The pin model, serialised onto <html> so DevTools can read it (see below). */
  const PIN_DEBUG_ATTR = 'data-tpp-pin-debug';
  /** When the debug attribute was last written: it is a readout, not a feature. */
  let pinDebugAt = 0;
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
  const BUILD = '2026-11-02.92';
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

  const PIN_FILLED_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6z"/><path d="M12 15v6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  /** A solid box, for the "this post is archived" state, like a filled pin. */
  const ARCHIVE_FILLED_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="5" rx="1.2" fill="currentColor"/><path fill="currentColor" d="M4 10h16v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5z"/></svg>';
  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const EMPTY_ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 13h4"/></svg>';
  /** The small chevron on a folded post's card: this card opens. */
  const CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  let ready = false;
  let features = null;
  /**
   * id -> { t, r, c } — the decisions the user made: r: 0 unread, 1 read, and
   * c: 1 for a click (which is what lets the row close up behind itself). A post
   * with no entry is judged by its timestamp against `since`, below.
   */
  let readState = {};
  /** When the extension was installed, in ms. Posts stamped later are unread. */
  let since = 0;
  /**
   * The channel the bars belong to. Teams' pins are per channel, and every bar
   * on screen is this channel's.
   */
  let pinChannel = '';
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

  /** id -> { row, id, text, author, read, ts } for the latest scan. */
  let rowsById = new Map();
  /**
   * id -> { id, text, paneText, author, seenAt } for posts Teams itself pinned.
   *
   * Kept, not rebuilt: Teams stops rendering a post as soon as it scrolls out of
   * the virtualised list, and closes the "Pinned" accordion as well, and a bar
   * that existed only while the post happened to be on screen went and came back
   * with every batch. Entries are pruned by age, by channel, and on unpin.
   */
  let nativePins = new Map();
  /** When the bar list first came up empty, so a transient gap is not a removal. */
  let emptyPinsAt = 0;
  /** Posts the user unpinned recently: no remembered or harvested bar may return. */
  const recentUnpins = new Map();
  /** Set when the user unpinned, so the bars are redrawn without the grace. */
  let explicitPinChange = false;
  /** The last channel key that named a real channel id, kept against route churn. */
  let pinnedChannelKey = '';

  let observer = null;
  let lastList = null;
  let listRect = null;
  /** The box whose own top padding holds the room the pinned bars take. */
  let pinHost = null;
  /** When the theme was last re-checked from the scan (it is not free). */
  let themeAt = 0;
  /** The channel's own "Posts" tab while our tabs stand in for it. */
  let hiddenNativeTab = null;
  /** The walk through the channel that is looking for a pinned post. */
  let pinJump = null;
  /** Which jump's top alignment is current, so an older one stops correcting. */
  let pinAlignToken = 0;
  /** The button that abandons that walk. */
  let searchCancelBtn = null;
  /** Posts the user has unfolded in the compact view, by id. */
  const unfolded = new Set();
  /** Set while a click we generated is in flight, so it is not read as the user's. */
  let forwardingClick = false;
  let rescanTimer = 0;
  /** The switch bar, and the two timers that keep it honest. */
  let progressOn = false;
  let progressShownAt = 0;
  let progressHideTimer = 0;
  let progressLimitTimer = 0;
  let slowTimer = 0;
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

    console.info('[Teams++] post activated', {
      build: BUILD,
      target: target ? target.id || target.tagName : 'none',
      active: document.activeElement
        ? document.activeElement.id || document.activeElement.tagName
        : 'none'
    });
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
    for (const selector of S.messageList || []) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (_) {
        continue; // A bad selector from a hand edit should not stop the rest.
      }
      // The last-resort `div[role="log"]` anchor also matches the aria-live
      // region Teams keeps beside a message editor. Taken for the list, it
      // parks our gutter padding, the pinned bars and the empty state inside
      // the reply box, which clips the reply area's own controls. A candidate
      // inside a compose field is never the list.
      if (found && !isComposeField(found)) return found;
    }

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
   * The subject Teams prints above a post's text: its own heading, which sits
   * beside the body rather than in it. Read every time — `textContent` needs no
   * line boxes, so this works on a post that is folded away onto its bar.
   */
  function headingOf(row) {
    if (!row) return '';
    const el = first(S.messageSubject, row);
    return el ? collapse(el.textContent || '').slice(0, 140) : '';
  }

  /**
   * The line a pinned bar shows after the author: the post's subject line. Only
   * a post Teams prints no heading on falls back to its first written line,
   * which is where the message starts. Only pinned posts are asked for it, since
   * reading layout text is not free and the list is scanned on every Teams
   * render.
   */
  function subjectOf(row) {
    const heading = headingOf(row);
    if (heading) return heading;
    if (!row) return '';
    const body = first(S.messageBody, row) || row;
    const lines = String(body.innerText || body.textContent || '').split(/\n+/);
    for (const line of lines) {
      const text = collapse(line);
      if (text) return text.slice(0, 140);
    }
    return '';
  }

  /**
   * What a pinned bar shows after the subject: the rest of the post, once the
   * subject line has been taken off the front of it.
   */
  function snippetOf(row, subject) {
    if (!row) return '';
    const body = previewOf(row);
    const lead = collapse(subject || '');
    let rest = body;
    if (lead && rest.startsWith(lead)) rest = rest.slice(lead.length);
    rest = rest.replace(/^[\s\-–—:|,.]+/, '');
    return rest.slice(0, 160);
  }

  function isNativePinned(row) {
    // Almost no post is pinned, so the cheap question is asked first: does this
    // row mention a pin at all? One text read against a walk of every element
    // in the post, on every scan, is the difference this makes.
    let mentionsPin = /pinned/i.test(row.textContent || '');
    if (!mentionsPin) {
      try {
        mentionsPin = Boolean(
          row.querySelector('[data-tid*="pinned" i], [aria-label*="pinned" i], [title*="pinned" i]')
        );
      } catch (_) {
        mentionsPin = false;
      }
    }
    if (!mentionsPin) return false;

    const body = first(S.messageBody, row);

    for (const el of row.querySelectorAll(S.nativePin.join(','))) {
      if (el.closest('.tpp-post-actions')) continue;
      // A post that merely quotes the word "pinned" is not a pinned post.
      if (body && body.contains(el)) continue;
      return true;
    }

    // Teams sometimes shows a plain "Pinned" / "Pinned by …" label instead.
    for (const el of row.querySelectorAll('span, div')) {
      if (el.closest('.tpp-post-actions')) continue;
      if (body && body.contains(el)) continue;
      const text = collapse(el.textContent || '');
      if (text && text.length < 50 && /^pinned(\s+by\b.+)?$/i.test(text)) return true;
    }

    return false;
  }

  /**
   * True when the row is a comment or a reply rather than a post of its own.
   * Only posts get archive/pin controls, so these rows are ignored entirely.
   */
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
      if (el.closest('.tpp-post-actions, .tpp-pin-stack, .tpp-empty-state, .tpp-tabs')) return false;
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

      // A post the user has just unpinned stays unpinned here too: Teams keeps
      // its own pin marker for a moment after the request, and reading it would
      // put the bar straight back.
      const nativePinned = isNativePinned(row) && !isRecentlyUnpinned(id);
      const authored = authorOf(row);
      // A bar reads "Author: subject line", so only pinned posts pay for it.
      // A pinned post is hidden in the stream, where there are no line boxes for
      // innerText to take the first line from, so the line is remembered while
      // the post is visible and reused after it moves onto its bar.
      let subject = text;
      if (nativePinned) {
        // The heading is read every time: it is text, not layout, so it works on
        // a post folded away onto its bar. The remembered copy is the fallback
        // for a post Teams prints no heading on, where the first line can only
        // be read while the post still has line boxes.
        subject = headingOf(row) || row.dataset.tppSubject || subjectOf(row) || text;
        if (row.dataset.tppSubject !== subject) row.dataset.tppSubject = subject;
      }

      // The whole model: a read post is tagged, an unread one is not. The stamp
      // is read once here and kept on the row: every later question about this
      // post (filtering, tucking, the scroll limit) reuses it instead of asking
      // the DOM again, which was several selectors per post on every scan.
      const ts = timeOf(id, row);
      row.dataset.tppTs = String(ts || 0);
      setTag(row, isReadPost(id, ts) ? 'read' : '');
      if (row.dataset.tppNativePin !== (nativePinned ? '1' : '0')) {
        row.dataset.tppNativePin = nativePinned ? '1' : '0';
      }
      paintRow(row, nativePinned);

      if (nativePinned) rememberNativePin('row:' + id, { id, text: subject, author: authored });
      next.set(id, {
        row,
        id,
        text,
        author: authored,
        read: row.dataset.tppTag === 'read',
        ts
      });
    }

    rowsById = next;
    if (features.pinnedMessages) {
      harvestPinnedPane();
      // Without Teams' list on screen, a rendered row is the only evidence there
      // is: a post that no longer carries Teams' pin marker is not pinned.
      if (!first(S.pinnedPane)) sweepNativePins(null);
      pruneNativePins();
    }
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

    const filtered =
      Boolean(id) &&
      features &&
      features.inboxZero &&
      !isSpotlit(row) &&
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
      // the list with no post under it, which is how a lone Archive/Pin pair
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
      paintRow(row, row.dataset.tppNativePin === '1');
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
  function paintRow(row, nativePinned) {
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

    const painted = [
      tag,
      nativePinned ? '1' : '0',
      features.inboxZero ? '1' : '0',
      // A pinned post keeps its Archive button in the Archive and has none in
      // the Inbox, so the rail a row needs differs by tab.
      view
    ].join('|');

    const railGone = features.inboxZero && !row.querySelector('.tpp-post-actions');
    if (row.dataset.tppPainted !== painted || railGone) {
      row.dataset.tppPainted = painted;
      injectActions(row, tag === 'read', nativePinned);
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
      paintRow(row, row.dataset.tppNativePin === '1');
    }
  }

  /**
   * Repaints the row for a post whose pin state just changed.
   *
   * The rail is decided from whether Teams has the post pinned, so it has to be
   * redrawn at the moment that changes: waiting for a scan left an unpinned post
   * still without its Archive button, which is what made unpinning look like it
   * had not worked.
   */
  function repaintPinned(id) {
    if (!id) return;
    for (const row of document.querySelectorAll('.tpp-post')) {
      if (row.dataset.tppId !== id) continue;
      paintRow(row, row.dataset.tppNativePin === '1');
    }
  }

  /** The snippet Teams shows for one pinned post in its sidebar list. */
  function paneItemText(item) {
    const el =
      item.querySelector('[data-tid*="pinned-post-item-text-content" i]') ||
      item.querySelector('[data-tid*="text-content" i]');
    if (el) return collapse(el.textContent || '');

    const first = item.querySelector('[dir="auto"]');
    return first ? collapse(first.textContent || '') : '';
  }

  /** The author on a pinned item's meta line ("Jonathan Kung, Saturday 8:54 p.m."). */
  function paneItemAuthor(item, text) {
    for (const span of item.querySelectorAll('[dir="auto"]')) {
      const value = collapse(span.textContent || '');
      if (!value || value === text) continue;
      const author = value.split(',')[0].trim();
      if (author && author.length <= 60) return author;
    }
    return '';
  }

  /**
   * The channel post a pinned sidebar item points at. The item carries a snippet
   * of the post, not its id, so the post is found by its words — the author
   * breaks ties when two posts start the same way.
   */
  function pinnedSidebarPost(text, author) {
    const wanted = collapse(text).toLowerCase();
    if (wanted.length < 4) return null;

    let best = null;
    for (const record of rowsById.values()) {
      const preview = collapse(record.text || '').toLowerCase();
      // A pinned item's line is the post's subject, while the row's preview is
      // the message itself. The heading is what makes the two the same post, and
      // without it a pinned item is filed as an id-less pin — which is the bar
      // that cannot show the body, next to the one that can.
      const heading = collapse(
        headingOf(record.row) || record.row?.dataset.tppSubject || ''
      ).toLowerCase();
      let score = 0;
      if (preview.startsWith(wanted)) score = 2;
      else if (preview.includes(wanted)) score = 1;
      else if (wanted.startsWith(preview) && preview.length >= 4) score = 1;
      else if (
        heading.length >= 4 &&
        (heading === wanted || heading.startsWith(wanted) || wanted.startsWith(heading))
      ) {
        score = 2;
      }
      if (!score) continue;

      if (author && record.author && record.author.toLowerCase() === author.toLowerCase()) {
        score += 3;
      }
      if (!best || score > best.score) best = { record, score };
    }
    return best ? best.record : null;
  }

  /**
   * Picks up the posts pinned for the whole channel from Teams' own list.
   *
   * The "Pinned" accordion in the "In this channel" sidebar is the reliable
   * sign of a moderator's pin: it lists exactly the posts pinned for everyone,
   * and nothing a user pinned for themselves. That is what makes such a bar
   * unpinnable for a regular user — Teams only offers an unpin control to people
   * who may pin in the channel.
   *
   * A pin whose post is not loaded is still shown: clicking its bar then walks
   * the channel back through its history to find it.
   */
  /**
   * Remembers a post pin Teams itself knows about.
   *
   * A bar must outlive the row it was read from: Teams drops rows out of its
   * virtualised list and closes the "Pinned" accordion as its pane re-renders,
   * so a map rebuilt on every scan made the bar blink in and out with the posts.
   */
  function rememberNativePin(key, entry) {
    const seen = nativePins.get(key);
    const next = { ...(seen || {}), ...entry, seenAt: Date.now() };
    // Seen again: the absence that was being timed is over.
    delete next.missingAt;
    nativePins.set(key, next);
  }

  /** Drops every bar a post still wears after it was unpinned in Teams. */
  function forgetNativePin(id) {
    if (!id) return;
    for (const [key, pin] of nativePins) {
      if (pin && pin.id === id) nativePins.delete(key);
    }
  }

  /** Forgets bars for posts Teams has stopped showing for a long time. */
  function pruneNativePins() {
    const now = Date.now();
    for (const [key, pin] of nativePins) {
      if (now - (pin.seenAt || 0) > NATIVE_PIN_TTL) nativePins.delete(key);
    }
  }

  /**
   * Erases the bars of pins Teams no longer has.
   *
   * `listed` is Teams' own pinned list while it is on screen — the whole
   * channel's pins, and the truth on the subject — or null when it is not. A bar
   * stays while either Teams still lists the post or the post still carries
   * Teams' pin marker; it is removed after a short absence, so a re-render of the
   * list cannot blink it out and back again.
   */
  function sweepNativePins(listed) {
    const now = Date.now();
    for (const [key, pin] of nativePins) {
      if (!pin) continue;
      // Without a post id there is nothing to be absent from anywhere: such a bar
      // is only ever aged out (pruneNativePins).
      if (!pin.id) continue;
      if (listed && listed.has(pin.id)) continue;

      const row = findRow(pin.id);
      if (row && row.dataset.tppNativePin === '1') continue;
      if (isRecentlyUnpinned(pin.id)) continue;
      // A post with no row rendered can only be judged by Teams' list; with no
      // list either, age is the only word there is (pruneNativePins).
      if (!row && !listed) continue;

      if (!pin.missingAt) {
        nativePins.set(key, { ...pin, missingAt: now });
        continue;
      }
      if (now - pin.missingAt < PIN_MISSING_GRACE) continue;
      nativePins.delete(key);
    }
  }

  function harvestPinnedPane() {
    const pane = first(S.pinnedPane);
    if (!pane) return;

    const listed = new Set();

    for (const item of pane.querySelectorAll('[role="menuitem"]')) {
      const text = paneItemText(item);
      if (!text) continue;

      const author = paneItemAuthor(item, text);
      const record = pinnedSidebarPost(text, author);
      const id = record ? record.id : '';
      if (id) listed.add(id);

      // The user has just unpinned this post: Teams' list has not caught up yet,
      // and re-filing it here is the bar that refused to go away.
      if (id && isRecentlyUnpinned(id)) continue;

      // Keyed by post id, so one post can never grow two bars. The item's own
      // words are kept with it: they are what finds the item again after Teams
      // has re-rendered its list.
      rememberNativePin(id ? 'pane:' + id : 'pane:item:' + hash(text), {
        id,
        text: record
          ? headingOf(record.row) || record.row.dataset.tppSubject || subjectOf(record.row) || text
          : text,
        paneText: text,
        author: record ? authorOf(record.row) || author : author,
        paneItem: item
      });
    }

    sweepNativePins(listed);
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
  function injectActions(row, isArchived, nativePinned) {
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
    const pinnedNow = Boolean(nativePinned);
    // A pinned post keeps no Archive button in the Inbox: its bar points at the
    // post, and a post hidden in the Archive is a bar with nowhere to go. In the
    // Archive it is just a filed post — its pin lives in the Inbox — so
    // unfiling it is still on offer there.
    archiveBtn.hidden = !features.inboxZero || (pinnedNow && view !== VIEW_ARCHIVES);
    archiveBtn.disabled = false;
    // An archived post reads as archived the same way a pinned one reads as
    // pinned: a white box in a filled purple circle, which is also the control
    // that puts the post back.
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

  /** True while Teams has this post pinned for the channel. */
  function isPinnedPost(id) {
    if (!id) return false;
    const row = findRow(id);
    return Boolean(row && row.dataset.tppNativePin === '1');
  }

  /**
   * Marks one post read (archived) or unread (back in the Inbox).
   *
   * This is the only thing that changes a post's state after its first scan.
   * Teams' own read receipt is not consulted, because it clears by itself a few
   * seconds after the channel opens.
   */
  function setRead(id, wantRead) {
    if (!id) return;

    // A pinned post is the target of its bar, so it is never archived from
    // under the bar: unpinning comes first.
    if (wantRead && isPinnedPost(id)) {
      toast('A post pinned for the channel stays put until it is unpinned.', anchorFor(id));
      return;
    }
    // The post is about to be hidden (or shown again), so the message keeps
    // hold of where it was: the news belongs on the post itself.
    const where = anchorFor(id);

    if (wantRead) {
      // The tag is what hides a post, so it is written once the post has left:
      // one that disappears in the same frame reads as a glitch, not an archive.
      const row = findRow(id);
      animateOut(row ? [row] : [], 'right', () => {
        remember(id, true);
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
  function remember(id, isRead) {
    delete readState[id];
    readState[id] = { t: Date.now(), r: isRead ? 1 : 0, c: 1 };
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

  // ------------------------------------------------------------ pinned bars

  /** Teams' own unpin control inside `root`, when it renders one there. */
  function unpinAffordance(root) {
    if (!root) return null;
    const direct = first(S.unpinControl, root);
    if (direct) return direct;

    for (const el of root.querySelectorAll('button, [role="menuitem"], [role="button"]')) {
      const text = `${el.getAttribute('aria-label') || ''} ${el.title || ''}`;
      if (/unpin/i.test(text)) return el;
    }
    return null;
  }

  /**
   * Whether this user may take a Teams pin down. Teams only renders its own
   * unpin control for people allowed to pin in the channel, so its presence is
   * the permission signal — in the post itself, or in the sidebar's pinned list.
   * Without it the bar shows a plain pin that no hover or click will turn into
   * an action, though it still jumps to the post.
   */
  function canUnpinNative(id, paneItem) {
    if (unpinAffordance(findRow(id))) return true;
    return Boolean(unpinAffordance(paneItem));
  }

  /**
   * The bars: one per post a channel moderator has pinned for everyone.
   *
   * Teams' own pin is the only pin drawn. Teams++ adds none of its own, so the
   * bars say exactly what Teams says the channel has pinned, and there is
   * nothing of ours to keep in step with it.
   */
  function buildPinEntries() {
    // Teams describes one pin twice: as an item in its sidebar list, and as a
    // marker on the post itself. Both are filed under the same post id once the
    // item is matched to its row, and the entry that carries the post's own
    // words is the one kept — a bar with a body, never an empty copy of it
    // beside it.
    const byPost = new Map();

    for (const pin of nativePins.values()) {
      if (pin.id && isRecentlyUnpinned(pin.id)) continue;
      const record = pin.id ? rowsById.get(pin.id) : null;
      const entry = {
        ...pin,
        kind: 'native',
        snippet: snippetOf(record?.row, pin.text)
      };
      // With no id yet, the words are the identity: the item and the row say the
      // same subject, so they collapse to one bar even before they are matched.
      const key = pin.id
        ? `id:${pin.id}`
        : `text:${collapse(pin.paneText || pin.text || '').toLowerCase()}`;
      const held = byPost.get(key);
      if (!held) {
        byPost.set(key, entry);
        continue;
      }
      // One record has the body (the post's own marker) and the other has the
      // sidebar item (which is what opens the post): the bar keeps both.
      if (!held.snippet && entry.snippet) {
        byPost.set(key, {
          ...entry,
          paneItem: entry.paneItem || held.paneItem,
          paneText: entry.paneText || held.paneText
        });
      } else {
        if (!held.paneItem && entry.paneItem) held.paneItem = entry.paneItem;
        if (!held.paneText && entry.paneText) held.paneText = entry.paneText;
      }
    }

    // Read once the two records are merged: whether Teams offers its own unpin
    // control can depend on the sidebar item the bar ended up with.
    const entries = [...byPost.values()];
    for (const entry of entries) entry.canUnpin = canUnpinNative(entry.id, entry.paneItem);
    return entries;
  }

  /** Remembers an unpin, so the bar cannot be rebuilt from what Teams still lists. */
  function holdUnpinned(id) {
    if (!id) return;
    recentUnpins.set(id, Date.now());
  }

  function isRecentlyUnpinned(id) {
    const at = recentUnpins.get(id);
    if (!at) return false;
    if (Date.now() - at < UNPIN_HOLD) return true;
    recentUnpins.delete(id);
    return false;
  }

  /** Whether this channel has any pin record at all. */
  function hasPinRecords() {
    return nativePins.size > 0;
  }

  /** A pin's stable name: one post can only ever have one bar. */
  function pinKey(entry) {
    if (entry.id) return `${entry.kind}:${entry.id}`;
    return `${entry.kind}:text:${collapse(entry.text || entry.author || '').toLowerCase()}`;
  }

  /** The pin each bar currently stands for, so a re-render never loses its post. */
  const pinEntryOf = new WeakMap();
  /** The box the bars are anchored to, kept until it leaves the page. */
  let pinAnchorEl = null;
  /** Whether a bar has been placed at all, so a transient gap cannot hide it. */
  let pinPlaced = false;
  /** A route key read once and not yet acted on (see syncPinChannel). */
  let pinChannelNext = '';
  /** When the message list first went missing, in ms, or 0 while it is there. */
  let listMissingAt = 0;
  /** When the verdict first said "not a channel", in ms, or 0 while it says yes. */
  let notChannelAt = 0;

  /**
   * One pinned post: a purple bar that takes the user to the post where it sits
   * in the stream. The bar keeps the pinned area compact and never moves or
   * copies the post, so everything inside it stays Teams' own.
   */
  function pinBar(entry) {
    const item = document.createElement('div');
    item.className = `tpp-pin-item tpp-pin-item--${entry.kind}`;
    item.dataset.tppUi = 'pin-bar';
    item.dataset.tppKey = pinKey(entry);
    pinEntryOf.set(item, entry);

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'tpp-pin-bar';
    bar.dataset.tppUi = 'pin-summary';
    bar.title = 'Open this pinned post in the channel';

    const title = document.createElement('span');
    title.className = 'tpp-pin-bar-title';
    title.textContent = `${entry.author ? `${entry.author}: ` : ''}${entry.text || 'Pinned post'}`;

    const snippet = document.createElement('span');
    snippet.className = 'tpp-pin-bar-snippet';
    snippet.textContent = entry.snippet || '';

    bar.append(title, snippet);

    bar.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The entry is re-read at click time: a scan may have refreshed it since
      // the bar was built.
      const host = event.currentTarget.closest('.tpp-pin-item');
      jumpToPin((host && pinEntryOf.get(host)) || entry, bar);
    });

    const unpin = pinUnpinButton(entry);
    if (unpin) item.append(unpin);
    item.append(bar);
    return item;
  }

  /**
   * The bar's own unpin button, on its left: taking a pin down is the thing
   * people do most from the bar, so it is a click, not a trip to the post.
   */
  function pinUnpinButton(entry) {
    if (!entry.canUnpin) return null;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tpp-pin-unpin';
    button.dataset.tppUi = 'unpin';
    button.dataset.tppUnpin = 'native';
    button.title = 'Unpin this post for everyone';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = PIN_FILLED_SVG;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      unpinNative(entry.id);
    });
    return button;
  }

  /** Brings an existing bar up to date in place, without rebuilding it. */
  function updatePinItem(item, entry) {
    pinEntryOf.set(item, entry);

    const title = item.querySelector('.tpp-pin-bar-title');
    const unpin = item.querySelector('.tpp-pin-unpin');
    const wantedUnpin = entry.canUnpin ? 'native' : '';
    if ((unpin ? unpin.dataset.tppUnpin : '') !== wantedUnpin) {
      unpin?.remove();
      const fresh = pinUnpinButton(entry);
      if (fresh) item.insertBefore(fresh, item.firstChild);
    }

    const snippet = item.querySelector('.tpp-pin-bar-snippet');
    const nextTitle = `${entry.author ? `${entry.author}: ` : ''}${entry.text || 'Pinned post'}`;
    if (title && title.textContent !== nextTitle) title.textContent = nextTitle;
    if (snippet && snippet.textContent !== (entry.snippet || '')) {
      snippet.textContent = entry.snippet || '';
    }
  }

  // ------------------------------------------------------- pinned post jump

  /**
   * The post a pin points at. Its id is tried first; if Teams has re-rendered
   * the row since it was tagged, Teams' own id anchors and finally the pin's
   * own words are used, so a post that is on the page is always found.
   */
  function resolveRow(entry) {
    if (!entry) return null;

    if (entry.id) {
      const byId = findRow(entry.id);
      if (byId) return byId;

      // Tagging runs on a debounce; Teams' own anchors are there immediately.
      const raw = entry.id.startsWith('m:') ? entry.id.slice(2) : entry.id;
      for (const name of ['data-mid', 'data-message-id', 'data-item-id']) {
        let found = null;
        try {
          found = document.querySelector(`[${name}="${CSS.escape(raw)}"]`);
        } catch (_) {
          continue;
        }
        if (found) return found.closest('.tpp-post') || found;
      }
    }

    // A pin whose id Teams no longer exposes: match it on its own words.
    const record = pinnedSidebarPost(entry.text || '', entry.author || '');
    return record ? record.row : null;
  }

  /**
   * Presses an element the way a pointer does.
   *
   * Teams' controls answer to the pointer events as well as to the click, and a
   * bare `.click()` is ignored by some of them, so the whole sequence is sent in
   * the order a real pointer sends it. Nothing is prevented: Teams gets every
   * event.
   */
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

  /**
   * Takes the user to a pinned post in the channel.
   *
   * A pin is a pointer at a post, not a copy of it: the bar unfolds the post in
   * the channel and lines its top up with the top of the scroll area. Nothing
   * about the post is moved, so its replies, reactions, reply box and menus are
   * Teams' own.
   *
   * Teams only keeps the posts it has rendered, so an old pin may not be in the
   * page at all. Rather than telling the user to scroll and find it, the list is
   * walked back through its history until the post appears (findPinnedPost).
   */
  function jumpToPin(entry, opener) {
    if (!entry) return;

    const row = resolveRow(entry);
    if (row) {
      revealPost(row);
      return;
    }
    // A new bar abandons a search already running.
    if (pinJump) cancelPinSearch();
    findPinnedPost(entry, opener || null);
  }

  /**
   * Walks the message list through its history until the pin's post is loaded,
   * then scrolls to it.
   *
   * Teams fetches older posts when its list is pushed against the top, so the
   * walk goes up a screen at a time and lets Teams render each batch before
   * looking again. Channels can be sorted either way, so it tries downwards as
   * well, and it puts the list back where the user had it if the post is gone.
   */
  /** Resolves once `check` is true, or after `ms` at the latest. */
  function waitFor(check, ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (check() || Date.now() - started >= ms) {
          resolve();
          return;
        }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  /**
   * Walks the message list through the channel until the pin's post is loaded,
   * then scrolls to it.
   *
   * Teams loads older posts when its list is pushed at its edge, so once the
   * walk reaches the top it keeps pushing there to ask for the next batch, and
   * it waits for the list to actually grow instead of for a fixed delay. That
   * is what lets it reach a post dozens of batches back. A few batches in a row
   * that bring nothing new end it, and a button in the corner abandons it.
   */
  async function findPinnedPost(entry, opener) {
    const list = lastList || findMessageList();
    if (!list) {
      toast('Open the pinned post from “In this channel” — Teams is not showing the list.');
      return;
    }

    pinJump = { entry, list, startTop: list.scrollTop, opener };
    showSearchCancel();
    toast('Finding that pinned post…');

    // Up first: channels list the newest post last, so older ones are above.
    if (await walkForPin(entry, list, -1, 20000)) return;
    if (!pinJump) return; // Cancelled.

    // Nothing above, so the channel may be sorted the other way.
    if (await walkForPin(entry, list, 1, 8000)) return;
    if (!pinJump) return; // Cancelled.

    const startTop = pinJump.startTop;
    pinJump = null;
    hideSearchCancel();
    if (list.isConnected) list.scrollTop = startTop;
    toast('Teams is not loading that pinned post — try it again in a moment.');
  }

  /**
   * One direction of the search: true when the post was found and revealed,
   * false when it ran out of history or the user cancelled.
   */
  async function walkForPin(entry, list, direction, budgetMs) {
    const deadline = Date.now() + budgetMs;
    let idle = 0;

    while (pinJump && Date.now() < deadline) {
      const found = resolveRow(entry);
      if (found) {
        pinJump = null;
        hideSearchCancel();
        revealPost(found);
        return true;
      }

      const before = list.scrollHeight;
      const step = Math.round(list.clientHeight * 1.5);
      const atEdge =
        direction < 0
          ? list.scrollTop <= 2
          : list.scrollTop + list.clientHeight >= list.scrollHeight - 2;

      list.scrollTop =
        direction < 0
          ? Math.max(0, list.scrollTop - step)
          : Math.min(list.scrollHeight, list.scrollTop + step);

      // Being at the edge is the request for the next batch, so wait for the
      // list to grow rather than stepping straight past an empty answer.
      await waitFor(
        () => !pinJump || list.scrollHeight > before + 8 || Boolean(resolveRow(entry)),
        atEdge ? 900 : 400
      );
      if (!pinJump) return false;

      if (list.scrollHeight > before + 8) {
        idle = 0;
        continue;
      }
      if (!atEdge) continue;
      // A batch can arrive a couple of beats late; six empty ones mean the
      // channel has no more history to give in this direction.
      idle += 1;
      if (idle >= 6) return false;
    }
    return false;
  }

  /** The button that abandons a pinned-post search, bottom centre. */
  function showSearchCancel() {
    if (searchCancelBtn) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tpp-search-cancel';
    button.dataset.tppUi = 'search-cancel';
    button.textContent = 'Stop searching for this pin';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelPinSearch();
    });
    document.body.append(button);
    searchCancelBtn = button;
  }

  function hideSearchCancel() {
    searchCancelBtn?.remove();
    searchCancelBtn = null;
  }

  /** Stops a running search and puts the channel back where it was. */
  function cancelPinSearch() {
    if (!pinJump) {
      hideSearchCancel();
      return;
    }
    const { list, startTop } = pinJump;
    pinJump = null;
    hideSearchCancel();
    if (list && list.isConnected) list.scrollTop = startTop;
    toast('Search stopped.');
  }

  /**
   * Opens one post: its card unfolds into the whole post, and the list goes
   * straight to it.
   *
   * A bar is a shortcut to a post, so it opens the post rather than pointing at
   * a folded card the user then has to click — and it does so with no flash or
   * highlight, because the post itself is the answer. An archived post is shown
   * first, because the Inbox filter hides it and there is nothing to scroll to
   * while it is hidden.
   */
  function revealPost(row) {
    const id = row.dataset.tppId;
    if (id && isReadPost(id) && view !== VIEW_ARCHIVES) setView(VIEW_ARCHIVES);

    // Unfolded, not toggled: a post that is already open stays open. The row is
    // re-laid out here so the whole post is on screen before the list moves to
    // it, not after — and it takes focus, so the keyboard acts on the post that
    // was just opened.
    if (id && features.compactPosts) {
      const opening = !unfolded.has(id);
      if (opening) {
        unfolded.add(id);
        row.classList.add('tpp-unfold');
        reposition();
      }
      // Opened by the bar, the post is activated as if it had been clicked, so
      // Teams' shortcuts act on it without a second click.
      if (opening) activatePost(row);
      else focusPostMessage(row);
    }

    alignPostTop(row);
  }

  /**
   * Lines one post up with the top of the scroll area, in a single move.
   *
   * A pinned post is read from its first line down, so its top goes to the top of
   * the list: no half screen of the post above the one that was asked for, and
   * nothing left over below.
   */
  function scrollPostToTop(row) {
    const list = lastList || findMessageList();
    if (!list) {
      try {
        row.scrollIntoView({ block: 'start', inline: 'nearest' });
      } catch (_) {
        // Nothing to measure: the browser's own jump is all there is.
      }
      return;
    }

    const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) list.scrollTop += delta;
  }

  /**
   * Keeps a post at the top while Teams finishes moving the list.
   *
   * Pressing Teams' own pinned item also scrolls the list to the post, and Teams
   * chooses where that lands — often the middle. The alignment is repeated over
   * the next half second so Teams' own move is the one that gives way, and a
   * newer jump cancels the older attempts.
   */
  function alignPostTop(row) {
    if (!row) return;
    const token = ++pinAlignToken;
    const step = () => {
      if (token !== pinAlignToken || !row.isConnected) return;
      scrollPostToTop(row);
    };
    step();
    requestAnimationFrame(step);
    window.setTimeout(step, 120);
    window.setTimeout(step, 300);
    window.setTimeout(step, 600);
  }

  /**
   * Teams' own "Post in channel" box, when it is on screen.
   *
   * Teams puts the composer at the top of the posts area, above the list, so
   * that box is where the area begins as far as the eye is concerned. A composer
   * that lives inside the list is skipped: it scrolls with the posts, and room
   * reserved there would scroll away with it.
   */
  function composeBox() {
    for (const selector of S.newPostBox || []) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (_) {
        continue; // A bad selector from a hand edit should not stop the rest.
      }
      if (!found || !found.getClientRects().length) continue;
      if (lastList && lastList.contains(found)) continue;
      return found;
    }
    return null;
  }

  /**
   * Reserves the room the bars take, on the box whose top they cover.
   *
   * With a composer on screen that is the composer's own top padding: the bars
   * sit above "Post in channel" and its content starts below them, so nothing of
   * Teams' is covered. Without one the list keeps the room as its own padding
   * (applyTopInset). Written only when it actually changed.
   */
  function applyPinInset(box, px) {
    if (!box) return;
    if (box.dataset.tppPinApplied !== '1') {
      box.dataset.tppPinInline = box.style.paddingTop || '';
      box.dataset.tppPinBase = getComputedStyle(box).paddingTop;
      box.dataset.tppPinApplied = '1';
    }
    const base = parseFloat(box.dataset.tppPinBase) || 0;
    const value = `${Math.max(base + px, 0)}px`;
    if (box.style.paddingTop !== value) box.style.paddingTop = value;
  }

  /** Gives the room the bars took back to Teams' own box. */
  function clearPinInset() {
    const box = pinHost;
    pinHost = null;
    pinAnchorEl = null;
    pinPlaced = false;
    if (!box || box.dataset.tppPinApplied !== '1') return;
    box.style.paddingTop = box.dataset.tppPinInline || '';
    delete box.dataset.tppPinInline;
    delete box.dataset.tppPinBase;
    delete box.dataset.tppPinApplied;
  }

  /**
   * The posts area: the box that holds Teams' own composer and the list.
   *
   * The bars sit at its top edge — just under the channel's tab strip — and the
   * room they take goes on that box's own padding, so the composer and the posts
   * both start below them. Anchoring to the composer alone was not stable: Teams
   * replaces that box freely, and a bar positioned against one that had gone
   * moved with it.
   *
   * A box much larger than the posts is the app's own layout, not the area, and
   * padding it would push the whole page down; the list is the answer then.
   */
  function pinArea(list, box) {
    if (!list) return null;
    if (!box) return list;

    const listRect = list.getBoundingClientRect();
    for (let node = list.parentElement; node && node !== document.body; node = node.parentElement) {
      if (!node.contains(box)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height > listRect.height + 320 || rect.width > listRect.width + 240) return list;
      return node;
    }
    return list;
  }

  /**
   * The width a bar takes: one post's, not the whole pane's.
   *
   * Teams' message list can be far wider than the posts drawn in it, so a bar
   * sized to the list ran on past the post it belonged to. The first post with a
   * box of its own is the measure; the list is only the fallback for a view with
   * nothing on show.
   */
  function barBox(list) {
    const listRect = list.getBoundingClientRect();
    for (const row of list.querySelectorAll('.tpp-post')) {
      if (!row.getClientRects().length) continue;
      const rect = row.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 0) return rect;
    }
    return { left: listRect.left + 12, width: Math.max(listRect.width - 24, 200) };
  }

  /**
   * The bars float over the top of the posts area, above Teams' own composer.
   *
   * They are anchored to the window, never inserted into the list: that is
   * Teams' scroll box, so a bar put inside it belongs to the content and scrolls
   * away. They are as wide as a post, and the room they need is added to the
   * area's padding so nothing of Teams' is covered.
   *
   * Returns the padding the list still owes the bars: their height when the list
   * is the area itself (scan folds that into applyTopInset with the tabs), and
   * nothing when the area has already taken it.
   */
  function placePinStack(stack, list) {
    if (!stack || !list) return null;

    if (stack.parentElement !== document.body) document.body.append(stack);
    stack.style.display = '';

    const listRectNow = list.getBoundingClientRect();
    // The list has not been laid out yet. A bar that is already placed is left
    // exactly where it is: hiding it for one pass and putting it back is the
    // blink, and a list is briefly unmeasurable every time Teams swaps a batch
    // of posts in.
    if (listRectNow.width < 120) {
      if (!pinPlaced) stack.style.display = 'none';
      return null;
    }

    const post = barBox(list);
    const height = Math.ceil(stack.getBoundingClientRect().height || stack.scrollHeight || 0) || 30;

    // The box the bars are anchored to is decided once and kept: choosing again
    // on every scan let a composer that Teams mounts and unmounts move the bars
    // between two positions, which is the blink itself. It is forgotten when it
    // leaves the page (see clearPinInset).
    let area = null;
    if (pinAnchorEl && pinAnchorEl.isConnected && pinAnchorEl.contains(list)) {
      area = pinAnchorEl;
    } else {
      area = pinArea(list, composeBox()) || list;
      pinAnchorEl = area;
    }
    const areaRect = area.getBoundingClientRect();

    if (area !== list) {
      if (pinHost && pinHost !== area) clearPinInset();
      pinHost = area;
      applyPinInset(area, height + 10);
    } else if (pinHost) {
      clearPinInset();
    }
    // Kept for the next scan even when cleaning restored a previous box: the
    // choice is what has to be stable, not the padding bookkeeping.
    pinAnchorEl = area;
    pinPlaced = true;

    stack.style.position = 'fixed';
    stack.style.top = `${Math.max(areaRect.top + 4, 0)}px`;
    stack.style.bottom = 'auto';
    stack.style.left = `${Math.max(post.left, areaRect.left + 4)}px`;
    stack.style.width = `${Math.min(post.width, areaRect.width)}px`;
    stack.style.right = 'auto';

    return area === list ? height + 10 : 0;
  }

  /**
   * Draws the bars now, without waiting for a scan.
   *
   * A pin is a direct answer to a click, and a scan stands down while a draft is
   * open or while Teams shows one of its own post panes — which is when the bar
   * would otherwise not appear at all. This reconciles the same stack renderPins
   * builds, so the cost is one pass over the pins.
   */
  function refreshPins() {
    // A draft is open: nothing of ours touches the page until it is gone (see
    // composerOpen). The next scan draws the bar as soon as it is sent.
    if (composerOpen()) return null;
    const list = lastList || findMessageList();
    if (!list) return null;
    try {
      return renderPins(list);
    } catch (_) {
      return null; // A bar never takes the click that asked for it down with it.
    }
  }

  function renderPins(list) {
    const existing = document.getElementById(STACK_ID);
    // Pinning is an Inbox feature: the bars belong to the Inbox, and the Archive
    // is where filed posts are looked through. Drawing them over the Archive put
    // a pinned post's bar above a list it is not part of.
    const allow = features.pinnedMessages && view !== VIEW_ARCHIVES;
    const entries = allow ? buildPinEntries() : [];

    if (!list || entries.length === 0) {
      // A bar is not taken down the instant its entry is missing: Teams drops and
      // re-renders rows as batches load, and a bar that goes and comes back with
      // each one is the blink. The stack is removed only once the emptiness has
      // lasted — at once when the feature itself was switched off.
      if (existing && list && allow && !explicitPinChange) {
        const now = Date.now();
        if (!emptyPinsAt) emptyPinsAt = now;
        if (now - emptyPinsAt < 800) return null;
      }
      explicitPinChange = false;
      emptyPinsAt = 0;
      if (existing) {
        console.info('[Teams++] pin bars cleared', {
          build: BUILD,
          hasPins: hasPinRecords(),
          featureOff: !features.pinnedMessages,
          view,
          channel: pinChannel
        });
      }
      existing?.remove();
      // The room reserved for the bars goes back to Teams' composer.
      clearPinInset();
      return null;
    }
    emptyPinsAt = 0;

    let stack = existing;
    if (!stack) {
      stack = document.createElement('div');
      stack.id = STACK_ID;
      stack.className = 'tpp-pin-stack';
      stack.dataset.tppUi = 'pin-stack';
      stack.setAttribute('role', 'list');
      stack.setAttribute('aria-label', 'Pinned posts');
      document.body.append(stack);
    }

    // Reconcile bar by bar. Rebuilding the stack replaces the item a post was
    // opened into, so any Teams re-render closed it again; keeping the items
    // means an opened post survives every scan untouched.
    const existingItems = new Map();
    for (const item of Array.from(stack.children)) {
      if (item.classList && item.classList.contains('tpp-pin-item')) {
        existingItems.set(item.dataset.tppKey, item);
      }
    }

    const keep = [];
    const wanted = new Set();
    const leftovers = [...existingItems.values()];

    for (const entry of entries) {
      const key = pinKey(entry);
      if (wanted.has(key)) continue; // One bar per post, always.
      wanted.add(key);

      let item = existingItems.get(key);
      if (item) {
        updatePinItem(item, entry);
        keep.push(item);
        continue;
      }

      // An entry can change its own key — a moderator's pin gains its post id once
      // the post is rendered, and a bar's wording can change — and dropping the
      // old bar for it made one bar blink out while the others stayed. An unwanted
      // bar of the same kind is reused for the entry that replaced it instead, so
      // the element on screen never goes away and comes back.
      const reuse = leftovers.find(
        (left) =>
          !keep.includes(left) &&
          !wanted.has(left.dataset.tppKey || '') &&
          (left.dataset.tppKey || '').startsWith(`${entry.kind}:`)
      );
      if (reuse) {
        for (const [oldKey, held] of existingItems) {
          if (held === reuse) existingItems.delete(oldKey);
        }
        reuse.dataset.tppKey = key;
        existingItems.set(key, reuse);
        updatePinItem(reuse, entry);
        keep.push(reuse);
        continue;
      }

      const fresh = pinBar(entry);
      stack.append(fresh);
      keep.push(fresh);
    }

    for (const item of leftovers) {
      if (keep.includes(item)) continue;
      console.info('[Teams++] pin bar removed', {
        build: BUILD,
        key: item.dataset.tppKey || ''
      });
      item.remove();
    }

    keep.forEach((item, index) => {
      if (stack.children[index] !== item) stack.insertBefore(item, stack.children[index] || null);
    });

    return placePinStack(stack, list);
  }

  /**
   * The tabs and pinned bars float over the top of the list. A matching
   * padding-top keeps the first post readable, without changing Teams' own
   * padding permanently.
   */
  function applyTopInset(list, px) {
    if (!list) return;
    if (list.dataset.tppPadApplied !== '1') {
      list.dataset.tppPadInline = list.style.paddingTop || '';
      list.dataset.tppPadBase = getComputedStyle(list).paddingTop;
      list.dataset.tppPadApplied = '1';
    }
    const base = parseFloat(list.dataset.tppPadBase) || 0;
    const value = `${Math.max(base + px, 0)}px`;
    if (list.style.paddingTop !== value) list.style.paddingTop = value;
  }

  /**
   * Gives the post buttons a margin to float in without moving a single post.
   *
   * The list gains padding on the left and takes the same amount back off its
   * own left margin, so its content stays exactly where Teams put it while the
   * gutter appears in the margin beside it. Padding alone would push every post
   * right, which is what this replaces.
   */
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


  function unpinNative(id) {
    const row = findRow(id);
    if (!row) {
      toast('Open the post in the channel to unpin it.');
      return;
    }

    // The bar goes as soon as the request is made: keeping the entry would put
    // it back on the next scan, and Teams' own marker — still on the row and
    // still in its sidebar list — would be read back as a fresh pin.
    forgetNativePin(id);
    holdUnpinned(id);
    explicitPinChange = true;

    const where = anchorFor(id);
    const control = unpinAffordance(row);
    if (control) {
      control.click();
      repaintPinned(id);
      refreshPins();
      toast('Asked Teams to unpin this post.', where);
      return;
    }

    repaintPinned(id);
    refreshPins();
    toast('This post is pinned in Teams. Use the post’s ⋯ menu to unpin it.', where);
  }

  // ------------------------------------------------------------------- jump

  function findRow(id) {
    if (!id) return null;
    // Only posts: a pinned bar carries the same id so it can find its post, and
    // must never be mistaken for the post itself.
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

    // The pair answers the click at once, but the posts below it are Teams' to
    // re-render, and that is the gap that used to look like an empty page. The
    // bar goes in before the work so the click is answered even when Teams has
    // not drawn anything yet.
    if (changing) startProgress();
    showPostsPanel();

    if (changing) {
      view = next;
      writeSync({ [VIEW_KEY]: view });
    }

    // A frame between the bar and the scan: that scan can take a moment, and a
    // bar that only appears after it has run is no feedback at all.
    window.requestAnimationFrame(() => apply());
  }

  /**
   * Feedback for a view that is still arriving.
   *
   * Switching between the Inbox and the Archive is a filter, but the posts under
   * it are Teams' to re-render: coming back from another tab can leave the list
   * empty for a second or two, which reads as a broken page rather than as a
   * load. A thin bar across the top of the list says the click landed, and it is
   * gone again the moment that view is drawn.
   */
  function progressEl() {
    const existing = document.getElementById(PROGRESS_ID);
    if (existing) return existing;

    const el = document.createElement('div');
    el.id = PROGRESS_ID;
    el.className = 'tpp-progress';
    el.dataset.tppUi = 'progress';
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-label', 'Loading posts');
    document.body.append(el);
    return el;
  }

  /**
   * Puts the bar across the top of the posts, or under the tab strip while the
   * panel itself is still loading and there are no posts to measure yet.
   */
  function placeProgress(el) {
    if (!el) return;

    const list = lastList && lastList.isConnected ? lastList : findMessageList();
    const listRect = list ? list.getBoundingClientRect() : null;
    if (listRect && listRect.width > 120) {
      el.style.marginLeft = '0';
      el.style.left = `${Math.round(listRect.left + 12)}px`;
      el.style.width = `${Math.round(Math.max(listRect.width - 24, 200))}px`;
      el.style.top = `${Math.round(Math.max(listRect.top, 0))}px`;
      return;
    }

    const strip = nativeTabStrip();
    const stripRect = strip ? strip.getBoundingClientRect() : null;
    if (stripRect && stripRect.width > 120) {
      el.style.marginLeft = '0';
      el.style.left = `${Math.round(stripRect.left + 12)}px`;
      el.style.width = `${Math.round(Math.max(stripRect.width - 24, 200))}px`;
      el.style.top = `${Math.round(Math.max(stripRect.bottom, 0))}px`;
      return;
    }

    el.style.marginLeft = '-130px';
    el.style.left = '50%';
    el.style.width = '260px';
    el.style.top = '14px';
  }

  function startProgress() {
    clearTimeout(progressHideTimer);
    clearTimeout(progressLimitTimer);
    progressHideTimer = 0;
    progressLimitTimer = 0;
    progressOn = true;
    progressShownAt = Date.now();

    placeProgress(progressEl());

    // A panel that never comes back must not leave the bar running for ever.
    progressLimitTimer = setTimeout(() => stopProgress(true), 4500);
  }

  /** Takes the bar down, but never so fast that it could not be seen. */
  function stopProgress(atOnce) {
    if (!progressOn) return;
    progressOn = false;
    clearTimeout(progressLimitTimer);
    progressLimitTimer = 0;

    const wait = atOnce ? 0 : Math.max(0, 500 - (Date.now() - progressShownAt));
    const remove = () => {
      progressHideTimer = 0;
      document.getElementById(PROGRESS_ID)?.remove();
    };
    if (wait) progressHideTimer = setTimeout(remove, wait);
    else remove();
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

    for (const button of wrap.querySelectorAll('.tpp-tab')) {
      const active = view === button.dataset.mode;
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
      selected: findIn(strip, true) || findIn(document, true) || posts || null,
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
      // A calm card rather than a celebration: with read state as the model, an
      // empty Inbox is the everyday case, not an achievement to fire confetti
      // over every time a channel is opened.
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

  function renderEmpty(list) {
    const existing = document.getElementById(EMPTY_ID);

    if (!features.inboxZero || !list) {
      existing?.remove();
      return;
    }

    const records = Array.from(rowsById.values());
    const read = records.filter((record) => record.read).length;

    let kind = null;
    if (view === VIEW_ARCHIVES) {
      kind = records.length > 0 && read === 0 ? 'no-archives' : null;
    } else if (records.length > 0 && read === records.length) {
      kind = 'zero';
    }

    if (!kind) {
      existing?.remove();
      return;
    }

    let empty = existing;
    if (!empty || empty.dataset.tppKind !== kind) {
      empty?.remove();
      empty = buildEmptyState(kind);
      document.body.append(empty);
    }

    anchor(empty, list, { top: 18, full: true, matchHeight: true });
  }

  // ------------------------------------------------------- hover between posts

  // -------------------------------------------------------------- overlays  // -------------------------------------------------------------- overlays

  /**
   * Keep a fixed-position overlay glued to the message list. `full` stretches
   * it to the list's width; otherwise it is anchored to the right edge.
   */
  function anchor(el, list, options) {
    const rect = list.getBoundingClientRect();
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
   * A status message: a larger, translucent card dead centre on the page.
   *
   * It is a status of the page, not of a row, so it does not move with the list
   * and does not appear somewhere different for the same action depending on
   * what happens to be on screen. `anchor` is still accepted by callers but no
   * longer moves the message; see placeToast.
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
    placeToast(el);

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
   * Puts the status message in the middle of the posts, and the middle of the
   * page.
   *
   * Horizontally it belongs over the post column, not over the window: Teams
   * keeps its channel list on the left, so the centre of the screen sits to the
   * left of the posts and a card there reads as belonging to the sidebar. A post
   * row is the line asked for, and its rect already carries the gutter inset, so
   * the list is only a fallback for a channel with nothing rendered in it.
   *
   * Vertically it is the middle of the page, and the card is fixed, so a scroll
   * under it moves nothing.
   */
  function placeToast(el) {
    let box = null;

    if (lastList && lastList.isConnected) {
      const row = lastList.querySelector('.tpp-post');
      const rect = row ? row.getBoundingClientRect() : null;
      if (rect && rect.width > 40) box = rect;
    }

    if (!box) {
      const list = lastList && lastList.isConnected ? lastList : findMessageList();
      const rect = list ? list.getBoundingClientRect() : null;
      if (rect && rect.width > 40) box = rect;
    }

    el.style.left = box ? `${Math.round(box.left + box.width / 2)}px` : '50%';
    el.style.top = '50%';
  }

  function reposition() {
    // A composer is open: the page is the user's, and every measurement and
    // scroll nudge waits until it is gone (see composerOpen).
    if (!ready || !channelMode || frame || composerOpen()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const list = findMessageList();
      if (!list) return;

      listRect = list.getBoundingClientRect();

      const stack = document.getElementById(STACK_ID);
      if (stack) placePinStack(stack, list);

      const progress = document.getElementById(PROGRESS_ID);
      if (progress) placeProgress(progress);

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
   * The channel a pin belongs to.
   *
   * Teams names the channel in its route — /l/channel/<id>/<name> — but the
   * newest Teams keeps that route in the hash, so the pathname alone is the
   * same string in every channel. A key built from it is therefore one bucket
   * shared by all of them, which is how a pin made in one channel showed up in
   * the next. The whole URL is asked for the channel instead, and the id it
   * names is the key.
   */
  function channelKey() {
    const href = String(location.href || '');
    const route = href.match(/\/channel\/([^/?#]+)/i);
    if (route) {
      pinnedChannelKey = CHANNEL_PREFIX + channelIdOf(route[1]);
      return pinnedChannelKey;
    }

    // Teams rewrites the route while it settles a channel, and for a moment the
    // URL names no channel at all. Falling through to a key built from that
    // half-written URL gave the same channel a second, empty bucket — the pins
    // were read from an empty map until the URL came back, which is a bar that
    // goes and returns. The last id we read is the channel the user is in.
    if (pinnedChannelKey && channelMode !== false) return pinnedChannelKey;

    // A build whose route does not name the channel: the rest of the route is
    // still the best identity there is, so two channels only share a bucket
    // when their routes are the same.
    const rest = `${location.pathname || ''}${location.hash || ''}`
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
    return rest ? `route:${rest.slice(0, 200)}` : 'route:teams';
  }

  /** A channel id as Teams writes it, decoded and lower-cased to stay stable. */
  function channelIdOf(segment) {
    let id = String(segment || '');
    try {
      id = decodeURIComponent(id);
    } catch (_) {
      // A percent-mangled id: the raw segment is still a fine key.
    }
    return id.toLowerCase().slice(0, 200);
  }

  /**
   * Moves the bars to whichever channel is on screen. Teams changes channels
   * without a page load, so this is checked on every scan.
   */
  function syncPinChannel(force) {
    const channel = channelKey();
    if (channel === pinChannel) {
      pinChannelNext = '';
      return false;
    }

    // Teams rewrites the route while it settles a channel, and a key that flips
    // for a scan or two used to drop the bars of the channel being opened. A scan
    // waits until the new key has been read twice; a click (`force`) switches at
    // once, because that is a certain move.
    if (!force) {
      if (channel !== pinChannelNext) {
        pinChannelNext = channel;
        return false;
      }
    }
    pinChannelNext = '';

    // Teams' pins belong to the channel they were read in.
    nativePins.clear();

    pinChannel = channel;
    return true;
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
        '[data-tid*="skeleton" i], [data-tid*="loading" i], [class*="skeleton" i], [class*="Spinner__spinner"]'
      );
    } catch (_) {
      return;
    }

    for (const el of list.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }
    if (!any) return;

    for (const el of list.querySelectorAll(selectors.join(','))) {
      // A skeleton inside a real post (a link card still loading) is that
      // post's own business, not a stand-in row.
      if (el.closest('.tpp-post')) continue;

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
   * A post Teams has drawn attention to: the one a channel search found, or the
   * one holding the keyboard.
   *
   * Teams' own Find in channel jumps the list to a post and marks it; if that post
   * happened to be read, the Inbox filter closed it up and the search looked
   * broken — the result was there, three pixels tall and invisible. A post that is
   * spotlighted is therefore never filtered out, whichever tab is open. Nothing
   * else about the tabs changes: only the post the user is being shown.
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
  function clampScroll(list) {
    if (!ready || !features || !features.inboxZero || pinJump || !list) return;
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
      if (filtered && box.scrollTop > 1) box.scrollTop = 0;
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

  function scan() {
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

    // Teams swaps channels in place, and a pin belongs to its channel: the
    // bars have to move to the new channel's pins before anything is drawn.
    syncPinChannel();

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
        // Twenty seconds, not one: the bars are fixed to the window and do not
        // need the list to stay where they are, so a swap can last as long as it
        // likes without touching them. Only a pane that really stays away — the
        // Files tab left open — is worth taking them down for, and leaving the
        // channel goes through teardownChannelUi at once anyway.
        if (now - listMissingAt < 20000) return;

        for (const id of [STACK_ID, EMPTY_ID]) document.getElementById(id)?.remove();
        // The panel is gone: so is any switch that was waiting on it.
        stopProgress(true);
        // The tabs live in the channel's own tab strip, so they survive a scan
        // that finds no list; renderTabs drops them once that strip is gone.
        renderTabs();
        document.documentElement.removeAttribute(HAS_ARCHIVES_ATTR);
        clearTopInset();
        clearLeftInset();
        clearPinInset();
        return;
      }
      listMissingAt = 0;

      lastList = list;
      listRect = list.getBoundingClientRect();

      // The stylesheet needs to know which element is the message list to keep
      // it in place in an empty Archives (see publishArchivePresence).
      list.classList.toggle('tpp-list', Boolean(features.inboxZero));

      lastScrollBox = scrollBoxFor(list);
      rebuildRows(list);
      markLoadingRows(list);
      const pinRoom = renderPins(list);
      renderEmpty(list);
      uiDrawn = true;

      // The view this bar was raised for is drawn: posts on screen, or the card
      // that says there are none. Either is an answer.
      if (progressOn && (rowsById.size > 0 || document.getElementById(EMPTY_ID))) {
        stopProgress(false);
      }

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

      // Keep the first post clear of the pinned bars. They usually hold their own
      // room above Teams' composer (placePinStack); this is the case where the
      // list itself is the top of the area.
      if (pinRoom > 0) applyTopInset(list, pinRoom);
      else clearTopInset(list);

      if (features.inboxZero || features.pinnedMessages) applyLeftInset(list);
      else clearLeftInset(list);

      // The posts have just been re-measured: the Inbox may now end higher up.
      clampScroll(list);

      // The seams have just moved or gone: re-check where the pointer is, so the
      // control cannot outlive the gap it was describing.
    } finally {
      // Written last, so it describes the state this scan actually left behind.
      publishPinDebug();
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
      if (node.closest('[data-tpp-ui], .tpp-pin-stack, .tpp-tabs, .tpp-empty-state')) continue;

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
    slowTimer = setTimeout(() => {
      slowTimer = 0;
      scan();
    }, 1500);
  }

  /**
   * Can this subtree bring the posts, the list or the channel furniture with it?
   * Asked only about nodes inserted outside the list, which is where a channel
   * switch and the Posts tab coming back arrive.
   */
  const CHANNEL_FURNITURE = [
    '[data-tid="post-message-subheader"]',
    '[data-tid="message-pane-list-runway"]',
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="channel-pane-message-list"]',
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

    syncFeatureFlags();

    // Each switch owns its own marks and nothing else: turning one feature off
    // takes down that feature's work and leaves the other two exactly as they
    // were. Everything is re-derived by the scan below.
    if (!features.inboxZero) {
      html.removeAttribute(HAS_ARCHIVES_ATTR);
      html.removeAttribute(EMPTY_VIEW_ATTR);
      for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
      // The filter is off: no post is tucked, tagged or filed any more.
      for (const el of document.querySelectorAll('.tpp-post')) {
        untuck(el);
        if (el.dataset.tppTag !== undefined) delete el.dataset.tppTag;
        delete el.dataset.tppPainted;
      }
    }

    if (!features.pinnedMessages) {
      document.getElementById(STACK_ID)?.remove();
      clearPinInset();
      // The rail loses its pin button: repaint it without one.
      for (const el of document.querySelectorAll('.tpp-post')) delete el.dataset.tppPainted;
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

    if (!features.inboxZero && !features.pinnedMessages) clearLeftInset();

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
    settleTries = 0;
    lastScrollBox = null;
    // Out of the Posts area: the next channel names its own id.
    pinnedChannelKey = '';
    for (const id of [TABS_ID, STACK_ID, EMPTY_ID, TOAST_ID, PROGRESS_ID]) {
      document.getElementById(id)?.remove();
    }
    progressOn = false;
    clearTimeout(progressHideTimer);
    clearTimeout(progressLimitTimer);
    progressHideTimer = 0;
    progressLimitTimer = 0;
    hideSearchCancel();

    lastList = null;
    listRect = null;

    releaseNativeTab();
    clearTopInset();
    clearLeftInset();
    clearPinInset();

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

    // Entries the old build inferred from Teams' "New" badge and "Last read"
    // line are r: 0 with no `c`; they are the sweep, not the user's own marks.
    let dropped = false;
    for (const [id, entry] of Object.entries(readState)) {
      if (entry.r === 0 && entry.c !== 1) {
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

    // Pins used to be kept here: the user's own, each with a copy of the post's
    // words. Pinning is Teams' own now, so the map is dropped and its share of
    // the sync quota goes with it.
    pinChannel = channelKey();
    if (items[LEGACY_PINS_KEY]) {
      chrome.storage.sync.remove(LEGACY_PINS_KEY, () => void chrome.runtime.lastError);
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
        let full = false;
        for (const record of records) {
          const target = record.target;
          if (lastList && target && (target === lastList || lastList.contains(target))) {
            relevant = true;
          }
          // The list itself going away is the biggest change there is.
          for (const node of record.removedNodes) {
            if (node.nodeType === 1 && lastList && node.contains(lastList)) relevant = true;
          }
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
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
        // Any count of rows inside the list: the tuck has to land before the
        // browser paints, or the post shows for a moment and then disappears.
        if (inList.length) absorbNodes(inList);
        // A pane is not a batch: only a handful of nodes is worth walking
        // before paint, and a switch is left to the scan it schedules.
        if (mounted.length && mounted.length <= 6) absorbNodes(mounted);
        if (relevant) scheduleScan(true);
        else scheduleSlowScan();
      } else {
        scheduleScan();
      }
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

  /**
   * The pin model, written onto <html> so DevTools can read it.
   *
   * A content script runs in an isolated world: `globalThis` here is not the
   * page's `window`, so nothing of ours can be called from the Teams console. An
   * attribute is shared, and this is the state that answers whether a bar was
   * removed, hidden or moved — and what the pin maps held at the time. Read it
   * with `document.documentElement.getAttribute('data-tpp-pin-debug')`.
   */
  function publishPinDebug() {
    const html = document.documentElement;
    if (!html) return;
    // A readout, not a feature: several scans a second each stringifying both
    // pin maps is cost nobody can observe. Once a second is plenty to look at.
    const now = Date.now();
    if (now - pinDebugAt < 1000) return;
    pinDebugAt = now;
    const stack = document.getElementById(STACK_ID);
    const state = JSON.stringify({
      build: BUILD,
      channel: pinChannel,
      key: pinnedChannelKey,
      native: nativePins.size,
      list: Boolean(lastList && lastList.isConnected),
      stack: Boolean(stack),
      display: stack ? stack.style.display : '',
      top: stack ? stack.style.top : '',
      width: stack ? stack.style.width : ''
    });
    if (html.getAttribute(PIN_DEBUG_ATTR) !== state) html.setAttribute(PIN_DEBUG_ATTR, state);
  }

  // Keep an open tab in sync when settings, archives or pins change elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !ready) return;
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
