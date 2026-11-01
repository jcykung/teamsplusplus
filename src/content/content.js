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
 *                   menu bar, above the "Post in channel" box. A bar opens the
 *                   post in a modal over a blurred page, so nothing behind it
 *                   moves.
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
    normalizeView,
    readSync,
    writeSync
  } = globalThis.TeamsPlusPlus;
  const S = globalThis.TeamsPlusPlusSelectors;

  const ARCHIVE_LIMIT = 150;
  const PIN_LIMIT = 40;

  const VIEW_INBOX = 'inbox';
  const VIEW_ARCHIVES = 'archives';

  const TABS_ID = 'tpp-tabs';
  const STACK_ID = 'tpp-pin-stack';
  const EMPTY_ID = 'tpp-empty-state';
  const GAP_ID = 'tpp-gap';
  const TOAST_ID = 'tpp-toast';
  const MODAL_ID = 'tpp-pin-modal';
  const HAS_ARCHIVES_ATTR = 'data-tpp-has-archives';
  /** Set on <html> while a pinned post is lifted into its panel. */
  const MODAL_ATTR = 'data-tpp-pin-modal';
  /** The build on disk; also left on <html> so the running script can be checked. */
  const BUILD = '2026-11-01.7';

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
  const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>';
  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const EMPTY_ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 13h4"/></svg>';
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
  let pins = {};
  let view = VIEW_INBOX;

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
  /** How many posts are on a pinned bar rather than in the stream. */
  let pinnedHidden = 0;
  /** The wrapper's own inline properties a lifted panel borrows and gives back. */
  const LIFT_PROPS = [
    'position',
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'height',
    'max-height',
    'margin',
    'overflow',
    'box-sizing',
    'transform',
    'z-index',
    'display',
    'min-width',
    'max-width',
    'visibility',
    'content-visibility',
    'color',
    'background-color'
  ];

  /** What a hidden post has to be given before it can be measured. */
  const BOX_PROPS = ['display', 'visibility', 'content-visibility'];

  /** What a Teams flyout lends while it is lifted above the panel. */
  const FLYOUT_PROPS = [
    'position',
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'height',
    'margin',
    'transform'
  ];
  /** How deep a flyout is looked for inside a team of newly added nodes. */
  const FLYOUT_DEPTH = 10;

  /** The pinned post on show in the modal, if any, and the bar that opened it. */
  let pinModal = null;
  /** The live post lifted into the panel: { host, row, close, backdrop }. */
  let liveModal = null;
  let modalEntry = null;
  let modalOpener = null;
  /** Re-centres the panel when the post inside it changes size. */
  let panelObserver = null;
  let recentring = false;
  /** Watches for Teams' own flyouts so they can open above the panel. */
  let flyoutWatch = null;
  let flyoutFrame = 0;
  /** Nodes added since the last frame, searched for a flyout on the next one. */
  let flyoutQueue = [];
  /** What each lifted flyout borrowed, so it can be given back on close. */
  const flyoutSaved = new Map();
  /** The short sweeps run after an interaction, which is when a picker opens. */
  let flyoutSweepTimer = 0;
  /** Where the last click landed: what a picker opening there is looked for. */
  let flyoutPoint = null;

  let rescanTimer = 0;
  let archiveSaveTimer = 0;
  let pinsSaveTimer = 0;
  let frame = 0;
  let toastTimer = 0;
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

  function isScrollable(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const overflow = getComputedStyle(el).overflowY;
    if (!/(auto|scroll|overlay)/.test(overflow)) return false;
    return el.scrollHeight > el.clientHeight + 40;
  }

  function findMessageList() {
    const direct = first(S.messageList);
    if (direct) return direct;

    // Markup changed: climb from a known row to whatever actually scrolls.
    const row = first(S.messageRow);
    for (let node = row; node && node !== document.body; node = node.parentElement) {
      if (isScrollable(node)) return node;
    }
    return null;
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

    const stamp = row.querySelector('time[datetime]')?.getAttribute('datetime');
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Channels can list posts newest-first or oldest-first. Comparing the first
   * and last post's own timestamp tells which way this channel is sorted.
   */
  function sortDirection() {
    const stamps = [];
    for (const record of rowsById.values()) {
      if (record.ts) stamps.push(record.ts);
    }
    if (stamps.length < 2) return 'oldest-first';
    return stamps[0] > stamps[stamps.length - 1] ? 'newest-first' : 'oldest-first';
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
        row.classList.remove('tpp-post');
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
        // Fill in a body saved before the post was loaded, so a bar opened
        // later still has the post's words to show.
        const body = text ? text.slice(0, 1200) : '';
        const missingBody = !pins[id].b && Boolean(body);
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
    let hiddenPinned = 0;
    for (const row of document.querySelectorAll('.tpp-post')) {
      const isArchived = Boolean(row.dataset.tppId && archive[row.dataset.tppId]);
      setTag(row, isArchived ? 'archive' : '');
      paintRow(row, row.dataset.tppNativePin === '1');
      if (isArchived) anyArchived = true;
      if (row.dataset.tppPinned === '1') hiddenPinned += 1;
    }
    pinnedHidden = hiddenPinned;
    publishArchivePresence(anyArchived);
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
    if (features && features.inboxZero && anyArchived) {
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

    // A pinned post is shown on its bar at the top, not twice in the stream.
    // Unpinning clears the mark, which is what puts it back where it belongs.
    const pinnedNow =
      Boolean(features.pinnedMessages) &&
      (Boolean(pins[row.dataset.tppId]) || Boolean(nativePinned));
    if (pinnedNow) {
      if (row.dataset.tppPinned !== '1') row.dataset.tppPinned = '1';
    } else if (row.dataset.tppPinned !== undefined) {
      delete row.dataset.tppPinned;
    }

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

    row.classList.toggle(
      'tpp-post--archived',
      Boolean(features.inboxZero) && view === VIEW_ARCHIVES && tag === 'archive'
    );
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
    archiveBtn.title = isArchived
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

  function setArchived(id, wantArchived) {
    if (!id) return;
    // The post is about to be hidden (or shown again), so the message keeps
    // hold of where it was: the news belongs on the post itself.
    const where = anchorFor(id);

    if (wantArchived) {
      archive[id] = { t: Date.now() };
      // A pinned bar for an archived post would point at nothing in the Inbox.
      if (pins[id]) {
        delete pins[id];
        savePinsSoon();
      }
    } else {
      delete archive[id];
    }

    saveArchiveSoon();
    // Answer the click at once: Teams can re-render the row before the next
    // scan, and a button that appears to do nothing is worse than a stale row.
    paintArchived(id, wantArchived);
    closePinModal();
    scan();
    toast(
      wantArchived ? 'Archived — hidden from your Inbox.' : 'Unarchived — back in your Inbox.',
      where
    );
  }

  function togglePin(id) {
    if (!id) return;
    const where = anchorFor(id);
    let message;

    if (pins[id]) {
      delete pins[id];
      message = 'Unpinned — back in its place in the channel.';
    } else {
      const record = rowsById.get(id);
      pins[id] = {
        x: (record ? subjectOf(record.row) : '') || record?.text || '',
        a: record?.author || '',
        // The words, kept so an opened bar still has them before the post is
        // loaded into the channel.
        b: record ? previewOf(record.row).slice(0, 1200) : '',
        t: Date.now()
      };
      message = 'Pinned — it now sits above the channel.';
    }

    savePinsSoon();
    closePinModal();
    scan();
    toast(message, where);
  }

  /**
   * Archive every post older than the seam the user is hovering.
   *
   * Which side of the line is older is a property of the posts, not of where
   * they sit on screen: the cut is the timestamp of the older of the two posts
   * either side of the seam, and every post at or below it is archived. That
   * holds whether the channel lists newest first or oldest first, and after the
   * user flips that setting.
   */
  function archiveOlderPosts(boundaryId, olderTs) {
    const rows = Array.from(rowsById.values());
    if (!rows.length) return;

    let targets;
    const cut = Number(olderTs) || 0;
    if (cut > 0) {
      targets = rows.filter((record) => record.ts > 0 && record.ts <= cut);
    } else {
      // No readable timestamp on either side (a Teams build without ids or
      // <time>): fall back to the order the posts are listed in.
      const index = rows.findIndex((record) => record.id === boundaryId);
      if (index < 0) return;
      const newestFirst = sortDirection() === 'newest-first';
      targets = newestFirst ? rows.slice(index) : rows.slice(0, index);
    }

    const now = Date.now();
    let added = 0;
    for (const record of targets) {
      if (archive[record.id]) continue;
      archive[record.id] = { t: now };
      delete pins[record.id];
      added += 1;
    }

    if (!added) {
      hideGap();
      toast('Everything on that side is already archived.');
      return;
    }

    saveArchiveSoon();
    savePinsSoon();
    gapZone = null;
    hideGap();
    scan();
    // Not one post's doing, so this message sits in the middle of the list.
    toast(`Archived ${added} older post${added === 1 ? '' : 's'}.`);
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
   * One pinned post: a purple bar that opens the post in a modal. The bar keeps
   * the whole area compact; the post's text, its replies and the archive/pin
   * rail are all in the modal, so opening one never pushes the page around.
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
    bar.setAttribute('aria-haspopup', 'dialog');
    bar.title = 'Open this pinned post';

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
      openPinModal((host && pinEntryOf.get(host)) || entry, bar);
    });

    item.append(bar);
    return item;
  }

  /** Brings an existing bar up to date in place, without rebuilding it. */
  function updatePinItem(item, entry) {
    pinEntryOf.set(item, entry);

    const title = item.querySelector('.tpp-pin-bar-title');
    const snippet = item.querySelector('.tpp-pin-bar-snippet');
    const nextTitle = `${entry.author ? `${entry.author}: ` : ''}${entry.text || 'Pinned post'}`;
    if (title && title.textContent !== nextTitle) title.textContent = nextTitle;
    if (snippet && snippet.textContent !== (entry.snippet || '')) {
      snippet.textContent = entry.snippet || '';
    }

    // Whether this user may unpin a moderator's post can only be known once
    // Teams has drawn its own control, which may be after the bar was built.
    if (pinModal && !pinModal.hidden && modalEntry && pinKey(modalEntry) === pinKey(entry)) {
      modalEntry = entry;
      if (!pinModal.querySelector('.tpp-modal-actions .tpp-post-actions')) {
        paintModalActions(entry);
      }
    }
  }

  /** What the modal holds: the post as Teams draws it, or the pin's saved words. */
  function pinContent(entry) {
    const row = entry.id ? findRow(entry.id) : null;
    if (row) return pinCopy(row);

    const fallback = document.createElement('div');
    fallback.className = 'tpp-pin-fallback';
    const who = document.createElement('div');
    who.className = 'tpp-pin-fallback-author';
    who.textContent = entry.author || '';
    const text = document.createElement('div');
    text.className = 'tpp-pin-fallback-body';
    text.textContent = entry.body || entry.text || '';
    fallback.append(who, text);
    return fallback;
  }

  /**
   * A stripped copy of one Teams node: our own controls and state are removed,
   * ids go with them (the same id twice in a document would make the copy and
   * the original fight over it), and the copied post loses the classes that
   * make it a stream post so it can never be scanned or filtered as one.
   */
  function copyOf(node, isPost) {
    const copy = node.cloneNode(true);
    for (const injected of copy.querySelectorAll('.tpp-post-actions, [data-tpp-ui]')) {
      injected.remove();
    }
    copy.classList.remove('tpp-post', 'tpp-post--archived', 'tpp-flash');
    if (isPost) copy.classList.add('tpp-pin-post-row');

    for (const el of [copy, ...copy.querySelectorAll('*')]) {
      el.removeAttribute('id');
      // Strip Teams' own selector anchors so the clone can never be mistaken
      // for a real post, compose box, or pinned-message marker by any of the
      // selector-based lookups in the content script or in Teams itself.
      el.removeAttribute('data-tid');
      el.removeAttribute('data-mid');
      el.removeAttribute('data-message-id');
      el.removeAttribute('data-item-id');
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('data-tpp-')) el.removeAttribute(name);
      }
    }

    return copy;
  }

  /**
   * The replies and comments that belong to a post. Teams keeps them in the
   * post's thread, so the nearest ancestor that holds this post and no other
   * one is searched for them. Only those nodes are copied: cloning the whole
   * thread container would drag Teams' own layout along with it, which made the
   * page re-render against itself.
   */
  function replyNodes(row) {
    let scope = row.parentElement;
    for (let depth = 0; scope && scope !== lastList && depth < 4; depth += 1) {
      if (scope.querySelectorAll('.tpp-post').length > 1) break;

      for (const selector of S.commentRoot || []) {
        let matches = [];
        try {
          matches = Array.from(scope.querySelectorAll(selector));
        } catch (_) {
          continue; // A bad selector from a hand edit should not stop the rest.
        }

        const found = [];
        for (const el of matches) {
          if (el === row || el.contains(row) || row.contains(el)) continue;
          if (el.closest('.tpp-pin-stack')) continue;
          if (found.some((kept) => kept.contains(el) || el.contains(kept))) continue;
          found.push(el);
        }
        if (found.length) return found;
      }

      scope = scope.parentElement;
    }
    return [];
  }

  /** The pinned post, followed by its replies, as Teams renders them. */
  function pinCopy(row) {
    const wrap = document.createElement('div');
    wrap.className = 'tpp-pin-post';
    wrap.append(copyOf(row, true));
    for (const reply of replyNodes(row)) {
      const copy = copyOf(reply, false);
      copy.classList.add('tpp-pin-reply');
      wrap.append(copy);
    }
    return wrap;
  }

  /**
   * The rail at the top of the modal: the same archive and pin buttons a post
   * has in the stream. One of your own pins can be archived (which unpins it
   * too) or unpinned; a moderator's pin gets no controls unless Teams lets this
   * user unpin there, in which case the pin takes it down for everyone.
   */
  function pinRail(entry) {
    const rail = document.createElement('div');
    rail.className = 'tpp-post-actions';
    rail.dataset.tppUi = 'actions';

    if (entry.kind === 'user') {
      rail.append(
        pinControl(
          'archive',
          ARCHIVE_SVG,
          'Archive',
          'Archive this post and take it off the pinned area',
          () => setArchived(entry.id, true)
        ),
        pinControl(
          'pin',
          PIN_FILLED_SVG,
          'Unpin',
          'Unpin this post and put it back in the channel',
          () => togglePin(entry.id)
        )
      );
    } else if (entry.canUnpin) {
      rail.append(
        pinControl(
          'pin',
          PIN_FILLED_SVG,
          'Unpin for everyone',
          'Unpin this post in Teams',
          () => unpinNative(entry.id)
        )
      );
    }

    return rail.children.length ? rail : null;
  }

  /** One round button in a pinned post's rail, like the stream's own. */
  function pinControl(kind, svg, label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tpp-post-btn tpp-${kind}-btn`;
    button.dataset.tppUi = kind;
    button.innerHTML =
      '<span class="tpp-post-btn-icon"></span><span class="tpp-post-btn-label"></span>';
    setButtonIcon(button, kind, svg);
    button.querySelector('.tpp-post-btn-label').textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.classList.toggle('is-on', kind === 'pin');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  // ------------------------------------------------------ pinned post modal

  /** The modal shell, built once and reused. */
  function ensurePinModal() {
    if (pinModal && pinModal.isConnected) return pinModal;

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'tpp-modal';
    modal.dataset.tppUi = 'pin-modal';
    modal.hidden = true;

    // The backdrop is its own layer, so a click anywhere beside the card lands
    // on it and closes the post.
    const backdrop = document.createElement('div');
    backdrop.className = 'tpp-modal-backdrop';
    backdrop.dataset.tppUi = 'pin-modal-backdrop';
    backdrop.addEventListener('click', closePinModal);

    const card = document.createElement('div');
    card.className = 'tpp-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Pinned post');

    const head = document.createElement('div');
    head.className = 'tpp-modal-head';

    const actions = document.createElement('div');
    actions.className = 'tpp-modal-actions';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tpp-modal-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close this pinned post');
    close.innerHTML = CLOSE_SVG;
    close.addEventListener('click', closePinModal);

    const body = document.createElement('div');
    body.className = 'tpp-modal-body';

    head.append(actions, close);
    card.append(head, body);
    modal.append(backdrop, card);
    document.body.append(modal);

    pinModal = modal;
    return modal;
  }

  /**
   * Dresses the modal card in the post's own colours.
   *
   * The modal lives at the end of <body>, outside the element Teams hangs its
   * theme on, so Teams' colour variables can resolve to nothing there and the
   * card used to read as white text on a white surface in dark mode. The post's
   * own text colour, and the surface it is drawn on, are read from the row and
   * copied across instead — which is what makes the modal look the same in
   * either theme.
   */
  function paintModalSurface(card, row) {
    if (!card) return;

    // A pin whose post Teams has not loaded has no row to read, so the message
    // list itself is sampled instead: it sits inside Teams' themed tree, so the
    // card still comes out dark in dark mode and light in light mode.
    const start = row || lastList || findMessageList();
    if (!start) {
      card.style.removeProperty('color');
      card.style.removeProperty('background-color');
      return;
    }

    // The post's own text colour, read from its place in Teams' tree and put on
    // the panel explicitly: this is what keeps the words readable on the panel's
    // surface, and what stops the browser handing a popover its own CanvasText.
    const color = getComputedStyle(start).color;
    if (color) card.style.setProperty('color', color, 'important');

    // The surface the post is drawn on, from the first ancestor that has one.
    let surface = '';
    for (let node = start; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!bg || bg === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(bg)) {
        continue;
      }
      surface = bg;
      break;
    }
    if (surface) card.style.setProperty('background-color', surface);
    else card.style.removeProperty('background-color');
  }

  /** The modal's archive/unpin controls for the post on show. */
  function paintModalActions(entry) {
    if (!pinModal) return;
    const slot = pinModal.querySelector('.tpp-modal-actions');
    slot.textContent = '';
    const rail = pinRail(entry);
    if (rail) slot.append(rail);
    slot.hidden = !rail;
  }

  /**
   * Shows one pinned post.
   *
   * A post Teams has loaded is shown as itself: the real post and its thread
   * are lifted into a centred panel (openLiveModal), so replying, reactions,
   * "see more" and the replies are Teams' own live controls. A pin Teams has
   * not loaded has no live post to lift, so it falls back to a copy of the
   * words kept with the pin.
   */
  function openPinModal(entry, opener) {
    if (!entry) return;
    closeLiveModal();
    hideCopyModal();

    modalEntry = entry;
    modalOpener = opener || null;

    const row = resolveRow(entry);
    if (row) {
      try {
        if (openLiveModal(entry, row)) return;
      } catch (_) {
        // A Teams build we cannot lift still gets the copy, not no modal.
        closeLiveModal();
      }
    }
    openCopyModal(entry);
  }

  /**
   * The post a pin points at. Its id is tried first; if Teams has re-rendered
   * the row since it was tagged, Teams' own id anchors and finally the pin's
   * own words are used, so a post that is on the page is always lifted rather
   * than falling back to the read-only copy.
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
   * The largest wrapper that holds this post and its thread, and no other post.
   * That is where Teams keeps the replies and the reply box, so lifting it
   * keeps every one of the post's own controls.
   */
  function threadHost(row) {
    let host = null;
    for (
      let node = row.parentElement;
      node && node !== lastList && node !== document.body;
      node = node.parentElement
    ) {
      if (node.querySelectorAll('.tpp-post').length > 1) break;
      host = node;
    }
    return host || row;
  }

  /**
   * Lifts the live post into its panel. Nothing about the post itself is
   * cloned, moved, restyled or added to: the wrapper keeps Teams' own styles
   * and its place in the tree and is only positioned over the page. Our own
   * archive/pin and close bar floats beside the panel, never inside the post,
   * which is why every control in the post keeps working in Teams' own theme.
   */
  function openLiveModal(entry, row) {
    let host = threadHost(row);
    let saved = saveStyles(host, LIFT_PROPS);
    const rowSaved = saveStyles(row, BOX_PROPS);

    // Stop our own filter hiding the row first, so Teams' own display comes
    // back rather than a forced one.
    row.dataset.tppModal = '1';
    host.dataset.tppModalHost = '1';
    document.documentElement.setAttribute(MODAL_ATTR, '');

    // Teams hides rows it is not showing, so both the row and its wrapper are
    // given a box before either is measured: a `display: none` panel has
    // nothing to show and nowhere to sit.
    forceBox(row);
    forceBox(host);

    // Registered before anything is changed, so if a later step throws, the
    // catch in openPinModal can still put the page back the way it was.
    liveModal = { host, row, chrome: null, backdrop: null, saved, rowSaved };

    // Only the surface: the post's own colours, inherited from its place in
    // Teams' tree, are left exactly as they are.
    paintModalSurface(host, row);

    const backdrop = document.createElement('div');
    backdrop.className = 'tpp-modal-backdrop';
    backdrop.dataset.tppUi = 'pin-backdrop';
    backdrop.addEventListener('click', closePinModal);
    // The page behind the panel must not scroll away under it.
    backdrop.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
    backdrop.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });

    // Our bar: the pin's archive/unpin buttons and a close button. It lives
    // next to the panel so the post itself is never touched.
    const chrome = document.createElement('div');
    chrome.className = 'tpp-live-chrome';
    chrome.dataset.tppUi = 'pin-chrome';

    const rail = pinRail(entry);
    if (rail) chrome.append(rail);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tpp-modal-close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close this pinned post');
    close.innerHTML = CLOSE_SVG;
    close.addEventListener('click', closePinModal);
    chrome.append(close);

    liftHost(host);

    // A wrapper with no box of its own (a collapsed thread, for instance) gives
    // way to the post's own row, which then becomes the panel — popover included.
    if ((!panelHasBox(host) || !rowHasBox(row, host)) && host !== row) {
      // The wrapper is not showing; the post's own row becomes the panel.
      restoreHost(host, saved);
      delete host.dataset.tppModalHost;

      host = row;
      saved = saveStyles(host, LIFT_PROPS);
      liveModal.host = host;
      liveModal.saved = saved;
      forceBox(host);
      host.dataset.tppModalHost = '1';
      paintModalSurface(host, row);
      liftHost(host);
    }

    // Nothing on screen means no panel at all, rather than an invisible one: the
    // copy the caller falls back to is better than a blank screen.
    if (!panelHasBox(host) || !rowHasBox(row, host)) {
      closeLiveModal();
      return false;
    }

    liveModal.chrome = chrome;
    liveModal.backdrop = backdrop;

    // The dim is meant to cover the whole page, so it is lifted with the panel:
    // left in Teams' tree it was clipped by the channel's own scroll container
    // and stopped at the edge of the posts. Only the top layer is above every
    // one of Teams' containers. The three are shown in this order, because a
    // top-layer element is painted above the ones shown before it: the dim, the
    // panel, then our bar.
    //
    // The panel goes up with it because it has to sit above the dim, which also
    // puts it outside the clipping and transforms that used to shift it out of
    // place. Teams' own pickers are lifted after it when they open (see
    // watchFlyouts), so they still come out on top.
    document.body.append(backdrop, chrome);
    if (showPopover(backdrop) && showPopover(host)) {
      showPopover(chrome);
    } else {
      // No Popover API: the dim and the bar sit beside the panel, which keeps
      // the panel the thing above them.
      hidePopover(backdrop);
      const parent = host.parentElement || document.body;
      parent.insertBefore(backdrop, host);
      parent.insertBefore(chrome, host);
    }

    // Placement comes after the promotion, because a top-layer element is
    // positioned against the window rather than against the ancestor that was
    // its containing block a moment earlier.
    liftHost(host);
    placeLiveChrome();
    watchPanelSize(host);
    watchFlyouts();
    window.addEventListener('resize', recentrePanel);
    hideGap();
    close.focus({ preventScroll: true });
    return true;
  }

  /** True when the browser has the Popover API (Chrome 114 and later). */
  function supportsPopover() {
    return typeof HTMLElement.prototype.showPopover === 'function';
  }

  /** Puts an element in the top layer, above everything else on the page. */
  function showPopover(el) {
    if (!el || !supportsPopover()) return false;
    try {
      if (el.matches(':popover-open')) return true;
      el.setAttribute('popover', 'manual');
      el.showPopover();
      return true;
    } catch (_) {
      // A popover attribute left on a closed element would hide it outright.
      el.removeAttribute('popover');
      return false;
    }
  }

  /** Takes an element back out of the top layer. */
  function hidePopover(el) {
    if (!el) return;
    try {
      if (el.matches(':popover-open')) el.hidePopover();
    } catch (_) {
      // Already closed, or Chrome without the Popover API.
    }
    el.removeAttribute('popover');
  }

  /**
   * Teams portals its emoji picker, reaction menu and mention list into <body>,
   * where they are ordinary page layers — and the panel is in the top layer, so
   * it covers them. No z-index can reach across that boundary, so a flyout that
   * opens while a pinned post is on show is lifted into the top layer too,
   * shown after the panel: it comes out on top, exactly where clicking the emoji
   * button in the post expects it.
   */
  function watchFlyouts() {
    if (flyoutWatch || typeof MutationObserver !== 'function') return;
    flyoutWatch = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node && node.nodeType === 1) flyoutQueue.push(node);
        }
      }
      if (flyoutFrame || !flyoutQueue.length) return;
      flyoutFrame = requestAnimationFrame(() => {
        flyoutFrame = 0;
        const batch = flyoutQueue;
        flyoutQueue = [];
        if (!liveModal) return;
        const budget = { left: 800 };
        for (const node of batch) liftFlyoutWithin(node, 0, budget);
      });
    });
    // Portals are added anywhere under <body>, and the callout Teams draws is
    // usually a child or two down, so the whole body is watched.
    flyoutWatch.observe(document.body, { childList: true, subtree: true });

    // Teams also keeps some portals in the page and only reveals them with a
    // style change, which a childList observer never sees. A click — or the
    // "@" and ":" that open a mention or emoji list — is the moment a picker
    // opens, so those are swept as well.
    document.addEventListener('pointerdown', noteFlyoutPoint, true);
    document.addEventListener('keydown', flyoutSweep, true);
    flyoutSweep();
  }

  /** Remembers the click, since a picker opens there, and sweeps for it. */
  function noteFlyoutPoint(event) {
    flyoutPoint = { x: event.clientX, y: event.clientY };
    flyoutSweep(event);
  }

  /** Sweeps the page for a flyout just after an interaction, then settles. */
  function flyoutSweep(event) {
    if (!liveModal) return;
    if (event && event.type === 'keydown' && event.key !== '@' && event.key !== ':') return;
    if (flyoutSweepTimer) window.clearTimeout(flyoutSweepTimer);
    const sweep = (delay, passes) => {
      flyoutSweepTimer = window.setTimeout(() => {
        flyoutSweepTimer = 0;
        liftFlyoutsNow();
        if (passes > 0 && liveModal) sweep(delay * 2, passes - 1);
      }, delay);
    };
    sweep(40, 3);
  }

  /** Looks for a flyout anywhere in the page; used after an interaction. */
  function liftFlyoutsNow() {
    if (!liveModal) return;
    // First the picker that opened where the click landed: this finds it by
    // what is painted there rather than by its z-index or its size, so a picker
    // Teams keeps low in the page — and one hidden behind the panel — is still
    // caught. Then a walk of <body> for the portals that are mounted elsewhere.
    const atClick = flyoutAtPoint();
    if (atClick) liftFlyout(atClick, true);
    const budget = { left: 1500 };
    for (const child of document.body.children) liftFlyoutWithin(child, 0, budget);
  }

  /**
   * The layer a flyout was drawn in at the last click. `elementsFromPoint`
   * returns everything at that point, topmost first — the panel is on top, but
   * the picker it covers is still in the list, so it can be found and lifted.
   */
  function flyoutAtPoint() {
    if (!flyoutPoint || typeof document.elementsFromPoint !== 'function') return null;
    let stack = [];
    try {
      stack = document.elementsFromPoint(flyoutPoint.x, flyoutPoint.y);
    } catch (_) {
      return null;
    }
    for (const el of stack) {
      if (!el || el.nodeType !== 1) continue;
      if (el === document.body || el === document.documentElement) continue;
      if (el.dataset.tppUi || el.id === MODAL_ID) continue;
      if (el.closest('[data-tpp-modal-host]')) continue;
      if (el.closest('[data-tpp-flyout]') || el.hasAttribute('popover')) continue;
      const layer = flyoutLayer(el);
      if (layer) return layer;
    }
    return null;
  }

  /**
   * The outermost positioned ancestor of `el` below <body>: the element Teams
   * placed the flyout with, which is the one that has to be lifted. Anything
   * that holds the post on show is refused, so a page container the click
   * happened to land on can never be lifted in the picker's place.
   */
  function flyoutLayer(el) {
    let node = el;
    while (node && node !== document.body) {
      const css = getComputedStyle(node);
      if (css.position === 'fixed' || css.position === 'absolute') break;
      node = node.parentElement;
    }
    if (!node || node === document.body) return null;

    let layer = node;
    for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) {
      const css = getComputedStyle(up);
      if (css.position !== 'fixed' && css.position !== 'absolute') break;
      layer = up;
    }
    if (layer.contains(liveModal.host)) return null;
    // A picker holds no post. Anything that does is part of the stream behind
    // the panel — another post's wrapper, say — and is never lifted.
    if (layer.querySelector('.tpp-post')) return null;
    return layer;
  }

  /**
   * Searches one subtree for a flyout and lifts the first it finds. The post on
   * show is skipped: a picker Teams renders inside it is already above the post
   * it belongs to, and its own nodes are no flyout of Teams'.
   */
  function liftFlyoutWithin(root, depth, budget) {
    if (!root || root.nodeType !== 1 || budget.left <= 0) return;
    budget.left -= 1;
    // One of ours: Teams has closed it if it is no longer open, so it goes back
    // into the page rather than staying a popover that can never be shown again.
    if (root.dataset.tppFlyout) {
      if (!root.matches(':popover-open')) unliftFlyout(root);
      return;
    }
    if (root.closest('[data-tpp-flyout]')) return;
    if (root.dataset.tppUi || root.id === MODAL_ID) return;
    if (root.hasAttribute('data-tpp-modal-host') || root.hasAttribute('data-tpp-modal')) return;
    if (liftFlyout(root)) return;
    if (depth >= FLYOUT_DEPTH) return;
    for (const child of root.children) liftFlyoutWithin(child, depth + 1, budget);
  }

  /** Lifts one Teams flyout into the top layer, if that is what this is. */
  function liftFlyout(el, forced) {
    if (!el || el.nodeType !== 1 || el.dataset.tppFlyout) return false;
    if (el.dataset.tppUi || el.id === MODAL_ID) return false;
    if (el.hasAttribute('popover') || !supportsPopover()) return false;
    if (el.closest('[data-tpp-modal-host]')) return false;
    const rect = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    if (css.position !== 'fixed' && css.position !== 'absolute') return false;
    if (!forced) {
      // Found by walking the page: a flyout is a positioned layer with a box of
      // its own that Teams has already sized. The z-index floor keeps tooltips
      // and live regions out; the box keeps zero-size wrappers out.
      if (rect.width < 80 || rect.height < 40) return false;
      const z = Number.parseInt(css.zIndex, 10);
      if (!Number.isFinite(z) || z < 1000) return false;
    } else if (rect.width < 4 || rect.height < 4) {
      return false;
    }

    // The browser's popover frame is `inset: 0; margin: auto` against the
    // window. Teams' own top/left are inline and still win, but the right and
    // bottom that frame adds would stretch the flyout, so those, the margin and
    // the animation's transform are cleared for as long as it is lifted.
    const saved = saveStyles(el, FLYOUT_PROPS);
    el.style.setProperty('position', 'fixed');
    el.style.setProperty('right', 'auto');
    el.style.setProperty('bottom', 'auto');
    el.style.setProperty('margin', '0');
    el.style.setProperty('transform', 'none');
    if (!showPopover(el)) {
      restoreHost(el, saved);
      return false;
    }
    flyoutSaved.set(el, saved);
    el.dataset.tppFlyout = '1';

    // Where it lands may not be where Teams had it — a centred flyout placed by
    // a transform, or one measured against a positioned ancestor, moves once it
    // is in the top layer. If it did, it is pinned to the box that was measured
    // before it was lifted, so it opens exactly where clicking expects it.
    const after = el.getBoundingClientRect();
    if (Math.abs(after.left - rect.left) > 1 || Math.abs(after.top - rect.top) > 1) {
      setImportant(el, 'top', `${Math.round(rect.top)}px`);
      setImportant(el, 'left', `${Math.round(rect.left)}px`);
      setImportant(el, 'right', 'auto');
      setImportant(el, 'bottom', 'auto');
      setImportant(el, 'transform', 'none');
    }
    if (Math.abs(after.width - rect.width) > 1) {
      setImportant(el, 'width', `${Math.round(rect.width)}px`);
    }
    if (Math.abs(after.height - rect.height) > 1) {
      setImportant(el, 'height', `${Math.round(rect.height)}px`);
    }
    return true;
  }

  /** Takes one flyout back out of the top layer and gives its styles back. */
  function unliftFlyout(el) {
    hidePopover(el);
    delete el.dataset.tppFlyout;
    const saved = flyoutSaved.get(el);
    if (saved) restoreHost(el, saved);
    flyoutSaved.delete(el);
  }

  /** Puts Teams' flyouts back in the page when the panel closes. */
  function endFlyouts() {
    flyoutWatch?.disconnect();
    flyoutWatch = null;
    if (flyoutFrame) cancelAnimationFrame(flyoutFrame);
    flyoutFrame = 0;
    flyoutQueue = [];
    if (flyoutSweepTimer) window.clearTimeout(flyoutSweepTimer);
    flyoutSweepTimer = 0;
    document.removeEventListener('pointerdown', noteFlyoutPoint, true);
    document.removeEventListener('keydown', flyoutSweep, true);
    flyoutPoint = null;
    for (const el of document.querySelectorAll('[data-tpp-flyout]')) unliftFlyout(el);
    flyoutSaved.clear();
  }

  /**
   * Parks our bar in the left margin, level with the top of the panel — the
   * same place a post's buttons sit in the stream. When there is no room there,
   * it goes to the right of the panel instead.
   */
  function placeLiveChrome() {
    if (!liveModal || !liveModal.chrome) return;
    const rect = liveModal.host.getBoundingClientRect();
    if (rect.width < 8) return;

    const width = 40;
    const gap = 10;
    let left = rect.left - width - gap;
    if (left < 8) left = rect.right + gap;

    // Important, so the popover frame's own inset rules cannot take these back
    // when the bar shares the panel's top layer.
    setImportant(liveModal.chrome, 'left', `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`);
    setImportant(liveModal.chrome, 'width', `${width}px`);
    setImportant(liveModal.chrome, 'top', `${Math.max(8, rect.top)}px`);
  }

  /**
   * Places the panel in the centre of the page. The geometry goes on with
   * inline `!important` styles so no Teams rule or inline style can take it
   * back, and only position and size are set: everything about how the post
   * looks — colours, type, spacing, the theme — stays Teams' own.
   *
   * The size is measured before the centre is worked out, so a post that has
   * grown since it opened ("see more", an open reply box) is centred on the
   * size it has now rather than the size it had then.
   */
  function liftHost(host) {
    const width = Math.min(760, Math.max(240, window.innerWidth - 140));
    const maxHeight = Math.min(
      Math.round(window.innerHeight * 0.86),
      window.innerHeight - 24,
      920
    );

    setImportant(host, 'position', 'fixed');
    setImportant(host, 'top', '12px');
    setImportant(host, 'left', '12px');
    setImportant(host, 'right', 'auto');
    setImportant(host, 'bottom', 'auto');
    setImportant(host, 'width', `${width}px`);
    setImportant(host, 'height', 'auto');
    setImportant(host, 'max-height', `${maxHeight}px`);
    setImportant(host, 'margin', '0');
    setImportant(host, 'overflow', 'auto');
    setImportant(host, 'box-sizing', 'border-box');
    setImportant(host, 'transform', 'none');
    setImportant(host, 'z-index', '999001');
    setImportant(host, 'min-width', '0');
    // Teams sometimes caps a row's width; the panel is sized here, not there.
    setImportant(host, 'max-width', 'none');

    // A `display: contents` wrapper has no box to position, so it gets one.
    const display = getComputedStyle(host).display;
    if (display === 'contents' || display === 'inline') setImportant(host, 'display', 'block');

    // Centre on the height the post actually takes, which max-height may cap.
    const height = Math.min(host.getBoundingClientRect().height || 0, maxHeight);
    let top = Math.max(12, Math.round((window.innerHeight - height) / 2));
    let left = Math.max(12, Math.round((window.innerWidth - width) / 2));
    setImportant(host, 'top', `${top}px`);
    setImportant(host, 'left', `${left}px`);

    // A transformed ancestor makes top/left relative to that ancestor instead
    // of the window. Nudge by the visual difference until the panel really is
    // where it should be; that correction settles after a pass or two.
    for (let pass = 0; pass < 3; pass += 1) {
      const rect = host.getBoundingClientRect();
      const dx = left - rect.left;
      const dy = top - rect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      left += Math.round(dx);
      top += Math.round(dy);
      setImportant(host, 'left', `${left}px`);
      setImportant(host, 'top', `${top}px`);
    }

    return { width, left, top };
  }

  /**
   * "See more" and the reply box make the post grow, and a taller post has a
   * different centre, so the panel is re-centred on its own size whenever that
   * size changes — and on a window resize, since it is sized in window units.
   */
  function watchPanelSize(host) {
    if (typeof ResizeObserver !== 'function') return;
    panelObserver = new ResizeObserver(() => {
      if (recentring) return;
      recentring = true;
      requestAnimationFrame(() => {
        recentring = false;
        recentrePanel();
      });
    });
    panelObserver.observe(host);
  }

  function stopPanelWatch() {
    panelObserver?.disconnect();
    panelObserver = null;
    recentring = false;
  }

  function recentrePanel() {
    if (!liveModal) return;
    liftHost(liveModal.host);
    placeLiveChrome();
  }

  /** Saves the inline values of `props` so they can be put back later. */
  function saveStyles(el, props) {
    return props.map((prop) => [
      prop,
      el.style.getPropertyValue(prop),
      el.style.getPropertyPriority(prop)
    ]);
  }

  /**
   * Teams hides rows it is not showing, and our own stylesheet hides a pinned
   * row, so the post and its wrapper are given a box before they are measured.
   */
  function forceBox(el) {
    const css = getComputedStyle(el);
    if (css.display === 'none') setImportant(el, 'display', 'block');
    if (css.visibility !== 'visible') setImportant(el, 'visibility', 'visible');
    setImportant(el, 'content-visibility', 'visible');
  }

  /** True when the panel actually has something on screen to show. */
  function panelHasBox(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 16) return false;
    if (collapse(el.innerText || el.textContent || '')) return true;
    return Boolean(el.querySelector('img, video, [role="img"]'));
  }

  /** True when the post itself is laid out inside the panel. */
  function rowHasBox(row, host) {
    if (row === host) return panelHasBox(row);
    const rect = row.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 16;
  }

  /** Puts a wrapper's own inline styles back when the panel closes. */
  function restoreHost(host, saved) {
    for (const [prop, value, priority] of saved) {
      if (value) host.style.setProperty(prop, value, priority);
      else host.style.removeProperty(prop);
    }
  }

  function setImportant(node, prop, value) {
    if (
      node.style.getPropertyValue(prop) === value &&
      node.style.getPropertyPriority(prop) === 'important'
    ) {
      return;
    }
    node.style.setProperty(prop, value, 'important');
  }

  function closeLiveModal() {
    if (!liveModal) return;
    const { host, row, chrome, backdrop, saved, rowSaved } = liveModal;
    liveModal = null;

    stopPanelWatch();
    endFlyouts();
    window.removeEventListener('resize', recentrePanel);
    hidePopover(host);
    hidePopover(chrome);
    hidePopover(backdrop);

    restoreHost(host, saved);
    if (rowSaved) restoreHost(row, rowSaved);
    chrome?.remove();
    backdrop?.remove();
    delete host.dataset.tppModalHost;
    delete row.dataset.tppModal;
    document.documentElement.removeAttribute(MODAL_ATTR);
  }

  /** The copy shown for a pin whose post Teams has not loaded. */
  function openCopyModal(entry) {
    const modal = ensurePinModal();
    paintModalSurface(modal.querySelector('.tpp-modal-card'), null);

    const body = modal.querySelector('.tpp-modal-body');
    body.textContent = '';
    body.append(pinContent(entry));
    body.scrollTop = 0;

    paintModalActions(entry);
    document.documentElement.setAttribute(MODAL_ATTR, '');
    hideGap();
    modal.hidden = false;
    modal.querySelector('.tpp-modal-close').focus({ preventScroll: true });
  }

  function hideCopyModal() {
    if (!pinModal || pinModal.hidden) return;
    pinModal.hidden = true;
    pinModal.querySelector('.tpp-modal-body').textContent = '';
  }

  function closePinModal() {
    const opener = modalOpener;
    const wasOpen = Boolean(liveModal) || Boolean(pinModal && !pinModal.hidden);
    modalOpener = null;
    modalEntry = null;

    closeLiveModal();
    hideCopyModal();
    document.documentElement.removeAttribute(MODAL_ATTR);

    if (!wasOpen || !opener || !opener.isConnected || opener.offsetParent === null) return;
    try {
      opener.focus({ preventScroll: true });
    } catch (_) {
      // Focus is a nicety; the post is closed either way.
    }
  }

  /** True while a pinned post is open, live or as a copy. */
  function modalOpen() {
    return Boolean(liveModal) || Boolean(pinModal && !pinModal.hidden);
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

    // A post Teams has taken out of the page has nothing left to show.
    if (liveModal && !liveModal.row.isConnected) closePinModal();

    // A post whose pin went away — unpinned, archived, or another view — has
    // nothing left to show, so its modal closes with it.
    if (pinModal && !pinModal.hidden) {
      const key = modalEntry ? pinKey(modalEntry) : '';
      if (!entries.some((entry) => pinKey(entry) === key)) closePinModal();
    }

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
      closePinModal();
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

  /** Recompute the seams between two visible posts, top to bottom. */
  function refreshGapZones() {
    const zones = [];
    if (features && features.inboxZero && view === VIEW_INBOX) {
      let previous = null;
      for (const record of rowsById.values()) {
        const rect = record.row.getBoundingClientRect();
        // Archived (and therefore hidden), or the post opened in its panel.
        if (!rect.height || record.row.dataset.tppModal === '1') continue;
        if (previous) {
          const y = (previous.rect.bottom + rect.top) / 2;
          zones.push({
            y,
            boundaryId: record.id,
            // Everything older than this seam is everything older than the
            // older of the two posts either side of it — the posts' own
            // timestamps decide, so the direction they are listed in does not.
            olderTs: Math.min(previous.record.ts || 0, record.ts || 0)
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
      archiveOlderPosts(el.dataset.boundary || '', Number(el.dataset.olderTs) || 0);
    });

    el.append(line, button);
    document.body.append(el);
    gapZone = el;
    return el;
  }

  function showGap(zone) {
    if (!listRect) return;
    const el = ensureGapEl();
    el.dataset.boundary = zone.boundaryId;
    el.dataset.olderTs = String(zone.olderTs || 0);
    el.style.top = `${zone.y}px`;
    el.style.left = `${listRect.left + 8}px`;
    el.style.width = `${Math.max(listRect.width - 16, 200)}px`;
    el.classList.add('is-on');
  }

  function hideGap() {
    document.getElementById(GAP_ID)?.classList.remove('is-on');
  }

  function updateGapHover(event) {
    // A pinned post is over the page: nothing behind it answers the pointer.
    if (
      !ready ||
      !features ||
      !features.inboxZero ||
      view !== VIEW_INBOX ||
      !listRect ||
      modalOpen()
    ) {
      hideGap();
      return;
    }

    // Keep the control while the pointer travels onto its button.
    if (gapZone && gapZone.contains(event.target)) return;

    const x = event.clientX;
    const y = event.clientY;
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
    if (!ready || frame) return;
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

      if (liveModal && liveModal.chrome) {
        if (!liveModal.host.isConnected) closePinModal();
        else {
          liftHost(liveModal.host);
          placeLiveChrome();
        }
      }

      refreshGapZones();
      hideGap();
    });
  }

  // -------------------------------------------------------------- persistence

  function saveArchiveSoon() {
    clearTimeout(archiveSaveTimer);
    archiveSaveTimer = setTimeout(() => {
      archiveSaveTimer = 0;
      persist(ARCHIVE_KEY, archive, ARCHIVE_LIMIT);
    }, 200);
  }

  function savePinsSoon() {
    clearTimeout(pinsSaveTimer);
    pinsSaveTimer = setTimeout(() => {
      pinsSaveTimer = 0;
      persist(PINS_KEY, pins, PIN_LIMIT);
    }, 200);
  }

  async function persist(key, map, limit) {
    let trimmed = Object.fromEntries(Object.entries(map).slice(-limit));
    if (key === ARCHIVE_KEY) archive = trimmed;
    else pins = trimmed;

    if (await writeSync({ [key]: trimmed })) return;

    // Per-item quota: keep only the newest quarter and try once more rather
    // than silently losing the change.
    trimmed = Object.fromEntries(
      Object.entries(trimmed).slice(-Math.max(10, Math.floor(limit / 4)))
    );
    if (key === ARCHIVE_KEY) archive = trimmed;
    else pins = trimmed;
    await writeSync({ [key]: trimmed });
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
      if (el.closest('.tpp-post, .tpp-modal')) continue;

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

    const list = findMessageList();

    // Our own overlays and buttons must not re-trigger the observer.
    if (observer) observer.disconnect();
    try {
      if (!list) {
        for (const id of [STACK_ID, EMPTY_ID, GAP_ID]) {
          document.getElementById(id)?.remove();
        }
        closePinModal();
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
      if ((features.inboxZero && view === VIEW_ARCHIVES) || pinnedHidden > 0) {
        holdListDepth(list);
      } else {
        releaseListDepth();
      }

      refreshGapZones();
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

    for (const feature of FEATURES) {
      if (features[feature.id]) html.setAttribute(feature.attr, '');
      else html.removeAttribute(feature.attr);
    }

    // The tag alone decides which view shows a post (teams.css), so the view is
    // published once here and a Teams re-render cannot resurrect a hidden post.
    if (features.inboxZero) html.setAttribute('data-tpp-view', view);
    else html.removeAttribute('data-tpp-view');

    if (!features.inboxZero) {
      html.removeAttribute(HAS_ARCHIVES_ATTR);
      for (const el of document.querySelectorAll('.tpp-list')) el.classList.remove('tpp-list');
      releaseListDepth();
      for (const el of document.querySelectorAll('.tpp-post--archived')) {
        el.classList.remove('tpp-post--archived');
      }
      // Forget the cached paint so every post's buttons are rebuilt.
      for (const el of document.querySelectorAll('.tpp-post')) {
        delete el.dataset.tppPainted;
      }
    }

    if (!features.pinnedMessages) {
      closePinModal();
      document.getElementById(STACK_ID)?.remove();
      for (const el of document.querySelectorAll('.tpp-post[data-tpp-pinned]')) {
        delete el.dataset.tppPinned;
      }
      pinnedHidden = 0;
    }

    if (!features.inboxZero && !features.pinnedMessages) clearLeftInset();

    scan();
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
    pins = normalizeMap(items[PINS_KEY], PIN_LIMIT);
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

    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Restore the feature flags if Teams rewrites <html>.
    new MutationObserver(() => {
      if (!ready) return;
      const html = document.documentElement;
      const missing = FEATURES.some(
        (feature) => features[feature.id] && !html.hasAttribute(feature.attr)
      );
      if (missing) apply();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: FEATURES.map((feature) => feature.attr)
    });

    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition);

    // The gap control follows the pointer, so only a mousemove can reveal it.
    document.addEventListener('mousemove', onPointerMove, { passive: true });
    document.addEventListener('mouseleave', hideGap);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closePinModal();
    });

    bootstrap();
  }

  // Keep an open tab in sync when settings, archives or pins change elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !ready) return;
    if (changes[STORAGE_KEY]) features = normalize(changes[STORAGE_KEY].newValue);
    if (changes[ARCHIVE_KEY]) archive = normalizeMap(changes[ARCHIVE_KEY].newValue, ARCHIVE_LIMIT);
    if (changes[PINS_KEY]) pins = normalizeMap(changes[PINS_KEY].newValue, PIN_LIMIT);
    if (changes[VIEW_KEY]) view = normalizeView(changes[VIEW_KEY].newValue);
    if (features) apply();
  });

  // At document_start the parser may not have created <html> yet.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
