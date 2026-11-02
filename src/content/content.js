/**
 * Teams++ content script.
 *
 * Two features live here:
 *
 *   Inbox Zero      Every post gets Archive / Pin buttons in its left margin;
 *                   comments and replies never get them. A post carries no tag
 *                   until it is archived: archiving tags it "archive" and
 *                   unarchiving removes the tag again, so an untagged post is
 *                   an Inbox post. The Inbox and Archive tabs sit in the
 *                   channel tab bar in the Posts tab's place and filter on that
 *                   tag. Hovering the space between two posts offers
 *                   "Archive all older posts".
 *
 *   Pinned posts    Pinned posts sit in purple bars directly under the channel
 *                   menu bar, above the "Post in channel" box. A bar jumps to the
 *                   post where it sits in the stream, and a pinned post is never
 *                   archived until it is unpinned.
 *                   Posts pinned by a channel moderator sit first in Teams
 *                   purple; posts you pin yourself sit below in a lighter violet.
 *
 * Everything the user changes is written to chrome.storage.sync, so the same
 * archive, pins and view follow them to every Chrome profile.
 *
 * Teams re-renders its message list constantly and hashes its class names, so
 * rows are recognised by data-tid/role anchors (see selectors.js) and one
 * debounced scan repairs the UI after every render.
 */
(function () {
  'use strict';

  const {
    STORAGE_KEY,
    ARCHIVE_KEY,
    PINS_KEY,
    VIEW_KEY,
    FEATURES,
    normalize,
    normalizeMap,
    normalizePins,
    isLegacyPins,
    normalizeView,
    readSync,
    writeSync
  } = globalThis.TeamsPlusPlus;
  const S = globalThis.TeamsPlusPlusSelectors;

  const ARCHIVE_LIMIT = 150;
  /** Pins kept in one channel, and channels whose pins are kept at all. */
  const PIN_LIMIT = 40;
  const PIN_CHANNEL_LIMIT = 40;

  const VIEW_INBOX = 'inbox';
  const VIEW_ARCHIVES = 'archives';

  const TABS_ID = 'tpp-tabs';
  const STACK_ID = 'tpp-pin-stack';
  const EMPTY_ID = 'tpp-empty-state';
  const PIN_COPY_ID = 'tpp-pin-copy';
  const GAP_ID = 'tpp-gap';
  const TOAST_ID = 'tpp-toast';
  /** How long a post takes to slide out of the Inbox when it is archived. */
  const ARCHIVE_ANIM_MS = 300;
  const HAS_ARCHIVES_ATTR = 'data-tpp-has-archives';
  /** The build on disk; also left on <html> so the running script can be checked. */
  const BUILD = '2026-11-01.30';
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
  const GAP_TOLERANCE = 14;

  /** Width of the left margin the post buttons float in, in px. */
  const RAIL_GUTTER = 32;

  const PIN_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6z"/><path d="M12 15v6"/></svg>';
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
  const CONFETTI_COLORS = [
    '#6264a7',
    '#8b5cf6',
    '#c4b5fd',
    '#f472b6',
    '#fbbf24',
    '#34d399',
    '#60a5fa'
  ];

  let ready = false;
  let features = null;
  let archive = {};
  /**
   * Every channel's pins, keyed by channel path, and `pins` as the bucket of
   * the channel on screen. A pin belongs to the channel it was made in, so the
   * bars only ever show the pins of this channel.
   */
  let pinsAll = {};
  let pins = {};
  let pinChannel = '';
  let view = VIEW_INBOX;
  /**
   * Whether the page on screen is a channel's Posts area. Teams++ is for
   * channels only: a chat has its own message list and gets none of it, which
   * is enforced by writing the feature flags (what teams.css hangs every style
   * off) only while this is true.
   */
  let channelMode = null;

  /** id -> { row, text, author, replies, archived } for the latest scan. */
  let rowsById = new Map();
  /** id -> { id, text, author } for posts Teams itself has pinned. */
  let nativePins = new Map();

  /** Seams between two visible posts, in viewport coordinates, top to bottom. */
  let gapZones = [];
  /** The drawn gap control's box is reused; only its position changes. */
  let gapZone = null;

  let observer = null;
  let lastList = null;
  let listRect = null;
  let tabsPx = 0;
  /** The channel's own "Posts" tab while our tabs stand in for it. */
  let hiddenNativeTab = null;
  /** The last post on show, which carries the filler that keeps the list deep. */
  let depthTail = null;
  /** The walk through the channel that is looking for a pinned post. */
  let pinJump = null;
  let flashTimer = 0;
  /** The button that abandons that walk. */
  let searchCancelBtn = null;
  /** Posts the user has unfolded in the compact view, by id. */
  const unfolded = new Set();
  let rescanTimer = 0;
  let archiveSaveTimer = 0;
  let pinsSaveTimer = 0;
  let frame = 0;
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
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (target.closest('button, a, input, textarea, select, [contenteditable="true"], .tpp-post-actions')) {
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
    if (unfolded.has(id)) unfolded.delete(id);
    else unfolded.add(id);
    row.classList.toggle('tpp-unfold', unfolded.has(id));
    // Opening a post can put Teams' own divider back on screen, so which line is
    // shown is decided again at once — otherwise the copy stays beside it and the
    // post shows two. The row also changed height, so the line is re-measured.
    refreshLastRead();
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

    const author = authorOf(row);
    const headline = headlineOf(row);
    const snippet = snippetFor(row, headline);
    const picture = avatarOf(row);
    const timeEl = first(S.messageTime, row);
    const time = timeEl ? collapse(timeEl.textContent || '') : '';
    // Unread and "last read" are Teams' own markers, and both live in the part
    // of the row the card hides: they are read here and the card carries them.
    const unread = isUnreadPost(row);
    const lastRead = endsLastRead(row);
    const signature = [
      author,
      time,
      headline,
      snippet,
      picture,
      unread ? 'new' : '',
      lastRead ? 'seam' : ''
    ].join('|');

    let card = row.querySelector(':scope > [data-tpp-ui="preview"]');
    if (card && card.dataset.tppSig === signature) {
      if (!row.classList.contains('tpp-previewed')) row.classList.add('tpp-previewed');
      return;
    }

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
        '<span class="tpp-preview-new" hidden>New</span>' +
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
        if (live) toggleUnfold(live);
      });
      row.append(card);
    }

    card.dataset.tppSig = signature;
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
    card.querySelector('.tpp-preview-new').hidden = !unread;
    paintLastRead(row, lastRead);
    row.classList.add('tpp-previewed');
  }

  /** Teams' own unread badge on a post, when it renders one. */
  const NEW_BADGE_SELECTOR =
    '[data-tid="new-message-badge"], [data-tid*="new-message-status" i]';
  /** Teams' own "Last read" divider: inside a post, or between two of them. */
  const LAST_READ_SELECTOR = '[data-tid="last-read-line"], [data-tid*="last-read" i]';

  /** Whether Teams marks this post as unread. */
  function isUnreadPost(row) {
    try {
      return Boolean(row.querySelector(NEW_BADGE_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether Teams' "Last read" divider closes this post — that is, whether this
   * is the last post that has been read. Teams ends the divider where the read
   * section ends, and where that element is rendered varies by build: inside the
   * last-read post, as its own element between two posts, or at the top of the
   * first unread one. All three mean the same boundary, and all three put the
   * line under the post above it — which is what this answers.
   */
  function endsLastRead(row) {
    try {
      const inside = row.querySelector(LAST_READ_SELECTOR);
      if (inside) {
        const head = row.querySelector('.tpp-head');
        // Below the post's header it is this post's own footer. Above it, it is
        // the line between the two posts, so it belongs to the one before.
        if (!head) return true;
        const aboveHead = Boolean(
          inside.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING
        );
        if (!aboveHead) return true;
      }

      // The next post, and any divider rendered between the two of them.
      let next = row.nextElementSibling;
      while (next) {
        if (next.matches(LAST_READ_SELECTOR) || next.querySelector(LAST_READ_SELECTOR)) {
          return true;
        }
        const post = next.classList.contains('tpp-post')
          ? next
          : next.querySelector('.tpp-post');
        if (post) {
          const inPost = post.querySelector(LAST_READ_SELECTOR);
          const postHead = post.querySelector('.tpp-head');
          return Boolean(
            inPost &&
              postHead &&
              inPost.compareDocumentPosition(postHead) & Node.DOCUMENT_POSITION_FOLLOWING
          );
        }
        next = next.nextElementSibling;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /** Teams' own "Last read" divider for this post, wherever the build puts it. */
  function nativeLastRead(row) {
    const inside = row.querySelector(LAST_READ_SELECTOR);
    if (inside) return inside;

    let next = row.nextElementSibling;
    while (next) {
      if (next.matches(LAST_READ_SELECTOR)) return next;
      const found = next.querySelector(LAST_READ_SELECTOR);
      if (found) return found;
      if (next.classList.contains('tpp-post') || next.querySelector('.tpp-post')) return null;
      next = next.nextElementSibling;
    }
    return null;
  }

  /**
   * Re-decides the "Last read" line on every post: Teams' own line may have just
   * appeared (or vanished) with a post being opened, and the copy follows it.
   */
  function refreshLastRead() {
    for (const row of document.querySelectorAll('.tpp-post')) {
      paintLastRead(row, endsLastRead(row));
    }
    syncLastReadBands();
  }

  /**
   * Takes the band off any row that no longer carries the line. A stale band is
   * 26px of empty space of its own, which is how opening and closing a post could
   * leave the gap above it wider than it was.
   */
  function syncLastReadBands() {
    for (const row of document.querySelectorAll('.tpp-last-read-row')) {
      if (!row.querySelector(':scope > [data-tpp-ui="last-read"]')) {
        row.classList.remove('tpp-last-read-row');
      }
    }
  }

  /** Whether an element is actually painted: a hidden one has no boxes. */
  function hasBox(el) {
    try {
      return el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * Puts the "Last read" line in the middle of the gap under the post it closes,
   * measuring from the visible edges of the two posts rather than from the boxes
   * around them, whose padding would pull the line off centre.
   */
  function placeLastRead() {
    for (const seam of document.querySelectorAll('.tpp-last-read')) {
      const row = seam.closest('.tpp-post');
      if (!row) continue;

      // The box the user sees: the card while the post is folded, the post itself
      // once it is open.
      const card = row.querySelector(':scope > [data-tpp-ui="preview"]');
      const open = row.classList.contains('tpp-unfold');
      const shown = card && !open ? card : row;
      const rowRect = row.getBoundingClientRect();
      const box = shown.getBoundingClientRect();
      if (!box.height) continue;

      // The band under the post belongs to the line, not to the post: measuring
      // an open row to its padded bottom would put the gap above the line and
      // drop the line onto the post below.
      const banded = row.classList.contains('tpp-last-read-row');
      const band = open && banded ? parseFloat(getComputedStyle(row).paddingBottom) || 0 : 0;
      const bottom = box.bottom - band;

      let next = row.nextElementSibling;
      let nextBox = null;
      while (next) {
        const post = next.classList.contains('tpp-post')
          ? next
          : next.querySelector('.tpp-post');
        if (post) {
          // The same box the user sees: a folded post is its card. Its row keeps
          // padding above the card, and measuring that would pull the line up.
          const nextCard = post.querySelector(':scope > [data-tpp-ui="preview"]');
          const nextShown =
            nextCard && !post.classList.contains('tpp-unfold') ? nextCard : post;
          nextBox = nextShown.getBoundingClientRect();
          break;
        }
        next = next.nextElementSibling;
      }

      const space = nextBox ? (nextBox.top - bottom) / 2 : 8;
      const floor = bottom - rowRect.top + 2;
      const top = bottom - rowRect.top + Math.max(space, 2) - seam.offsetHeight / 2;
      // Only when it moves: writing the same value on every scan is a mutation,
      // and a mutation on our own node is what a scan loop feeds on.
      const nextTop = `${Math.round(Math.max(top, floor))}px`;
      if (seam.style.top !== nextTop) seam.style.top = nextTop;
    }
  }

  /**
   * Teams' "Last read" divider closes the last-read post, so the folded card
   * carries a copy of Teams' own divider underneath itself — the line, the word
   * and the spacing are Teams' own, in Teams' own place and in either theme. It
   * sits in the row's own flow after the card, so it takes its line and nothing
   * more: no reserved band, and so no gap over the first unread post.
   */
  function paintLastRead(row, wanted) {
    let seam = row.querySelector(':scope > [data-tpp-ui="last-read"]');
    const native = wanted ? nativeLastRead(row) : null;
    // Teams' own line, when it is really painted on the page, is the one to
    // show: a copy would double it. A divider the fold covers has no boxes at
    // all, so it is not on screen and the copy is drawn instead. Deciding this by
    // drawing rather than by where the element sits is what keeps a hidden
    // divider from leaving the condensed view with no line at all.
    const shownByTeams = Boolean(native) && hasBox(native);
    // No card, no line: a row the fold could not draw is not a post to mark, and
    // the band would show up as a gap on its own.
    const carded = Boolean(row.querySelector(':scope > [data-tpp-ui="preview"]'));

    if (!wanted || shownByTeams || !carded) {
      seam?.remove();
      row.classList.remove('tpp-last-read-row');
      return;
    }
    // The row gives the line a small band of its own, so it is not crammed into
    // the gap Teams leaves between posts.
    row.classList.add('tpp-last-read-row');
    if (seam) return;

    seam = document.createElement('div');
    seam.className = 'tpp-last-read';
    seam.dataset.tppUi = 'last-read';
    seam.setAttribute('aria-hidden', 'true');

    if (native) {
      const copy = native.cloneNode(true);
      copy.removeAttribute('id');
      copy.removeAttribute('role');
      copy.removeAttribute('aria-labelledby');
      copy.removeAttribute('data-tid');
      copy.classList.remove('tpp-detail');
      copy.classList.add('tpp-last-read-native');
      for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
      // Nothing in the copy may look like Teams' divider again, or the next scan
      // would take our own copy for the real thing and skip drawing.
      for (const el of copy.querySelectorAll('[data-tid]')) el.removeAttribute('data-tid');
      seam.append(copy);
    } else {
      // Nothing to copy (a build that draws the divider elsewhere): the same
      // line-and-label shape, in the page's own colours.
      seam.innerHTML =
        '<span class="tpp-last-read-line"></span>' +
        '<span class="tpp-last-read-label">Last read</span>' +
        '<span class="tpp-last-read-line"></span>';
    }
    // After the card, not before it: the line ends the last-read post.
    row.append(seam);

    // One boundary, one line: a copy left on a recycled or duplicated row goes.
    for (const other of (findMessageList() || document).querySelectorAll(
      '[data-tpp-ui="last-read"]'
    )) {
      if (other !== seam) other.remove();
    }
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

  /** What a status message is centred on: the post that changed. */
  let toastAnchor = null;

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
   * falling back to the timestamp element. Used only to read the sort order.
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
    const body = first(S.messageBody, row) || row;
    const clone = body.cloneNode(true);
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
   * The line a pinned bar shows after the author: a post's subject is its first
   * written line ("Jonathan Kung: Here are some good websites"). Only pinned
   * posts are asked for it, since reading layout text is not free and the list
   * is scanned on every Teams render.
   */
  function subjectOf(row) {
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

    const rows = [];
    for (const header of headers) {
      let row = null;
      for (let node = header.parentElement; node && node !== root; node = node.parentElement) {
        let count = 0;
        try {
          count = node.querySelectorAll(marker).length;
        } catch (_) {
          break;
        }
        if (count > 1) break;
        row = node;
      }
      // Degenerate markup with no wrapper of its own: still give the post a row.
      if (!row) row = header.parentElement;
      if (row && !rows.includes(row)) rows.push(row);
    }
    return rows;
  }

  function collectRows(root, allowDialog) {
    const candidates = new Set(headerRows(root));
    try {
      for (const el of root.querySelectorAll(S.messageRow.join(','))) candidates.add(el);
    } catch (_) {
      // A bad selector from a hand edit should not cost us the header rows.
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
    const native = new Map();
    let pinsChanged = false;

    for (const row of collectRows(list, false)) {
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
        // A recycled node: rebuild its controls for the post it now holds.
        delete row.dataset.tppPainted;
      }
      row.classList.add('tpp-post');

      const nativePinned = isNativePinned(row);
      const authored = authorOf(row);
      // A bar reads "Author: subject line", so only pinned posts pay for it.
      // A pinned post is hidden in the stream, where there are no line boxes for
      // innerText to take the first line from, so the line is remembered while
      // the post is visible and reused after it moves onto its bar.
      let subject = text;
      if (pins[id] || nativePinned) {
        subject = row.dataset.tppSubject || subjectOf(row) || text;
        if (row.dataset.tppSubject !== subject) row.dataset.tppSubject = subject;
      }

      // Keep a bar's wording in step with an edited post, and fill in an author
      // that could not be read when the pin was made (the post was not loaded).
      if (pins[id]) {
        // Fill in the copy of the post, so a bar still has its words once
        // Teams has dropped the post from the channel.
        const body = fullTextOf(row);
        const missingBody = body.length > (pins[id].b || '').length;
        if (pins[id].x !== subject || (!pins[id].a && authored) || missingBody) {
          pins[id].x = subject;
          if (!pins[id].a && authored) pins[id].a = authored;
          if (missingBody) pins[id].b = body;
          pinsChanged = true;
        }
      }

      // The whole model: no tag means Inbox, and archiving is the only thing
      // that adds one.
      setTag(row, archive[id] ? 'archive' : '');
      if (row.dataset.tppNativePin !== (nativePinned ? '1' : '0')) {
        row.dataset.tppNativePin = nativePinned ? '1' : '0';
      }
      paintRow(row, nativePinned);

      if (nativePinned) native.set(id, { id, text: subject, author: authored });
      next.set(id, {
        row,
        id,
        text,
        author: authored,
        archived: row.dataset.tppTag === 'archive',
        ts: timeOf(id, row)
      });
    }

    rowsById = next;
    nativePins = native;
    syncLastReadBands();
    placeLastRead();
    harvestPinnedPane();
    applyViewFiltering();

    if (pinsChanged) savePinsSoon();
  }

  /**
   * Keeps the tag on every post in the page in step with the archive map — not
   * just this scan's rows, because Teams keeps stale nodes around while it
   * virtualises. Which of the two views a post appears in is then plain CSS on
   * that tag (teams.css), so no inline display has to be maintained here.
   */
  function applyViewFiltering() {
    let anyArchived = false;
    for (const row of document.querySelectorAll('.tpp-post')) {
      // A node this scan does not know as a post — a recycled wrapper, a copy
      // Teams left behind — keeps no controls: a rail of its own would float in
      // the list with no post under it, which is how a lone Archive/Pin pair
      // appeared in the middle of an empty Archive.
      const record = row.dataset.tppId ? rowsById.get(row.dataset.tppId) : null;
      if (record ? record.row !== row : row.dataset.tppModal !== '1') {
        clearPostUi(row);
        continue;
      }

      const isArchived = Boolean(row.dataset.tppId && archive[row.dataset.tppId]);
      setTag(row, isArchived ? 'archive' : '');
      paintRow(row, row.dataset.tppNativePin === '1');
      if (isArchived) anyArchived = true;
    }
    publishArchivePresence(anyArchived);
  }

  /** Takes our own controls and marks off a row that is no longer a post. */
  function clearPostUi(row) {
    row.classList.remove('tpp-post', 'tpp-unfold', 'tpp-previewed', 'tpp-last-read-row');
    delete row.dataset.tppPainted;
    for (const el of row.querySelectorAll('[data-tpp-ui]')) el.remove();
  }

  /**
   * Publishes whether this channel has an archived post at all, for the
   * stylesheet. The Archives view only takes the untagged posts out of the
   * layout once there is an archived post to show (teams.css). Emptying a
   * virtualised message list leaves it with no height, so it decides it has
   * been scrolled to the end and fetches the rest of the channel's history in
   * batch after batch — which is what made a long channel page through every
   * old post, and the tab counts climb and fall while it did.
   */
  function publishArchivePresence(anyArchived) {
    const html = document.documentElement;
    if (!html) return;
    if (features && channelMode && features.inboxZero && anyArchived) {
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
    const tag = row.dataset.tppTag === 'archive' ? 'archive' : '';

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
      // The post's own pin button shows the pin state, so a pin or unpin has to
      // repaint the row even though nothing else about it changed.
      pins[row.dataset.tppId] ? '1' : '0',
      features.inboxZero ? '1' : '0',
      features.pinnedMessages ? '1' : '0'
    ].join('|');

    const railGone =
      (features.inboxZero || features.pinnedMessages) &&
      !row.querySelector('.tpp-post-actions');
    if (row.dataset.tppPainted !== painted || railGone) {
      row.dataset.tppPainted = painted;
      injectActions(row, tag === 'archive', nativePinned);
    }

  }

  /** Repaint one post the moment it is archived or unarchived. */
  function paintArchived(id, isArchived) {
    for (const row of document.querySelectorAll('.tpp-post')) {
      if (row.dataset.tppId !== id) continue;
      setTag(row, isArchived ? 'archive' : '');
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
      let score = 0;
      if (preview.startsWith(wanted)) score = 2;
      else if (preview.includes(wanted)) score = 1;
      else if (wanted.startsWith(preview) && preview.length >= 4) score = 1;
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
   * A pin whose post is not loaded is still shown: its sidebar item stays on the
   * entry so clicking the bar can ask Teams itself to jump to the post.
   */
  function harvestPinnedPane() {
    const pane = first(S.pinnedPane);
    if (!pane) return;

    for (const item of pane.querySelectorAll('[role="menuitem"]')) {
      const text = paneItemText(item);
      if (!text) continue;

      const author = paneItemAuthor(item, text);
      const record = pinnedSidebarPost(text, author);
      const id = record ? record.id : '';

      // Keyed by post id, so one post can never grow two bars.
      nativePins.set(id ? 'pane:' + id : 'pane:item:' + hash(text), {
        id,
        text: record ? record.row.dataset.tppSubject || subjectOf(record.row) || text : text,
        author: record ? authorOf(record.row) || author : author,
        paneItem: item
      });

      // Its own pin button reads as a moderator pin, and stays disabled.
      if (record && record.row.dataset.tppNativePin !== '1') {
        record.row.dataset.tppNativePin = '1';
      }
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
   * Archive / Pin sit in the left margin of the post, one above the other, and
   * only appear while the post is hovered or focused so the avatar stays clear.
   */
  function injectActions(row, isArchived, nativePinned) {
    let actions = row.querySelector('[data-tpp-ui="actions"]');

    if (!features.inboxZero && !features.pinnedMessages) {
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
        setArchived(
          postIdOf(target) || row.dataset.tppId,
          target.dataset.tppArchived !== '1'
        );
      });
      actions.append(archiveBtn);
    }
    archiveBtn.hidden = !features.inboxZero;
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
    archiveBtn.dataset.tppArchived = isArchived ? '1' : '0';
    // A pinned post is the bar's target, so it is never archived from under the
    // bar: unpinning comes first, and the button says so rather than failing.
    const cannotArchive =
      Boolean(features.pinnedMessages) &&
      (Boolean(pins[row.dataset.tppId]) || Boolean(nativePinned));
    archiveBtn.disabled = cannotArchive && !isArchived;
    archiveBtn.title = cannotArchive && !isArchived
      ? 'Unpin this post first — a pinned post cannot be archived'
      : isArchived
        ? 'Unarchive this post and put it back in your Inbox'
        : 'Archive this post — it moves to your Archive';
    archiveBtn.setAttribute('aria-label', archiveBtn.title);
    archiveBtn.classList.toggle('is-on', isArchived);

    let pinBtn = actions.querySelector('.tpp-pin-btn');
    if (!pinBtn) {
      pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'tpp-post-btn tpp-pin-btn';
      pinBtn.dataset.tppUi = 'pin';
      pinBtn.innerHTML =
        '<span class="tpp-post-btn-icon"></span><span class="tpp-post-btn-label"></span>';
      pinBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePin(postIdOf(event.currentTarget) || row.dataset.tppId);
      });
      actions.append(pinBtn);
    }
    // An archived post has no pin control: it is not in the channel view any
    // more, so a bar for it would point at a hidden post.
    pinBtn.hidden = !features.pinnedMessages || isArchived;

    const locallyPinned = Boolean(pins[row.dataset.tppId]);
    const pinnedNow = locallyPinned || nativePinned;
    // Pinned reads as a filled pin, unpinned as its outline.
    setButtonIcon(
      pinBtn,
      pinnedNow ? 'filled' : 'outline',
      pinnedNow ? PIN_FILLED_SVG : PIN_SVG
    );
    const pinLabel = pinBtn.querySelector('.tpp-post-btn-label');
    const pinText = nativePinned ? 'Pinned' : locallyPinned ? 'Unpin' : 'Pin';
    if (pinLabel.textContent !== pinText) pinLabel.textContent = pinText;
    pinBtn.disabled = nativePinned;
    pinBtn.title = nativePinned
      ? 'Pinned by a channel moderator'
      : locallyPinned
        ? 'Remove this post from your pinned bar'
        : 'Pin this post to the top of the channel';
    pinBtn.setAttribute('aria-label', pinBtn.title);
    pinBtn.classList.toggle('is-on', locallyPinned || nativePinned);
  }

  /** True while this post is pinned, by the user or by a moderator. */
  function isPinnedPost(id) {
    if (!id) return false;
    if (pins[id]) return true;
    const row = findRow(id);
    return Boolean(row && row.dataset.tppNativePin === '1');
  }

  function setArchived(id, wantArchived) {
    if (!id) return;

    // A pinned post is the target of its bar, so it is never archived from
    // under the bar: unpinning comes first.
    if (wantArchived && isPinnedPost(id)) {
      toast('Unpin this post first — a pinned post cannot be archived.', anchorFor(id));
      return;
    }
    // The post is about to be hidden (or shown again), so the message keeps
    // hold of where it was: the news belongs on the post itself.
    const where = anchorFor(id);

    if (wantArchived) {
      // The tag is what hides a post, so it is written once the post has left:
      // one that disappears in the same frame reads as a glitch, not an archive.
      const row = findRow(id);
      animateArchiveOut(row ? [row] : [], () => {
        archive[id] = { t: Date.now() };
        saveArchiveSoon();
        paintArchived(id, true);
        scan();
        toast('Archived — hidden from your Inbox.', where);
      });
      return;
    }

    delete archive[id];
    saveArchiveSoon();
    // Answer the click at once: Teams can re-render the row before the next
    // scan, and a button that appears to do nothing is worse than a stale row.
    paintArchived(id, false);
    scan();
    toast('Unarchived — back in your Inbox.', where);
  }

  /**
   * A post leaving the list is not made to vanish: it slides to the right and
   * fades, so the eye sees it go. `done` runs when the last one has left.
   */
  function animateArchiveOut(rows, done) {
    const live = Array.from(rows).filter(
      (row) => row && row.isConnected && row.getClientRects().length
    );
    if (!live.length) {
      done();
      return;
    }

    live.forEach((row, index) => {
      row.classList.remove('tpp-archiving');
      row.style.setProperty('--tpp-archive-delay', `${Math.min(index, 6) * 30}ms`);
      // Restart the animation on a row that is already running one.
      void row.offsetWidth;
      row.classList.add('tpp-archiving');
    });

    const total = ARCHIVE_ANIM_MS + Math.min(live.length - 1, 6) * 30;
    setTimeout(() => {
      for (const row of live) {
        row.classList.remove('tpp-archiving');
        row.style.removeProperty('--tpp-archive-delay');
      }
      done();
    }, total);
  }

  function togglePin(id) {
    if (!id) return;
    const where = anchorFor(id);
    let message;

    if (pins[id]) {
      delete pins[id];
      message = 'Unpinned — it can be archived again.';
    } else {
      const record = rowsById.get(id);
      const row = record?.row || null;
      pins[id] = {
        x: (row ? subjectOf(row) : '') || record?.text || '',
        a: record?.author || '',
        // The whole post, kept with the pin: Teams only holds the posts it has
        // rendered, so an old pin can outlive its post in the channel, and this
        // copy is what the pin shows then.
        b: fullTextOf(row),
        t: Date.now(),
        at: record?.ts || 0
      };
      message = 'Pinned — the bar at the top jumps to it.';
    }

    savePinsSoon();
    scan();
    toast(message, where);
  }

  /**
   * Archive every post older than the seam the user is hovering.
   *
   * Which side of the line is older is decided by the two posts either side of
   * it — the date and time each one shows, not where they sit on screen — so it
   * is right whether the channel lists newest first, oldest first, or after the
   * user flips that setting in Teams. Everything on the older side is archived.
   */
  function archiveOlderPosts(aboveId, belowId) {
    const rows = rowsInPaintOrder();
    if (!rows.length) return;

    // The seam's own two posts, looked up by id: the post above the line and the
    // post below it. Positions are never assumed, since the map is not the list.
    const belowIndex = rows.findIndex((record) => record.id === belowId);
    if (belowIndex < 0) return;
    const aboveIndex = rows.findIndex((record) => record.id === aboveId);
    const above = aboveIndex >= 0 ? rows[aboveIndex] : null;
    const below = rows[belowIndex];

    // The two dates the button is asked to compare: the time printed on each
    // post's card, and the stamp behind it. Newest-first lists show the newer
    // post above the line, so there the older side is below it.
    const aboveTs = above ? previewTimeOf(above.row) || above.ts : 0;
    const belowTs = previewTimeOf(below.row) || below.ts;

    let olderIsBelow;
    if (aboveTs > 0 && belowTs > 0 && aboveTs !== belowTs) {
      olderIsBelow = belowTs < aboveTs;
    } else {
      // The pair itself is undated (the same minute, or a build without ids):
      // the first and last dated post on screen still say which way the list
      // runs. Only when nothing at all is dated does it come down to a guess,
      // and Teams' channel posts run newest first, top to bottom.
      const dated = rows
        .map((record) => previewTimeOf(record.row) || record.ts || 0)
        .filter((ts) => ts > 0);
      olderIsBelow = dated.length > 1 ? dated[dated.length - 1] < dated[0] : true;
    }

    // Everything from the line to the end of the older side.
    let targets = olderIsBelow ? rows.slice(belowIndex) : rows.slice(0, belowIndex);

    // And a check on the dates themselves: a post known to be newer than both
    // posts at the seam is never archived. If that empties the side, the side
    // itself was the wrong one, so the other side is taken instead.
    if (aboveTs > 0 && belowTs > 0) {
      const cut = Math.min(aboveTs, belowTs);
      const onlyOlder = (list) =>
        list.filter((record) => {
          const ts = previewTimeOf(record.row) || record.ts;
          return !ts || ts <= cut;
        });
      const kept = onlyOlder(targets);
      targets = kept.length
        ? kept
        : onlyOlder(olderIsBelow ? rows.slice(0, belowIndex) : rows.slice(belowIndex));
    }

    const now = Date.now();
    const leaving = [];
    let keptPinned = 0;
    for (const record of targets) {
      if (archive[record.id]) continue;
      // A bulk action leaves pinned posts alone too: a pin is taken down by
      // hand, one at a time, so nobody loses one to a hover control.
      if (isPinnedPost(record.id)) {
        keptPinned += 1;
        continue;
      }
      leaving.push(record);
    }

    const added = leaving.length;
    gapZone = null;
    hideGap();

    if (!added) {
      toast('Everything on that side is already archived.');
      return;
    }

    savePinsSoon();
    // Nothing is tagged until the last post has slid away: the tag is what
    // hides a post, and hiding them first would leave only the animation of a
    // list that had already collapsed.
    animateArchiveOut(
      leaving.map((record) => record.row),
      () => {
        for (const record of leaving) archive[record.id] = { t: now };
        saveArchiveSoon();
        scan();
        // Not one post's doing, so this message sits in the middle of the list.
        toast(
          `Archived ${added} older post${added === 1 ? '' : 's'}.` +
            (keptPinned ? ' Pinned posts were left alone.' : '')
        );
      }
    );
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

  function buildPinEntries() {
    const entries = [];
    const seen = new Set();

    // Moderator pins always sit above the user's own pins.
    for (const pin of nativePins.values()) {
      if (pin.id && seen.has(pin.id)) continue;
      if (pin.id) seen.add(pin.id);
      const record = pin.id ? rowsById.get(pin.id) : null;
      entries.push({
        ...pin,
        kind: 'native',
        canUnpin: canUnpinNative(pin.id, pin.paneItem),
        snippet: snippetOf(record?.row, pin.text),
        body: record ? previewOf(record.row).slice(0, 1200) : ''
      });
    }

    for (const [id, pin] of Object.entries(pins)) {
      if (seen.has(id)) continue;
      const record = rowsById.get(id);
      entries.push({
        id,
        text: pin.x || 'Pinned post',
        author: pin.a || '',
        kind: 'user',
        body: pin.b || '',
        at: pin.at || 0,
        snippet: snippetOf(record?.row, pin.x || record?.text || '')
      });
    }

    return entries;
  }

  /** A pin's stable name: one post can only ever have one bar. */
  function pinKey(entry) {
    if (entry.id) return `${entry.kind}:${entry.id}`;
    return `${entry.kind}:text:${collapse(entry.text || entry.author || '').toLowerCase()}`;
  }

  /** The pin each bar currently stands for, so a re-render never loses its post. */
  const pinEntryOf = new WeakMap();

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
    bar.title = 'Jump to this post in the channel';

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
    const kind = entry.kind === 'user' ? 'user' : entry.canUnpin ? 'native' : '';
    if (!kind) return null;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tpp-pin-unpin';
    button.dataset.tppUi = 'unpin';
    button.dataset.tppUnpin = kind;
    button.title = kind === 'user' ? 'Unpin this post' : 'Unpin this post for everyone';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = PIN_FILLED_SVG;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'user') togglePin(entry.id);
      else unpinNative(entry.id);
    });
    return button;
  }

  /** Brings an existing bar up to date in place, without rebuilding it. */
  function updatePinItem(item, entry) {
    pinEntryOf.set(item, entry);

    const title = item.querySelector('.tpp-pin-bar-title');
    const unpin = item.querySelector('.tpp-pin-unpin');
    const wantedUnpin = entry.kind === 'user' ? 'user' : entry.canUnpin ? 'native' : '';
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
   * Takes the user to a pinned post in the channel.
   *
   * A pin is a pointer at a post, not a copy of it: the post stays in the
   * stream, so its bar scrolls to it and flashes it. Nothing about the post is
   * moved, so its replies, reactions, reply box and menus are Teams' own.
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
      // No list to walk: the pin's own copy is the only thing there is to show.
      showPinCopy(entry);
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
    // Teams will not give the post back, so the pin shows the copy taken when
    // it was pinned rather than a bar that leads nowhere.
    showPinCopy(entry);
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

  /**
   * A pin's own copy of the post, for when Teams will not load the post itself.
   *
   * Every pin keeps the words it was pinned with, so a pin from months back
   * still shows something to read instead of an apology. The copy is read-only:
   * the post, its replies and its controls stay Teams' own, and are gone from
   * the channel, so there is nothing to hand them to.
   */
  function showPinCopy(entry) {
    hidePinCopy();

    const card = document.createElement('div');
    card.id = PIN_COPY_ID;
    card.className = 'tpp-pin-copy';
    card.dataset.tppUi = 'pin-copy';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Pinned post copy');

    const head = document.createElement('div');
    head.className = 'tpp-pin-copy-head';

    const label = document.createElement('span');
    label.className = 'tpp-pin-copy-label';
    label.textContent = 'Pinned copy';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tpp-pin-copy-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', hidePinCopy);
    head.append(label, close);

    const author = document.createElement('div');
    author.className = 'tpp-pin-copy-author';
    author.textContent = entry.author || 'Pinned post';

    const text = document.createElement('p');
    text.className = 'tpp-pin-copy-body';
    text.textContent = entry.body || entry.snippet || entry.text || '';

    const note = document.createElement('p');
    note.className = 'tpp-pin-copy-note';
    note.textContent =
      'Teams is no longer loading this post in the channel. This is the copy saved when you pinned it.';

    card.append(head, author, text, note);
    document.body.append(card);
    close.focus();
  }

  function hidePinCopy() {
    document.getElementById(PIN_COPY_ID)?.remove();
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
   * Takes the eye to one post: the list eases to it, then it flashes.
   *
   * An archived post is shown first, because the Inbox filter hides it and there
   * is nothing to scroll to while it is hidden.
   */
  function revealPost(row) {
    const id = row.dataset.tppId;
    if (id && archive[id] && view !== VIEW_ARCHIVES) setView(VIEW_ARCHIVES);

    scrollPostToCentre(row, () => {
      flashPost((id && findRow(id)) || row);
    });
  }

  /**
   * Scrolls a post to the middle of the list over a handful of frames.
   *
   * Jumping straight to the post is disorienting: it is simply there, with no
   * sign that the bar went anywhere, and an eye that was elsewhere misses it.
   * Easing the list makes the move visible, and each frame re-measures how far
   * the post still is from the middle, so it settles on the right place whatever
   * Teams' virtualisation did to the row on the way.
   */
  function scrollPostToCentre(row, done) {
    const list = lastList || findMessageList();
    if (!list) {
      try {
        row.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (_) {
        // No list to walk: the flash alone has to do.
      }
      done();
      return;
    }

    let frames = 0;

    const step = () => {
      frames += 1;
      const rect = row.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const delta = rect.top - listRect.top - (list.clientHeight - rect.height) / 2;

      if (Math.abs(delta) > 2 && frames < 90 && row.isConnected) {
        // 0.16 of the remaining distance per frame: about half a second of
        // travel, quicker over a long drop than over a short one.
        list.scrollTop += delta * 0.16;
        requestAnimationFrame(step);
        return;
      }
      done();
    };

    step();
  }

  /** Flashes one post, so the eye lands on the post the bar stood for. */
  function flashPost(row) {
    if (!row) return;

    row.classList.remove('tpp-flash');
    void row.offsetWidth; // Restart the animation when the same post is clicked twice.
    row.classList.add('tpp-flash');

    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => row.classList.remove('tpp-flash'), 1900);
  }

  /**
   * The bars belong at the very top of the channel pane, directly above Teams'
   * own "Post in channel" box. They are inserted into the page flow there, so
   * they push the posts down instead of covering the composer, and they still
   * land at the top when the composer is docked at the bottom.
   */
  function placePinStack(stack, list) {
    const composer = first(S.newPostBox);
    const listRect = list.getBoundingClientRect();
    const composerRect = composer ? composer.getBoundingClientRect() : null;

    // Measure the composer as if the stack were not there. Above the composer
    // the stack pushes it down, and a tall opened post can push it far enough
    // to read as "the composer is below the list" — which moved the stack into
    // the list, which moved it back on the next scan, over and over: the whole
    // pinned area flickered open and shut.
    //
    // The check uses parentElement rather than nextElementSibling so the
    // compensation still works when Teams inserts an element between the stack
    // and the composer (a banner, a divider, …).
    const ownHeight =
      composer && stack.parentElement === composer.parentElement ? stack.offsetHeight : 0;
    const composerTop = composerRect ? composerRect.top - ownHeight : 0;
    const composerAboveList =
      Boolean(composerRect) && composerRect.height > 0 && composerTop < listRect.top;

    stack.classList.add('tpp-pin-stack--inline');

    if (composerAboveList) {
      const host = composer.parentElement;
      if (host && composer.previousElementSibling !== stack) host.insertBefore(stack, composer);
    } else if (list.firstElementChild !== stack) {
      list.insertBefore(stack, list.firstElementChild || null);
    }

    // In the flow now, so the posts need no extra padding for it.
    return null;
  }

  function renderPins(list) {
    const existing = document.getElementById(STACK_ID);
    const entries =
      features.pinnedMessages && view === VIEW_INBOX ? buildPinEntries() : [];

    if (!list || entries.length === 0) {
      existing?.remove();
      return null;
    }

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
    for (const entry of entries) {
      const key = pinKey(entry);
      if (wanted.has(key)) continue; // One bar per post, always.
      wanted.add(key);

      const item = existingItems.get(key);
      if (item) {
        updatePinItem(item, entry);
        keep.push(item);
      } else {
        const fresh = pinBar(entry);
        stack.append(fresh);
        keep.push(fresh);
      }
    }

    for (const [key, item] of existingItems) {
      if (wanted.has(key)) continue;
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
    list.style.paddingTop = `${Math.max(base + px, 0)}px`;
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
    list.style.paddingLeft = `${pad}px`;

    // Only pull the box left when the margin has a length to work with: an auto
    // margin is doing the layout's centring and must be left alone. The pull
    // stops at the window's edge, since a gutter there would be off screen and
    // the buttons with it.
    const marginBase = parseFloat(list.dataset.tppGutterMarginBase);
    if (Number.isFinite(marginBase)) {
      const room = Math.max(list.getBoundingClientRect().left, 0);
      const pull = Math.min(pad - padBase, room);
      list.style.marginLeft = `${marginBase - pull}px`;
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

  /**
   * Keeps a filtered list from looking like it has run out of posts.
   *
   * A virtualised list measures itself to decide whether to fetch more, so a
   * channel whose Inbox posts are hidden can look scrolled to the very end and
   * make Teams pull in its older history, batch after batch. A margin under the
   * last post on show keeps at least a screen of scrolling below it — the list
   * itself never changes height, so nothing on screen moves.
   */
  function holdListDepth(list) {
    if (!list) {
      releaseListDepth();
      return;
    }

    const rows = list.querySelectorAll('.tpp-post');
    let tail = null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      // The post opened in its panel is on screen but is not the stream's end.
      if (rows[i].offsetHeight > 0 && rows[i].dataset.tppModal !== '1') {
        tail = rows[i];
        break;
      }
    }

    if (tail !== depthTail) {
      releaseListDepth();
      depthTail = tail;
      if (tail) tail.dataset.tppMarginInline = tail.style.marginBottom || '';
    }
    if (!tail) return;

    const filler = parseFloat(tail.style.marginBottom) || 0;

    // Nothing left to scroll: put a screen of space below the last post, and
    // settle on exactly what is needed on the next scan.
    if (list.scrollHeight - list.clientHeight < 80) {
      const push = list.clientHeight + 80;
      if (Math.abs(filler - push) > 1) tail.style.marginBottom = `${push}px`;
      return;
    }

    // Deep enough again: give back whatever the filler did not need to keep.
    if (filler > 0) {
      const content = list.scrollHeight - filler;
      const need = Math.max(0, Math.ceil(list.clientHeight + 80 - content));
      if (Math.abs(filler - need) > 1) tail.style.marginBottom = `${need}px`;
    }
  }

  function releaseListDepth() {
    if (!depthTail) return;
    depthTail.style.marginBottom = depthTail.dataset.tppMarginInline || '';
    delete depthTail.dataset.tppMarginInline;
    depthTail = null;
  }

  function unpinNative(id) {
    const row = findRow(id);
    if (!row) {
      toast('Open the post in the channel to unpin it.');
      return;
    }

    const where = anchorFor(id);
    const control = unpinAffordance(row);
    if (control) {
      control.click();
      toast('Asked Teams to unpin this post.', where);
      return;
    }

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
    showPostsPanel();
    if (next !== view) {
      view = next;
      writeSync({ [VIEW_KEY]: view });
    }
    gapZone = null;
    hideGap();
    apply();
  }

  function renderTabs(list) {
    const existing = document.getElementById(TABS_ID);
    const posts = features.inboxZero ? nativePostsTab() : null;

    // Keep the tabs while their tab strip is on screen even if a scan finds no
    // message list: losing them is how someone who opened Archives got stuck.
    if (!features.inboxZero || (!list && !posts)) {
      existing?.remove();
      releaseNativeTab();
      tabsPx = 0;
      return;
    }

    let wrap = existing;
    // Rebuild only when the pair has to change shape (a Posts tab to copy, or
    // none): the skin is re-applied on every scan below, so a Teams re-render
    // cannot leave both tabs looking selected, and moving around the strip does
    // not rebuild the pair.
    const buildMode = posts ? 'clone' : 'plain';
    if (!wrap || wrap.dataset.tppMode !== buildMode) {
      wrap?.remove();
      wrap = buildTabs(posts);
      wrap.dataset.tppMode = buildMode;
      document.body.append(wrap);
    }
    const skins = posts ? tabSkins(posts) : null;

    for (const button of wrap.querySelectorAll('.tpp-tab')) {
      const active = view === button.dataset.mode;
      if (skins) {
        skinTab(button, active ? skins.selected : skins.idle, active);
        continue;
      }
      // No tab to copy (a Teams build we do not recognise): own the look.
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    // The pair joins the channel tab strip where the Posts tab was: Posts leaves
    // the layout and the tabs beside it slide over by the width these two need.
    // Nothing else in the strip is inserted into, moved or hidden.
    if (posts) {
      if (hiddenNativeTab && hiddenNativeTab !== posts) releaseNativeTab();

      wrap.classList.add('tpp-tabs--inline');
      wrap.classList.remove('tpp-tabs--overlay');
      // Placement from the fallback (fixed position, offsets) must not leak in.
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

      tabsPx = 0;
      return;
    }

    // No Posts tab on screen (Teams changed its chrome): keep the tabs visible
    // above the posts rather than losing them.
    releaseNativeTab();
    wrap.classList.remove('tpp-tabs--inline');
    if (wrap.parentElement !== document.body) document.body.append(wrap);
    if (list) placeTabs(wrap, list);
    tabsPx = wrap.getBoundingClientRect().height;
  }

  /**
   * The pair. Each tab is a copy of Teams' own Posts tab (see cloneTab), so the
   * strip's type, padding, height, colour and selected bar come from Teams and
   * follow a theme change without anything being hard-coded here.
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
      const button = posts ? cloneTab(posts) : plainTab();
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

  /** Our own tab, used only when there is no Posts tab to copy. */
  function plainTab() {
    const button = document.createElement('button');
    button.className = 'tpp-tab tpp-tab--plain';
    button.innerHTML =
      '<span class="tpp-tab-shell">' +
      '<div class="tpp-tab-inner">' +
      '<div class="tpp-tab-label"></div>' +
      '</div>' +
      '</span>';
    return button;
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
   * Fallback placement: a small strip pinned to the top-left of the list. It is
   * never hidden, so the Inbox tab is always one click away.
   */
  function placeTabs(wrap, list) {
    const rect = list.getBoundingClientRect();
    wrap.style.display = 'inline-flex';
    wrap.style.position = 'fixed';
    wrap.style.top = `${Math.max(rect.top, 0) + 8}px`;
    wrap.style.left = `${Math.max(rect.left, 0) + 12}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    wrap.style.width = 'auto';
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
      const confetti = document.createElement('div');
      confetti.className = 'tpp-confetti';
      confetti.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 42; i += 1) {
        const piece = document.createElement('i');
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        piece.style.animationDelay = `${(Math.random() * 4).toFixed(2)}s`;
        piece.style.animationDuration = `${(3.5 + Math.random() * 3).toFixed(2)}s`;
        piece.style.width = `${6 + Math.random() * 6}px`;
        piece.style.height = `${10 + Math.random() * 8}px`;
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        confetti.append(piece);
      }

      const check = document.createElement('div');
      check.className = 'tpp-empty-check';
      check.innerHTML = CHECK_SVG;

      const title = document.createElement('h2');
      title.className = 'tpp-empty-title';
      title.textContent = 'Inbox Zero!';

      const copy = document.createElement('p');
      copy.className = 'tpp-empty-copy';
      copy.textContent =
        'Every post in this channel is archived. Open the Archive tab to put one back.';

      empty.append(confetti, check, title, copy);
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
    const archived = records.filter((record) => record.archived).length;

    let kind = null;
    if (view === VIEW_ARCHIVES) {
      kind = records.length > 0 && archived === 0 ? 'no-archives' : null;
    } else if (records.length > 0 && archived === records.length) {
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

    anchor(empty, list, { top: tabsPx + 18, full: true, matchHeight: true });
  }

  // ------------------------------------------------------- hover between posts

  /**
   * Posts as they are drawn, top to bottom. The map's own order comes from the
   * DOM, which is not the same thing: a list drawn bottom-up (column-reverse)
   * lists the newest post last while showing it at the top, and reading the
   * order off the map is what once pointed the seam at the wrong pair.
   */
  function rowsInPaintOrder() {
    return Array.from(rowsById.values())
      .filter((record) => record.row.isConnected && record.row.getClientRects().length)
      .sort((a, b) => a.row.getBoundingClientRect().top - b.row.getBoundingClientRect().top);
  }

  /** Recompute the seams between two visible posts, top to bottom. */
  function refreshGapZones() {
    const zones = [];
    if (features && features.inboxZero && view === VIEW_INBOX) {
      let previous = null;
      for (const record of rowsInPaintOrder()) {
        const row = record.row;
        // The post opened in its panel is over the page, not in the stream.
        if (row.dataset.tppModal === '1') continue;

        // The box the user actually sees. A folded post is its card, and the
        // row around the card carries padding that would pull the seam down,
        // which is what made the line sit nearer the post below.
        const box = row.querySelector(':scope > [data-tpp-ui="preview"]') || row;
        const rect = box.getBoundingClientRect();
        const column = row.getBoundingClientRect();
        if (!rect.height) continue;

        if (previous) {
          zones.push({
            // Halfway between the bottom of one post's box and the top of the
            // next, so the line is centred in the gap between them.
            y: (previous.rect.bottom + rect.top) / 2,
            // The seam's two posts by id: which of them is above the line is a
            // fact of the drawing, not of the map.
            aboveId: previous.record.id,
            belowId: record.id,
            left: Math.max(column.left, 0),
            width: Math.max(column.width, 240)
          });
        }
        previous = { rect, record };
      }
    }
    gapZones = zones;
  }

  function ensureGapEl() {
    if (gapZone) return gapZone;

    const el = document.createElement('div');
    el.id = GAP_ID;
    el.className = 'tpp-gap';
    el.dataset.tppUi = 'gap';

    const line = document.createElement('span');
    line.className = 'tpp-gap-line';
    line.setAttribute('aria-hidden', 'true');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tpp-gap-btn';
    button.textContent = 'Archive all older posts';
    button.title = 'Archive every post on the older side of this line';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The pointer is still on the spot the line was: without this the next
      // mousemove would put the control straight back after the click.
      gapMuteUntil = Date.now() + 700;
      hideGap();
      archiveOlderPosts(el.dataset.above || '', el.dataset.below || '');
    });

    el.append(line, button);
    document.body.append(el);
    gapZone = el;
    return el;
  }

  function showGap(zone) {
    if (!listRect) return;
    const el = ensureGapEl();
    el.dataset.above = zone.aboveId;
    el.dataset.below = zone.belowId;
    el.style.top = `${zone.y}px`;
    // No wider than the post it sits between: the line belongs to the stream,
    // not to the whole pane.
    const width = Math.max(Math.min(zone.width, window.innerWidth - zone.left), 240);
    el.style.left = `${zone.left}px`;
    el.style.width = `${width}px`;
    el.classList.add('is-on');
  }

  function hideGap() {
    document.getElementById(GAP_ID)?.classList.remove('is-on');
  }

  /** The pointer's last known position, so the control can be re-checked later. */
  let pointerX = 0;
  let pointerY = 0;
  let pointerSeen = false;
  /** A short quiet spell after a click, so the control cannot blink back. */
  let gapMuteUntil = 0;

  /**
   * Decides, for one point, whether a seam is close enough to offer the control.
   *
   * Every case ends in a definite answer, shown or hidden, so calling it again
   * without the pointer moving is safe: it is how the control is cleared when
   * the seams move under a resting cursor, the list re-renders, or the view is
   * switched by something other than a mousemove.
   */
  function evaluateGap(x, y) {
    if (
      !ready ||
      !channelMode ||
      !features ||
      !features.inboxZero ||
      view !== VIEW_INBOX ||
      !listRect ||
      Date.now() < gapMuteUntil
    ) {
      hideGap();
      return;
    }

    if (x < listRect.left - 4 || x > listRect.right + 4) {
      hideGap();
      return;
    }

    let best = null;
    for (const zone of gapZones) {
      const distance = Math.abs(y - zone.y);
      if (distance > GAP_TOLERANCE) continue;
      if (!best || distance < best.distance) best = { zone, distance };
    }

    if (!best) {
      hideGap();
      return;
    }
    showGap(best.zone);
  }

  /** Re-checks the point the pointer is resting on, without a new event. */
  function recheckGap() {
    if (!pointerSeen) return;
    evaluateGap(pointerX, pointerY);
  }

  function updateGapHover(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    pointerSeen = true;

    // Keep the control while the pointer travels onto its own button.
    if (
      gapZone &&
      gapZone.classList.contains('is-on') &&
      gapZone.contains(event.target)
    ) {
      return;
    }

    evaluateGap(pointerX, pointerY);
  }

  function onPointerMove(event) {
    if (!ready) return;
    updateGapHover(event);
  }

  // -------------------------------------------------------------- overlays

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
   * A status message: a larger, translucent card centred on the post it is
   * about, so the news appears where the change happened rather than on the
   * bottom edge of the page. Without a post to hold on to it sits in the middle
   * of the message list.
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
    toastAnchor = anchor || null;
    placeToast(el);

    // Restart the entrance, so a second message in a row is noticed.
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.remove();
      toastAnchor = null;
    }, 2600);
  }

  /** Centres the status message on its post, following it while it is visible. */
  function placeToast(el) {
    const anchor = toastAnchor;
    let box = null;

    if (anchor) {
      if (anchor.row && anchor.row.isConnected) {
        const live = anchor.row.getBoundingClientRect();
        if (live.width > 8 && live.height > 8) box = live;
      }
      if (!box) box = anchor.rect;
    }

    if (!box) {
      const list = lastList || findMessageList();
      box = list ? list.getBoundingClientRect() : null;
    }

    el.style.left = `${box ? box.left + box.width / 2 : window.innerWidth / 2}px`;
    el.style.top = `${box ? box.top + box.height / 2 : window.innerHeight / 2}px`;
  }

  function reposition() {
    if (!ready || !channelMode || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const list = findMessageList();
      if (!list) return;

      listRect = list.getBoundingClientRect();

      const tabs = document.getElementById(TABS_ID);
      // The inline pair is a child of the tab strip and flows with it; only the
      // fallback needs re-anchoring to the list.
      if (tabs && !tabs.classList.contains('tpp-tabs--inline')) {
        placeTabs(tabs, list);
        tabsPx = tabs.getBoundingClientRect().height;
      }

      const stack = document.getElementById(STACK_ID);
      if (stack) placePinStack(stack, list);

      const empty = document.getElementById(EMPTY_ID);
      if (empty) anchor(empty, list, { top: tabsPx + 18, full: true, matchHeight: true });

      const message = document.getElementById(TOAST_ID);
      if (message) placeToast(message);

      refreshGapZones();
      placeLastRead();
      hideGap();
    });
  }

  // ------------------------------------------------------ which channel this is

  /**
   * The channel a pin belongs to.
   *
   * Teams names the channel in its own path — /l/channel/<id>/<name>, or
   * /l/chat/<id> for a chat — so the path is the namespace: a pin made in one
   * channel stays out of the next, and a chat's pins stay out of both.
   */
  function channelKey() {
    const path = String(location.pathname || '').replace(/\/+$/, '');
    return path ? path.slice(0, 220) : 'teams';
  }

  /** The current channel's bucket, created on first use. */
  function pinsFor(channel) {
    if (!pinsAll[channel] || typeof pinsAll[channel] !== 'object') pinsAll[channel] = {};
    return pinsAll[channel];
  }

  /**
   * Moves `pins` to whichever channel is on screen. Teams changes channels
   * without a page load, so this is checked on every scan.
   */
  function syncPinChannel() {
    const channel = channelKey();
    if (channel === pinChannel) return false;
    pinChannel = channel;
    pins = pinsFor(channel);
    return true;
  }

  /**
   * The post's whole text, kept with a pin.
   *
   * Teams holds only the posts it has rendered, so a pin can outlive the post in
   * the channel's history. This snapshot is what lets the pin still show the
   * post after Teams has stopped loading it.
   */
  function fullTextOf(row) {
    if (!row) return '';
    const body = first(S.messageBody, row) || row;
    const clone = body.cloneNode(true);
    for (const injected of clone.querySelectorAll('[data-tpp-ui], .tpp-post-actions')) {
      injected.remove();
    }
    return collapse(clone.textContent || '').slice(0, 2000);
  }

  // -------------------------------------------------------------- persistence

  function saveArchiveSoon() {
    clearTimeout(archiveSaveTimer);
    archiveSaveTimer = setTimeout(() => {
      archiveSaveTimer = 0;
      persistArchive();
    }, 200);
  }

  function savePinsSoon() {
    clearTimeout(pinsSaveTimer);
    pinsSaveTimer = setTimeout(() => {
      pinsSaveTimer = 0;
      persistPins();
    }, 200);
  }

  async function persistArchive() {
    let trimmed = Object.fromEntries(Object.entries(archive).slice(-ARCHIVE_LIMIT));
    archive = trimmed;

    if (await writeSync({ [ARCHIVE_KEY]: trimmed })) return;

    // Per-item quota: keep only the newest quarter and try once more rather
    // than silently losing the change.
    trimmed = Object.fromEntries(
      Object.entries(trimmed).slice(-Math.max(10, Math.floor(ARCHIVE_LIMIT / 4)))
    );
    archive = trimmed;
    await writeSync({ [ARCHIVE_KEY]: trimmed });
  }

  /**
   * Writes every channel's pins, trimmed to the newest pins in the newest
   * channels, so one busy channel cannot spend the sync quota and push out the
   * pins of a channel the user is still working in.
   */
  async function persistPins() {
    const channel = channelKey();
    pinsAll[channel] = pins;

    let trimmed = normalizePins(pinsAll, PIN_LIMIT, PIN_CHANNEL_LIMIT);
    pinsAll = trimmed;
    pins = pinsFor(channel);

    if (await writeSync({ [PINS_KEY]: trimmed })) return;

    // Per-item quota: keep the newest quarter of this channel's pins and try
    // once more rather than silently losing the change.
    const keep = Math.max(10, Math.floor(PIN_LIMIT / 4));
    trimmed[channel] = Object.fromEntries(Object.entries(pins).slice(-keep));
    pins = pinsFor(channel);
    await writeSync({ [PINS_KEY]: trimmed });
  }

  // ------------------------------------------------------------- placeholders

  /**
   * Teams draws shimmer stand-ins for posts it is still fetching. On a filtered
   * view — Archives most of all, where most posts are hidden — they read as a
   * blank post at the bottom of the list. They are marked here and taken out of
   * the layout there (teams.css).
   */
  function markLoadingRows(list) {
    for (const el of list.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }

    const selectors = S.loadingRow || [];
    if (!selectors.length) return;

    for (const el of list.querySelectorAll(selectors.join(','))) {
      // A skeleton inside a real post (a link card still loading) is that
      // post's own business, not a stand-in row.
      if (el.closest('.tpp-post')) continue;

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

  // ------------------------------------------------------------------- scan

  function scan() {
    if (!ready) return;

    // Teams changes view without a page load, so the question is asked again on
    // every scan. In a chat (or anywhere that is not a channel) the flags come
    // off and whatever was drawn in a channel is taken down. `null` means the
    // page is still settling, and then nothing is decided either way — a
    // channel is never torn down because its posts have not rendered yet.
    const verdict = channelVerdict();
    if (verdict !== null && verdict !== channelMode) {
      channelMode = verdict;
      syncFeatureFlags();
    }
    if (channelMode === false) {
      teardownChannelUi();
      return;
    }
    if (channelMode !== true) return;

    // The channel is the nearest painted thing to a post, so it is the best
    // answer to "is this page dark?" — and a scan is already running.
    applyTheme();

    // Teams swaps channels in place, and a pin belongs to its channel: the
    // bars have to move to the new channel's pins before anything is drawn.
    syncPinChannel();

    // A reply box that our own styles were put into by an earlier match is
    // given back before this scan looks for the list again.
    for (const el of document.querySelectorAll('.tpp-list')) {
      if (!isComposeField(el)) continue;
      el.classList.remove('tpp-list');
      clearLeftInset(el);
      clearTopInset(el);
    }

    const list = findMessageList();

    // Our own overlays and buttons must not re-trigger the observer.
    if (observer) observer.disconnect();
    try {
      if (!list) {
        for (const id of [STACK_ID, EMPTY_ID, GAP_ID]) {
          document.getElementById(id)?.remove();
        }
        // The tabs live in the channel's own tab strip, so they survive a scan
        // that finds no list; renderTabs drops them once that strip is gone.
        renderTabs(null);
        gapZone = null;
        gapZones = [];
        document.documentElement.removeAttribute(HAS_ARCHIVES_ATTR);
        clearTopInset();
        clearLeftInset();
        return;
      }

      lastList = list;
      listRect = list.getBoundingClientRect();

      // The stylesheet needs to know which element is the message list to keep
      // it in place in an empty Archives (see publishArchivePresence).
      list.classList.toggle('tpp-list', Boolean(features.inboxZero));

      rebuildRows(list);
      markLoadingRows(list);
      renderTabs(list);
      const stack = renderPins(list);
      renderEmpty(list);

      // Keep the first post clear of the floating tabs and pinned bars.
      let pad = tabsPx ? tabsPx + 12 : 0;
      if (stack) pad = Math.max(pad, stack.bottom - listRect.top + 10);
      if (pad > 0) applyTopInset(list, pad);
      else clearTopInset(list);

      if (features.inboxZero || features.pinnedMessages) applyLeftInset(list);
      else clearLeftInset(list);

      // Filtered posts out of the list can look like the end of its history;
      // the same filler keeps that from pulling in the whole channel.
      if (features.inboxZero && view === VIEW_ARCHIVES) {
        holdListDepth(list);
      } else {
        releaseListDepth();
      }

      refreshGapZones();
      // The seams have just moved or gone: re-check where the pointer is, so the
      // control cannot outlive the gap it was describing.
      recheckGap();
    } finally {
      if (observer) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    }
  }

  function scheduleScan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      scan();
    }, 300);
  }

  // -------------------------------------------------------------- bootstrap

  function apply() {
    if (!ready) return;
    const html = document.documentElement;
    if (!html) return;

    syncFeatureFlags();

    if (!features.inboxZero) {
      html.removeAttribute(HAS_ARCHIVES_ATTR);
      for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
      releaseListDepth();
      // Forget the cached paint so every post's buttons are rebuilt.
      for (const el of document.querySelectorAll('.tpp-post')) {
        delete el.dataset.tppPainted;
      }
    }

    if (!features.pinnedMessages) {
      document.getElementById(STACK_ID)?.remove();
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
      return false;
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
   * page itself — tabs, pin bars, the empty state, the seam control, the rail and
   * every mark on a row — so a chat is exactly as Teams made it.
   */
  function teardownChannelUi() {
    for (const id of [TABS_ID, STACK_ID, EMPTY_ID, GAP_ID, TOAST_ID, PIN_COPY_ID]) {
      document.getElementById(id)?.remove();
    }
    hideSearchCancel();

    gapZone = null;
    gapZones = [];
    toastAnchor = null;
    lastList = null;
    listRect = null;

    releaseNativeTab();
    clearTopInset();
    clearLeftInset();
    releaseListDepth();

    for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
    for (const el of document.querySelectorAll('.tpp-post')) clearPostUi(el);
    for (const el of document.querySelectorAll('[data-tpp-placeholder]')) {
      delete el.dataset.tppPlaceholder;
    }

    document.documentElement.removeAttribute(HAS_ARCHIVES_ATTR);
  }

  async function bootstrap() {
    const items = await readSync({
      [STORAGE_KEY]: null,
      [ARCHIVE_KEY]: null,
      [PINS_KEY]: null,
      [VIEW_KEY]: null
    });

    features = normalize(items[STORAGE_KEY]);
    archive = normalizeMap(items[ARCHIVE_KEY], ARCHIVE_LIMIT);

    const storedPins = items[PINS_KEY];
    pinsAll = normalizePins(storedPins, PIN_LIMIT, PIN_CHANNEL_LIMIT);
    pinChannel = channelKey();
    if (isLegacyPins(storedPins)) {
      // Pins from before pins were per channel name no channel. They were made
      // somewhere, and the channel the user is in is the one that adopts them.
      pinsAll[pinChannel] = normalizeMap(storedPins, PIN_LIMIT);
      pins = pinsFor(pinChannel);
      savePinsSoon();
    } else {
      pins = pinsFor(pinChannel);
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

    observer = new MutationObserver(scheduleScan);
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
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hidePinCopy();
    });
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition);

    // The gap control follows the pointer, so only a mousemove can reveal it.
    document.addEventListener('mousemove', onPointerMove, { passive: true });
    document.addEventListener('mouseleave', hideGap);
    // A resting cursor produces no mousemove, and neither does a keyboard or a
    // window switch, so the control is cleared by those too.
    window.addEventListener('blur', hideGap);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideGap();
    });

    bootstrap();
  }

  // Keep an open tab in sync when settings, archives or pins change elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !ready) return;
    if (changes[STORAGE_KEY]) features = normalize(changes[STORAGE_KEY].newValue);
    if (changes[ARCHIVE_KEY]) archive = normalizeMap(changes[ARCHIVE_KEY].newValue, ARCHIVE_LIMIT);
    if (changes[PINS_KEY]) {
      pinsAll = normalizePins(changes[PINS_KEY].newValue, PIN_LIMIT, PIN_CHANNEL_LIMIT);
      pins = pinsFor(channelKey());
    }
    if (changes[VIEW_KEY]) view = normalizeView(changes[VIEW_KEY].newValue);
    if (features) apply();
  });

  // At document_start the parser may not have created <html> yet.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
