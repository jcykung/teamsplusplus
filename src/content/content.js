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
 *                   button files it.
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
    NEW_POSTS_KEY,
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
   * How many compact-view marks are kept before the oldest are dropped.
   *
   * The map has to fit in the 8 KB chrome.storage.sync allows in one item, and
   * at 300 it did not: the write failed and the retry cut it to a quarter, so
   * read marks vanished and those posts came back as unread a scan later. This
   * is the count; how much of it fits also depends on the marks themselves, so
   * persistNew cuts by size too (see fitNewState).
   */
  const NEW_POST_LIMIT = 100;

  /**
   * What is left for the marks in that 8 KB item, in characters of JSON.
   *
   * The room is spent here rather than guessed at: the map is cut to what fits,
   * not to a count that happens to fit today.
   */
  const SYNC_ITEM_BUDGET = 7000;

  /**
   * How long after a card is opened its post cannot be re-marked, in ms.
   *
   * The reply and reaction counts are read out of a row Teams is still drawing,
   * and a number that appears a moment after the open is not a reply since the
   * read. A post that really has moved on is caught by the scan after this.
   */
  const OPEN_SETTLE_MS = 4000;
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
  /**
   * The per-channel baseline an earlier build kept for Teams' unread cascade,
   * in local storage. The view follows Teams' badge now, so nothing reads it;
   * it is removed at bootstrap rather than left spending the quota.
   */
  const LEGACY_CASCADE_KEY = 'teamsPlusPlus.cascadeBase';
  /**
   * Channels whose unread dot is latched, in local storage: name -> 1.
   *
   * Teams clears its bold the moment a channel is opened, so by the time the
   * posts are on screen the name no longer says whether anything in it was
   * read. The first cue is written down here instead, and the dot stands until
   * the posts it stands for have been opened (settleRailUnread). It is read
   * from what Teams drew on this device rather than a decision the user made,
   * so it stays local, like the activity fingerprints.
   */
  const RAIL_UNREAD_KEY = 'teamsPlusPlus.railUnread';
  const RAIL_UNREAD_LIMIT = 200;
  /**
   * How long a click on an open post is held before it folds it, in ms.
   *
   * Highlighting text in an open post ends in a click on the post — the same
   * event a click to fold it sends — and a double-click's first click arrives
   * before the second that would select the word. Holding the fold for a moment
   * is what tells the two apart: a highlight or a second press cancels it, and
   * a plain click folds a beat later. Unfolding is not held: that is the click
   * the view exists for.
   */
  const FOLD_AFTER_CLICK_MS = 220;

  const VIEW_INBOX = 'inbox';
  const VIEW_ARCHIVES = 'archives';

  const TABS_ID = 'tpp-tabs';
  /** The date line held at the edge being read from (updateDayPin). */
  const DAY_PIN_ID = 'tpp-day-pin';
  /** Its height, which is also the room the list gives it at the edge. */
  const DAY_PIN_HEIGHT = 20;
  const CONFETTI_ID = 'tpp-confetti';
  const EMPTY_ID = 'tpp-empty-state';
  const TOAST_ID = 'tpp-toast';
  /** Teams' "press Ctrl+F" nudge: the surfaces it can be drawn in, and its mark. */
  const NAG_SURFACES = [
    '[role="dialog"]',
    '[role="alert"]',
    '[role="tooltip"]',
    '[class*="TeachingPopover"]',
    '[class*="teaching-popover"]',
    '[class*="Coachmark"]',
    '[class*="coachmark"]',
    '[class*="Callout"]',
    '[data-tid*="teaching" i]',
    '[data-tid*="coachmark" i]'
  ].join(',');
  const NAG_ATTR = 'data-tpp-nag';
  const NAG_SHORTCUT = /(?:ctrl|cmd|⌘|command)\s*\+?\s*f\b/i;
  const NAG_WORD = /\b(?:find|search)\b/i;
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
  const BUILD = '2026-11-11.4';
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
  /** The channel title last seen, so only a real switch folds the posts. */
  let lastChannelTitle = null;
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
  /**
   * id -> { a, t } for a post the user has opened: `a` is the activity token the
   * post showed at that moment and `t` when it happened. `n: 1` is the only
   * other kind: a post held unread until its card is opened, with `a` the
   * activity token it showed then, and `read` the token it was read at when a
   * reply or a reaction is what brought the mark back.
   *
   * A read record is not undone by a badge: Teams leaves one on the post after
   * an open, draws one again as the row re-renders, and puts one back when the
   * user picks "Mark as unread" — none of that is a change to the compact view.
   * Only the post's own activity reopening it counts, and the map is synced so
   * opening a card on one browser clears the same post on the others.
   */
  let newState = {};
  let newSaveTimer = 0;
  /** id -> the activity fingerprint taken when the post was last read. */
  let activityState = {};
  let activitySaveTimer = 0;
  /** name -> 1 while that channel's dot is latched: see paintChannelRail. */
  let railUnread = {};
  let railSaveTimer = 0;
  /** Whether Teams was cueing each channel's row in the latest rail pass. */
  let railCued = new Map();
  /**
   * Channels whose dot the posts have already answered while Teams kept
   * drawing its cue: see paintChannelRail. A cue read again there must not
   * latch a dot the user just cleared, or the dot comes straight back.
   */
  const railSettled = new Set();
  /** name -> when a weight first looked like a cue: see paintChannelRail. */
  let railPending = new Map();
  /** A pending second look at a channel's dot: see scheduleRailSettle. */
  let railSettleTimer = 0;
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
  /**
   * id -> the newest activity that post has shown, in ms (see activityStampOf).
   *
   * A post is filed under the day of its newest activity, and that is read from
   * whatever Teams has rendered in the row — a post answered today carries its
   * reply's stamp. Teams re-renders a row as it is scrolled into view, and a
   * re-render can leave the reply out for a moment: the post then falls back to
   * the day it was written, which moves it, and every date line below it, while
   * the reader is in the post. A post does not get older, so the newest stamp
   * seen for an id is kept until a newer one arrives.
   */
  const activityNewest = new Map();
  /** The names of the channel those rows were read from: see settleRailUnread. */
  let rowsKeys = [];

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
  /** The post opened most recently: Teams' own menu belongs to it. */
  let lastOpenedRow = null;
  /** The fold a click on an open post asked for, and its timer: see onPostClick. */
  let foldRow = null;
  let foldTimer = 0;
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
  /** The last post box the pinned line was drawn against (see updateDayPin). */
  let pinBox = null;
  /** The pane-header strip the line is drawn in, and the list it was found for. */
  let pinHost = null;
  let pinHostPort = null;
  let pinHostTriedAt = 0;
  let pinHostTriedPort = null;
  /** The colour painted behind the list, sampled for the line to stand on. */
  let pinPaint = '';
  let pinPaintAt = 0;
  /**
   * Set when the list's order was read the other way round: every day's line
   * says the other side of its gap until they are drawn again, so the next
   * frame repaints them (see postsNewestFirst and reposition).
   */
  let dayLinesStale = false;
  /**
   * Watches every post's box, so a day's line follows a post that changes
   * height: a reply box opening inside a row holds the scan off, and an image
   * or a thread arriving lands after the rows were read. The watched rows are
   * kept here because Teams recycles them, and a row that has left the list is
   * watched no longer.
   */
  let sizeObserver = null;
  let sizeWatched = new Set();
  /** Whether a channel's UI has been drawn, so another view tears it down once. */
  let uiDrawn = false;
  /** When the scroll limit was last re-measured from the scroll handler. */
  let clampedAt = 0;
  let toastTimer = 0;
  /** When the "press Ctrl+F" nudge was last looked for. */
  let nagCheckedAt = 0;
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
    // Teams' own menu is drawn outside the row, so the post the user is working
    // on is the one their last click landed in — not always the one last opened.
    const rowOfClick = target.closest('.tpp-post');
    if (rowOfClick) lastOpenedRow = rowOfClick;
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
    // The second click of a double- or triple-click is a word or a paragraph
    // being selected, not the post being folded.
    if (event.detail > 1) return;
    // Closing an open post is held for a beat: dragging over its text leaves a
    // highlight and then sends a click, and that click is the user copying, not
    // folding. See holdFold.
    if (unfolded.has(row.dataset.tppId)) {
      holdFold(row);
      return;
    }
    toggleUnfold(row);
  }

  /**
   * Folds an open post unless the click turns out to have been a highlight.
   *
   * The fold waits FOLD_AFTER_CLICK_MS; anything that says the user was working
   * in the post's text rather than on the card — a selection inside it, a
   * pointer press, a drag — drops it, and a plain click folds as if nothing had
   * been held.
   */
  function holdFold(row) {
    cancelHoldFold();
    foldRow = row;
    foldTimer = window.setTimeout(() => {
      const held = foldRow;
      foldTimer = 0;
      foldRow = null;
      if (!held || !held.isConnected) return;
      if (!unfolded.has(held.dataset.tppId)) return;
      if (hasSelectionIn(held)) return;
      toggleUnfold(held);
    }, FOLD_AFTER_CLICK_MS);
  }

  /** Drops a fold the click asked for, keeping the post open. */
  function cancelHoldFold() {
    if (foldTimer) window.clearTimeout(foldTimer);
    foldTimer = 0;
    foldRow = null;
  }

  /** Whether some of the post's text is highlighted right now. */
  function hasSelectionIn(row) {
    if (!row) return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    return !!(anchor && row.contains(anchor)) || !!(focus && row.contains(focus));
  }

  /** Drops a fold the user is working through: see holdFold. */
  function onAnyPointerDown(event) {
    // A press in the post whose fold is held means the user is working in it —
    // the second half of a double-click, or a drag over its text — so the fold
    // goes. A press anywhere else is them moving on: the fold still stands.
    if (!foldTimer || !foldRow) return;
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (target === foldRow || foldRow.contains(target)) cancelHoldFold();
  }

  /**
   * Folds one post, or unfolds it again if it is already open.
   *
   * One post is open at a time: opening another one closes the post being read,
   * so moving to the next post in a channel never leaves a trail of open ones
   * behind it.
   */
  function toggleUnfold(row) {
    const id = row && row.dataset.tppId;
    if (!id) return;
    const open = !unfolded.has(id);
    if (open) {
      closeOtherPosts(row);
      unfolded.add(id);
    } else unfolded.delete(id);
    row.classList.toggle('tpp-unfold', open);
    // Opening the card is what marks a post read in this view. Closing it again
    // is not: a post closed without being read stays unread.
    if (open) {
      lastOpenedRow = row;
      markPostOpened(row);
    }
    // An opened post takes the keyboard the way a message does when Teams is
    // clicked on it: the card that opened it is not a message, so focus is put
    // on the post itself.
    if (open) focusPostMessage(row);
    // The post changed height, so anything placed against it is re-measured.
    reposition();
    // Whichever way the post just changed, it belongs at the top of the list:
    // opened, reading starts at its first line; folded, the condensed card
    // comes back there rather than to wherever the pointer left it.
    holdRowAtTop(row, open);
  }

  /**
   * Keeps a post at the top of the list after it has been opened or folded.
   *
   * The scroll waits for the frame after the click: the row has just grown or
   * shrunk, and the post opened or closed before it has moved too. The click is
   * handed on to Teams, which brings the message into view in its own time —
   * after that frame, sometimes — so the row is asked for its place a second
   * time; one that has not moved since is left alone.
   *
   * `open` is the state the post is meant to be in when the scroll is made: a
   * post opened and folded again in the same beat is left where the reader put
   * it.
   */
  function holdRowAtTop(row, open) {
    const id = row && row.dataset.tppId;
    if (!id) return;
    const wanted = () => row.isConnected && unfolded.has(id) === open;
    requestAnimationFrame(() => {
      if (!wanted()) return;
      const at = scrollRowToTop(row);
      if (at === null) return;
      window.setTimeout(() => {
        if (!wanted()) return;
        if (Math.abs(row.getBoundingClientRect().top - at) > 1) scrollRowToTop(row);
      }, 150);
    });
  }

  /**
   * Brings a post's row to the top of the list — open or folded alike — so
   * reading starts at its first line, or the condensed card sits at the top,
   * instead of wherever it happened to be.
   *
   * Every box above the row that can scroll takes its turn, innermost first, and
   * each is measured after the one inside it has moved — moving an outer box
   * shifts the row and the inner box together, so the inner alignment survives.
   * A box on `overflow: hidden` that Teams scrolls from script counts: it scrolls
   * all the same when it is told to, and scrollBoxFor (which asks for an
   * auto-overflow box, because the clamp must not pick a clipped one) would walk
   * straight past it.
   *
   * The row's top is returned so the caller can tell a post that Teams has moved
   * since. A post so near the end of a channel that a box cannot lift it that far
   * ends up as high as that box allows: there is nothing below it to scroll into.
   */
  function scrollRowToTop(row) {
    if (!row || !row.isConnected) return null;
    for (let box = row.parentElement; box && box !== document.body; box = box.parentElement) {
      if (box.scrollHeight <= box.clientHeight + 1) continue;
      const overflow = getComputedStyle(box).overflowY;
      if (overflow === 'visible' || overflow === 'clip') continue;
      // The pinned line holds the top of the box when the newest post is first:
      // the post is opened below it, not under it. A line drawn in the header
      // takes no room from the list, so the post goes right to the top.
      const pin = document.getElementById(DAY_PIN_ID);
      const held =
        pin && !pin.hidden && !pin.dataset.tppHosted && pin.dataset.tppEdge === 'top'
          ? DAY_PIN_HEIGHT
          : 0;
      const delta = Math.round(
        row.getBoundingClientRect().top - box.getBoundingClientRect().top - held
      );
      if (delta) box.scrollTop = Math.max(0, box.scrollTop + delta);
    }
    return row.getBoundingClientRect().top;
  }

  /**
   * Closes every open post but this one.
   *
   * Nothing is written here: a post that was opened has already been marked
   * read, and closing it again is not a change of mind. Ids go as well as
   * classes — a row Teams has re-rendered is folded from the set — so a post
   * that is off screen cannot come back open later.
   */
  function closeOtherPosts(keep) {
    const keepId = keep && keep.dataset.tppId;
    cancelHoldFold();
    for (const id of Array.from(unfolded)) {
      if (id !== keepId) unfolded.delete(id);
    }
    for (const row of document.querySelectorAll('.tpp-post.tpp-unfold')) {
      if (row === keep) continue;
      row.classList.remove('tpp-unfold');
    }
  }

  /**
   * Folds every open post and forgets them.
   *
   * Coming back to a channel should show it the way it was before anything was
   * opened: a list of cards. The ids matter more than the classes — a row Teams
   * re-renders is folded from the set — so they are dropped first.
   */
  function foldOpenPosts() {
    cancelHoldFold();
    unfolded.clear();
    lastOpenedRow = null;
    for (const row of document.querySelectorAll('.tpp-post.tpp-unfold')) {
      row.classList.remove('tpp-unfold');
    }
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
    // The condensed card goes back to the top of the list, where the post was
    // opened, rather than staying at the line the keyboard had reached.
    holdRowAtTop(row, false);
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

    // Teams' own read markers live in the part of the row the card hides, so
    // the card carries them. With Inbox Zero on, the Inbox and Archive tabs are
    // the marker instead, and these would contradict them.
    const unread = !features.inboxZero && row.dataset.tppNew === '1';
    // Two different things wear the same purple edge: a post Teams has just
    // badged has not been opened yet and says Unread, while one that was opened
    // and then answered or reacted to says Updated, with what it gained in the
    // mark's tooltip. A badge put back by Teams' own "Mark as unread" has no
    // activity behind it, so it never gets this far (see refreshNewPost).
    // A mark that was reopened by activity is always an Updated one, even in
    // the moment its tooltip cannot be worked out: showing it as Unread would
    // claim a post is new when the user has already read it.
    const updated = unread && isUpdatedPost(row);
    const why = updated ? updatedWhy(row) : '';
    const tip = updated ? why || 'New activity since you read it' : '';
    const badgeText = unread ? (updated ? 'Updated' : 'Unread') : '';

    // A card already drawn is left alone unless the post's author, time, words
    // or read markers changed. Everything below reads and rewrites the card,
    // and this runs for every post on every scan: comparing a short fingerprint
    // first is what keeps a Teams re-render from costing a full repaint of the
    // list.
    const signature = [
      row.dataset.tppId,
      author,
      time,
      raw.length,
      raw.slice(0, 24),
      updated ? `updated|${why}` : unread ? 'unread' : ''
    ].join('|');
    // An unread post reads as unread on the card itself: a bright purple edge
    // rather than the usual hairline. Written before the "nothing changed"
    // return so a card painted by an older build is corrected on the next paint
    // too.
    if (card) {
      card.classList.toggle('tpp-preview-unread', unread);
      card.classList.toggle('tpp-preview-updated', updated);
      // Painted before the fingerprint check: Teams clearing its own badge
      // leaves the card unread but changes nothing else in it, and the word has
      // to stay on it at that moment too.
      paintCardBadge(card, badgeText, tip);
    }
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
        '<span class="tpp-preview-badge" hidden>Unread</span>' +
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

    card.classList.toggle('tpp-preview-unread', unread);
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
    paintCardBadge(card, badgeText, tip);
    row.classList.add('tpp-previewed');
  }

  /**
   * Writes the word on the card's read mark. An empty word hides the mark; the
   * purple border is the card class's business, not this one's. `title` is the
   * tooltip: what an Updated post has gained since it was read.
   */
  function paintCardBadge(card, text, title) {
    const badge = card && card.querySelector('.tpp-preview-badge');
    if (!badge) return;
    badge.hidden = !text;
    if (text && badge.textContent !== text) badge.textContent = text;
    const tip = text ? title || '' : '';
    if ((badge.title || '') !== tip) badge.title = tip;
  }

  /** Whether Teams marks this post as unread. */
  function isUnreadPost(row) {
    return Boolean(first(S.newBadge, row));
  }

  /**
   * What a post has gained since it was read, as a sentence, or ''.
   *
   * Only a mark that was brought back by activity has a read token to compare
   * with, and only numbers that went up count: a row Teams is still drawing
   * reads lower, and nothing is news until it is there.
   */
  function updatedWhy(row) {
    const id = row && row.dataset.tppId;
    const record = id ? newState[id] : null;
    if (!record || record.n !== 1 || typeof record.read !== 'string') return '';
    const now = tokenParts(activityTokenOf(row));
    const was = tokenParts(record.read);
    const gained = (a, b) => (a >= 0 && b >= 0 && a > b ? a - b : 0);
    const replies = gained(now.replies, was.replies);
    const reactions = gained(now.reactions, was.reactions);
    const parts = [];
    if (replies) parts.push(`${replies} new ${replies === 1 ? 'reply' : 'replies'}`);
    if (reactions) parts.push(`${reactions} new ${reactions === 1 ? 'reaction' : 'reactions'}`);
    return parts.length ? `${parts.join(' and ')} since you read it` : '';
  }

  /**
   * Whether this post's mark was brought back by activity — its card says
   * Updated rather than Unread. Only the record decides: a mark written at an
   * open is a read, and one written on a first sighting of the badge is not.
   */
  function isUpdatedPost(row) {
    const id = row && row.dataset.tppId;
    const record = id ? newState[id] : null;
    return Boolean(record && record.n === 1 && typeof record.read === 'string');
  }

  /**
   * Whether this post is unread in the compact view.
   *
   * Teams' New badge is the signal, and the first sighting of it is written down
   * as an unread mark, because Teams clears the badge as soon as the channel is
   * opened. The mark stands until the card is opened, which is the only thing
   * this view counts as reading.
   *
   * A read post goes back to unread for one reason only: it has moved on. A
   * badge on it is news when its replies or reactions have gone up since the
   * token written at the read, and then the mark comes back as Updated, naming
   * what it gained. A badge with no such movement behind it — the one Teams
   * leaves after an open, the one it draws again on a re-render, and the one its
   * own "Mark as unread" puts back on the post and on the newer ones — is
   * ignored, and the post stays read.
   */
  function refreshNewPost(id, row) {
    if (!id || !features || !features.compactPosts || features.inboxZero) return false;
    const record = newState[id];
    // A mark already written stands until the card is opened — Teams clearing
    // its own badge is Teams tidying up, not the user reading.
    if (record && record.n === 1) return true;
    if (!isUnreadPost(row)) return false;

    if (!record) {
      // The badge the user has not opened their way past: the mark goes in at
      // once, so Teams clearing its badge before the card is opened does not
      // clear it. The moment is kept as well, so two browsers' marks for the
      // same post can be told apart when they are folded together.
      setNewRecord(id, { n: 1, t: Date.now(), a: activityTokenOf(row) });
      return true;
    }

    // Read already. Only the post moving on brings the mark back, and never in
    // the moment after the open: the counts are read out of a row Teams is
    // still drawing (see OPEN_SETTLE_MS).
    if (typeof record.a !== 'string') return false;
    const age = Date.now() - Number(record.t);
    if (age >= 0 && age < OPEN_SETTLE_MS) return false;
    const token = activityTokenOf(row);
    if (!movedPast(token, record.a)) {
      // A count the row did not show when the card was opened is not news, but
      // it is worth writing down now it is readable, so the next real reply can
      // be counted rather than lost the same way.
      const filled = fillGaps(record.a, token);
      if (filled !== record.a) setNewRecord(id, { a: filled, t: record.t });
      return false;
    }

    setNewRecord(id, { n: 1, t: Date.now(), a: token, read: record.a });
    return true;
  }

  /**
   * Whether a post has moved past what its read record describes.
   *
   * Only the two counts that can be named are compared — replies and reactions —
   * and only when the record could read them at the time (`-1` means the row was
   * not showing a count). A number that appears where there was none is not
   * news: it is the same post, drawn properly at last. The row's stamp is not
   * compared at all: Teams re-draws its time label, and a longer "last replied"
   * wording is a re-render, not a reply.
   */
  function movedPast(current, held) {
    const now = tokenParts(current);
    const was = tokenParts(held);
    const grew = (a, b) => b >= 0 && a >= 0 && a > b;
    return grew(now.replies, was.replies) || grew(now.reactions, was.reactions);
  }

  /**
   * The `held` token with any count it could not read filled in from `current`.
   *
   * A read taken while Teams was still drawing the row can miss the reply count,
   * so the gap is filled in on the next scan; a token nothing was missing from
   * comes back as it went in, and the stamp is kept unless the new reading has
   * one. Nothing is counted as activity here — this only makes the next reply
   * countable. See movedPast for why a number that was previously unreadable is
   * not news.
   */
  function fillGaps(held, current) {
    const was = tokenParts(held);
    const now = tokenParts(current);
    const replies = was.replies < 0 && now.replies >= 0 ? now.replies : was.replies;
    const reactions = was.reactions < 0 && now.reactions >= 0 ? now.reactions : was.reactions;
    if (replies === was.replies && reactions === was.reactions) return held;
    return [now.stamp || was.stamp, replies, reactions].join('|');
  }

  /** The three numbers in an activity token: stamp, replies, reactions. */
  function tokenParts(token) {
    const parts = String(token || '').split('|');
    return {
      stamp: Number(parts[0]) || 0,
      replies: Number(parts[1]) || 0,
      reactions: Number(parts[2]) || 0
    };
  }

  /**
   * Marks a post read because its card was opened — the only thing in the
   * compact view that does. The badge and purple border go at once, and the
   * activity token taken here is what stops the New badge Teams still shows (or
   * draws again on the next re-render) from bringing them back. The mark is
   * written to sync storage straight away, so the other browser clears the same
   * post without waiting for a scan to come round.
   */
  function markPostOpened(row) {
    const id = row && row.dataset.tppId;
    if (!id || !features || !features.compactPosts || features.inboxZero) return;
    setNewRecord(id, { a: activityTokenOf(row), t: Date.now() });
    delete row.dataset.tppNew;

    const card = row.querySelector(':scope > [data-tpp-ui="preview"]');
    if (card) {
      card.classList.remove('tpp-preview-unread', 'tpp-preview-updated');
      paintCardBadge(card, '');
    }
    flushNew();
  }

  /** Writes one compact-view mark, newest last so trimming keeps recent ones. */
  function setNewRecord(id, value) {
    delete newState[id];
    newState[id] = value;
    saveNewSoon();
  }

  /** Channel rows already resolved to their name element, so the DOM is walked once. */
  const railNameCache = new WeakMap();
  /** When the rail was last read (see paintChannelRail). */
  let channelRailAt = 0;

  /**
   * Marks the channels Teams gives unread activity.
   *
   * Teams bolds a channel's name in the left rail when it has news, and there is
   * no attribute to hang a CSS rule on: the weight is computed. So the bold name
   * is found here and marked, and teams.css draws a dot in its line. That bold
   * is only the arrival signal — Teams clears it as soon as the channel is
   * opened — so the cue is latched here and the dot goes only once the posts
   * have been opened (settleRailUnread). Runs at most once a second: the rail
   * only changes when Teams says a channel has news or the user reads one.
   */
  function paintChannelRail() {
    if (!features || !features.compactPosts) return;
    const now = Date.now();
    if (now - channelRailAt < 1000) return;
    channelRailAt = now;
    // The channel dot is not in this release: its switch is pinned off in
    // features.js, so the rail is not read and all this pass does is take down
    // what a build that had it left behind. Without that, a name still
    // carrying the old bold and its dot would keep both until Teams happened
    // to re-render that row. Once a second is enough for something nothing on
    // the page adds to any more.
    if (!features.railDot) {
      stripRailMarks();
      return;
    }

    const selector = (S.channelItem || []).join(',');
    if (!selector) return;

    const names = new Set();
    let latched = false;
    railCued = new Map();
    const pending = new Map();
    const rows = [];
    for (const item of document.querySelectorAll(selector)) {
      // Teams nests its channel rows inside group rows (Favourites, and the
      // sections below it) that carry the same role. The inner row is the
      // channel and the outer one only holds them, so a row that contains
      // another candidate is the group and is skipped.
      if (item.querySelector(selector)) continue;
      const name = railNameOf(item);
      if (!name) continue;
      names.add(name);
      rows.push({
        name,
        // A marked name carries our own 600 weight, so it cannot be asked what
        // Teams draws — it would always answer bold, and the dot would never
        // come down. Teams' badge and aria-label cues are its own alone.
        marked: name.dataset.tppUnreadName === '1',
        // The open channel's row is drawn semibold for being selected, which is
        // not news. Read as a cue, it latched a dot on every channel the user
        // merely visited — and because that row stays bold while it is on
        // screen, settleRailUnread could never take the dot down again.
        current: isCurrentRailRow(item),
        badge: hasUnreadMark(item),
        // Teams bolds the label, a wrapper around it, or the row itself across
        // builds, and a build may mark unread with a badge instead of weight.
        bold: isBoldUp(name, item),
        key: collapse(name.textContent || '')
      });
    }
    // A rail drawn semibold in a theme or a build bolds every row, and then the
    // weight says nothing about any one of them: read as unread, it put a dot on
    // every channel, each one leaving only when it was clicked. When every row
    // carries the weight, none of them does.
    const weightIsBase =
      rows.length > 1 && rows.every((row) => row.badge || row.marked || row.bold);

    for (const row of rows) {
      const { name, marked, current, badge, key } = row;
      const raw = badge || (!weightIsBase && !current && !marked && row.bold);
      // A cue the channel's posts have already answered stays answered while
      // Teams keeps drawing the row the same way. Releasing a dot and letting
      // that same weight latch it again in the next pass is a dot that never
      // clears, and the cue outliving its posts is exactly what put dots on
      // channels with nothing in them. The memory ends as soon as Teams lets go
      // of the row, so the next cue drawn there is news again.
      if (key && !raw) railSettled.delete(key);
      const cued = raw && !(key && railSettled.has(key));
      if (key) railCued.set(key, cued);
      // The cue is Teams' word that something arrived, not that it was read: it
      // is written down, so opening the channel — which takes the bold with it,
      // before a single post was read — leaves the dot standing. Newest last, so
      // trimming keeps recent channels.
      //
      // A badge is taken at once. A weight is asked twice, a second apart: Teams
      // paints a row semibold for reasons that are not news — a row being
      // selected, a rail that is still rendering, a tooltip — and each of those
      // left a dot on a channel with nothing in it, which only opening the
      // channel could take away again.
      if (cued && key && !railUnread[key]) {
        const since = railPending.get(key);
        if (badge || (since && now - since >= 600)) {
          delete railUnread[key];
          railUnread[key] = { r: badge ? 'badge' : 'bold', t: now };
          latched = true;
        } else {
          pending.set(key, since || now);
        }
      }
      // The dot follows the latch, not the pass: a mark that has not been
      // confirmed yet paints nothing, so a bold that lasts one pass cannot
      // flicker a dot onto a channel and back off again.
      const unread = key ? Boolean(railUnread[key]) : cued;
      if (unread) {
        if (name.dataset.tppUnreadName !== '1') name.dataset.tppUnreadName = '1';
      } else if (name.dataset.tppUnreadName !== undefined) {
        delete name.dataset.tppUnreadName;
      }
      paintRailDot(name, unread);
    }
    if (latched) saveRailSoon();

    // A row Teams has replaced leaves its mark, or our dot, on a detached or
    // renamed node; this is the cheap way to keep the page free of them.
    for (const el of document.querySelectorAll('[data-tpp-unread-name]')) {
      if (!names.has(el)) delete el.dataset.tppUnreadName;
    }
    // The dot now lives inside the name, so the name carrying the mark is what
    // keeps it; anything else is a leftover (including a dot an older build
    // inserted beside the name).
    for (const dot of document.querySelectorAll('[data-tpp-ui="rail-dot"]')) {
      const host = dot.parentElement;
      if (!dot.isConnected || !host || host.dataset.tppUnreadName !== '1') dot.remove();
    }
    // Only rows that are still cued this pass wait for a second look.
    railPending = pending;
  }

  /**
   * Takes the rail dot's marks off the page.
   *
   * Nothing repaints them while the feature is off, so the bold name and the
   * dot an older build drew have to be removed here or they would look like a
   * feature that is still on.
   */
  function stripRailMarks() {
    for (const name of document.querySelectorAll('[data-tpp-unread-name]')) {
      delete name.dataset.tppUnreadName;
    }
    for (const dot of document.querySelectorAll('[data-tpp-ui="rail-dot"]')) {
      dot.remove();
    }
  }

  /**
   * Draws the dot that says a channel has news, inside the name's own line.
   *
   * It goes in as the name's first child rather than as a sibling of it: a
   * sibling is another flex item in Teams' row, so it was laid out beside the
   * label's box instead of in its text, pushing the name along and onto a line
   * of its own at narrow widths. An inline child sits in the same line box as
   * the name, wraps with it, adds no line of its own and comes back out cleanly.
   */
  function paintRailDot(name, unread) {
    const child = name.firstElementChild;
    const dot = child && child.dataset && child.dataset.tppUi === 'rail-dot' ? child : null;
    if (!unread) {
      if (dot) dot.remove();
      return;
    }
    if (dot) return;
    const mark = document.createElement('span');
    mark.dataset.tppUi = 'rail-dot';
    mark.className = 'tpp-rail-dot';
    mark.setAttribute('aria-hidden', 'true');
    name.prepend(mark);
  }

  /**
   * Takes a channel's dot down once the posts it stood for have been read.
   *
   * The posts are the answer, not Teams' cue: with the compact view a post
   * stays unread until the user reads it by hand, so a channel with none left is
   * one they have cleared — and the dot must go then, on its own, without the
   * channel having to be clicked a second time. Teams' cue is only asked as a
   * courtesy, in case it is still painting the channel that was just opened
   * (see scheduleRailSettle); it can never keep the dot up.
   */
  function settleRailUnread() {
    // Another Teams tab in front, or no channel at all: nothing here decides a
    // dot, and a channel's posts are not on screen to be judged.
    if (!postsTabSelected()) return;
    // No dot in this release: nothing is latched, so there is nothing to settle.
    if (!features || !features.railDot) return;
    const key = openRailKeys().find((candidate) => railUnread[candidate]);
    if (!key) return;
    // Teams is still cueing the row: it may be drawing the channel that was
    // opened a moment ago. Look again once the rail has caught up — and then
    // let the posts decide, cued or not.
    if (railCued.get(key)) {
      scheduleRailSettle(key, 2);
      return;
    }
    releaseIfAllRead(key, 0);
  }

  /**
   * Releases a channel's dot when every post read from it has been read.
   *
   * Only rows read from this channel can decide it: another channel's posts,
   * or none at all, are not evidence that this one has been read. `tries` is
   * how many more looks an empty list is worth — a channel with no posts looks
   * exactly like one whose list is still loading, and the first is a dot that
   * could never be cleared by opening a card.
   */
  function releaseIfAllRead(key, tries) {
    const rows = rowsKeys.includes(key) ? rowsById : null;
    if (!rows) return;
    if (!rows.size) {
      if (tries > 0) scheduleRailSettle(key, tries - 1);
      return;
    }
    for (const entry of rows.values()) {
      if (entry.row.dataset.tppNew === '1') {
        // There is news here again: the rail is free to say so, even if this
        // channel's last dot was settled while Teams kept the row cued.
        railSettled.delete(key);
        return;
      }
    }
    releaseRailUnread(key);
  }

  /**
   * The names the rail gives the channel now on screen.
   *
   * The header title is the direct answer, but Teams has moved that element
   * between builds, and where it is missing no dot could ever be cleared. The
   * row Teams draws as selected names the same channel, so both are offered and
   * the latch is looked up under either.
   */
  function openRailKeys() {
    const keys = [];
    const title = channelTitle();
    if (title) keys.push(title);
    const selector = (S.channelItem || []).join(',');
    if (!selector) return keys;
    try {
      for (const item of document.querySelectorAll(selector)) {
        if (item.querySelector(selector)) continue;
        if (!isCurrentRailRow(item)) continue;
        const name = railNameOf(item);
        const key = name && collapse(name.textContent || '');
        if (key && !keys.includes(key)) keys.push(key);
      }
    } catch (_) {
      // No rail on screen: the title, where there is one, is all there is.
    }
    return keys;
  }

  /** Takes a channel's dot down for good: the latch, the mark and the paint. */
  function releaseRailUnread(key) {
    clearTimeout(railSettleTimer);
    railSettleTimer = 0;
    if (!railUnread[key]) return;
    delete railUnread[key];
    // The posts answered this cue. Remember that for as long as Teams draws the
    // row the same way, so the cue cannot latch the dot straight back on.
    railSettled.add(key);
    saveRailSoon();
    // Redrawn now rather than on the pass a second away, so the dot leaves with
    // the card that cleared it.
    channelRailAt = 0;
    paintChannelRail();
  }

  /**
   * Looks at the channel's dot again a moment later.
   *
   * Two answers are not final the first time they are asked: Teams' bold may
   * still be on the row from before the channel opened, and a list that has not
   * rendered looks like a channel with no posts. The rail is repainted first, so
   * the second look is made on what Teams shows now; a cue that is still there
   * buys one more wait and no more, and then the posts decide — a cue Teams
   * left behind must never be what keeps the dot up.
   */
  function scheduleRailSettle(key, tries = 1) {
    clearTimeout(railSettleTimer);
    railSettleTimer = setTimeout(() => {
      railSettleTimer = 0;
      if (!ready || tries <= 0) return;
      // Another channel on screen: its own scan decides its own dot.
      if (!postsTabSelected() || !openRailKeys().includes(key)) return;
      channelRailAt = 0;
      paintChannelRail();
      // One more wait while Teams is still cueing the row; after that the posts
      // decide, because a cue Teams left behind is what kept dots up over
      // channels the user had already read.
      if (railCued.get(key) && tries > 1) {
        scheduleRailSettle(key, tries - 1);
        return;
      }
      releaseIfAllRead(key, tries - 1);
    }, 1200);
  }

  /** The element that carries a channel row's name, remembered per row. */
  function railNameOf(item) {
    const cached = railNameCache.get(item);
    if (cached && cached.isConnected && item.contains(cached)) return cached;

    let name = first(S.channelName, item);
    if (name && !hasLetters(name.textContent)) name = null;
    if (!name) {
      // No name anchor: the first short piece of text in the row is the name.
      // Badges and counts are rejected by the letters test.
      let looked = 0;
      for (const el of item.querySelectorAll('span, div, p, a')) {
        if (looked++ > 14) break;
        // Our dot is a child of the name, and it is all a name may hold.
        const kids = Array.from(el.children).filter(
          (child) => child.dataset.tppUi !== 'rail-dot'
        );
        if (kids.length || !hasLetters(el.textContent)) continue;
        name = el;
        break;
      }
    }
    if (name) railNameCache.set(item, name);
    return name || null;
  }

  function hasLetters(text) {
    return /[A-Za-z]/.test(collapse(text || ''));
  }

  /** Whether the page draws this element bold — Teams' unread channel cue. */
  function isBold(el) {
    try {
      const weight = getComputedStyle(el).fontWeight;
      if (weight === 'bold') return true;
      const numeric = Number(weight);
      return Number.isFinite(numeric) && numeric >= 600;
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether the name, or anything wrapping it up to its row, is drawn bold.
   *
   * Teams has put the weight in every one of those places across builds, and a
   * bold wrapper with a plain label inside is the case a leaf-only check misses.
   */
  function isBoldUp(name, item) {
    for (let el = name; el; el = el.parentElement) {
      if (isBold(el)) return true;
      if (el === item) break;
    }
    return false;
  }

  /**
   * Whether Teams draws this rail row as the one the user is in.
   *
   * The selected row is semibold, and a weight is exactly what the rail reads as
   * unread, so the two have to be told apart. Teams marks the row with
   * aria-selected, aria-current or a class — never with the badge markup below —
   * so this answers a different question from hasUnreadMark.
   */
  function isCurrentRailRow(item) {
    try {
      if (item.getAttribute('aria-selected') === 'true') return true;
      if (item.getAttribute('aria-current')) return true;
      if (/(?:^|[\s_-])(?:selected|current|active)(?:[\s_-]|$)/i.test(String(item.className || '')))
        return true;
      return Boolean(item.querySelector('[aria-selected="true"], [aria-current]'));
    } catch (_) {
      return false;
    }
  }

  /**
   * Whether a row carries Teams' own unread marker — a dot, a count or a badge,
   * or an aria label that says so. Some builds cue the rail with one of these
   * and no weight change at all, which is why the weight alone cannot be trusted.
   */
  function hasUnreadMark(item) {
    const label = collapse(item.getAttribute('aria-label') || '');
    if (/unread|new (?:post|message|activity)/i.test(label)) return true;
    try {
      for (const el of item.querySelectorAll(
        '[data-tid*="unread" i], [data-tid*="new-message" i], [aria-label*="unread" i]'
      )) {
        if (el.closest('[data-tpp-ui]')) continue;
        // A row can keep its context menu in its own markup, and "Mark as
        // unread" is a menu item, not a badge: read as a cue it marked the
        // channel for good, since the menu never goes away.
        if (el.closest('[role="menu"], [role="menuitem"]')) continue;
        return true;
      }
    } catch (_) {
      // No badge markup in this build: the weight is the only cue.
    }
    return false;
  }

  function placeDaySeparators() {
    for (const seam of document.querySelectorAll('.tpp-day-sep')) {
      placeSeam(seam, 'tpp-day-row');
    }
  }

  /**
   * Watches the posts' boxes for a change of height.
   *
   * The day's lines hang in the gaps between posts, placed by measuring those
   * gaps, and a post grows without the scan ever seeing it: a reply box opening
   * inside a row grows the post while the composer holds the scan off, and an
   * image or a thread arriving grows it after the rows were last read. A line
   * measured against the height the post had a moment before sits over the post
   * instead of in the gap after it, so the rows themselves are watched and the
   * lines put back before the grown post can be seen. A line only ever moves;
   * it takes no room, so writing it cannot resize the row and call this again.
   */
  function watchPostSizes(list) {
    if (!ready || channelMode !== true || !features || !features.dayLines || !list) {
      unwatchPostSizes();
      return;
    }

    if (!sizeObserver) {
      sizeObserver = new ResizeObserver(() => {
        if (!ready || channelMode !== true) return;
        if (!features || !features.dayLines) return;
        // Measured in the resize callback rather than on the next frame: it runs
        // after layout and before paint, so the lines are already in the new gap
        // when the grown post is first drawn.
        placeDaySeparators();
      });
    }

    const keep = new Set(list.querySelectorAll('.tpp-post'));
    for (const row of sizeWatched) {
      if (!keep.has(row) || !row.isConnected) sizeObserver.unobserve(row);
    }
    for (const row of keep) sizeObserver.observe(row);
    sizeWatched = keep;
  }

  /** Stops watching the posts, for a view that no longer draws the lines. */
  function unwatchPostSizes() {
    sizeObserver?.disconnect();
    sizeObserver = null;
    sizeWatched = new Set();
  }

  /**
   * Puts a line in the middle of the gap beside the post it belongs to,
   * measuring from the visible edges of the two posts rather than from the boxes
   * around them, whose padding would pull the line off centre.
   *
   * `band` is the row class that gives the line a band of its own: a row
   * measured to its padded bottom would put the gap above the line and drop the
   * line onto the post below.
   */
  function placeSeam(seam, band) {
    const row = seam.closest('.tpp-post');
    if (!row) return;

    // The box the user sees: the card while the post is folded, the post itself
    // once it is open — and always the row when compact posts are off, where the
    // card is still in the row but `display: none` and has no box to measure.
    const card = row.querySelector(':scope > [data-tpp-ui="preview"]');
    const open = row.classList.contains('tpp-unfold');
    const shown = card && !open && card.getClientRects().length ? card : row;
    const rowRect = row.getBoundingClientRect();
    const box = shown.getBoundingClientRect();
    if (!box.height) return;

    // The band under the post belongs to the line, not to the post — but only
    // when the row itself is what was measured: the card ends above the band.
    const banded = row.classList.contains(band);
    const padding =
      shown === row && banded ? parseFloat(getComputedStyle(row).paddingBottom) || 0 : 0;
    const bottom = box.bottom - padding;

    let next = row.nextElementSibling;
    let nextBox = null;
    while (next) {
      const post = next.classList.contains('tpp-post')
        ? next
        : next.querySelector('.tpp-post');
      if (post) {
        // The same box the user sees: a folded post is its card. Its row keeps
        // padding above the card, and measuring that would pull the line up.
        const nextCard = post.querySelector('[data-tpp-ui="preview"]');
        const nextShown =
          nextCard && !post.classList.contains('tpp-unfold') && nextCard.getClientRects().length
            ? nextCard
            : post;
        nextBox = nextShown.getBoundingClientRect();
        break;
      }
      next = next.nextElementSibling;
    }

    // The middle of the space the user sees: under this post's card and over
    // the next post's card.
    const target = nextBox ? (bottom + nextBox.top) / 2 : bottom + 18;
    const floor = bottom - rowRect.top + 2;

    // The line is measured where it is drawn and moved by the difference, so
    // any offset between its box and the line inside it (a margin, a clipped
    // one) is taken out instead of assumed away.
    const drawn = seam.getBoundingClientRect();
    const top = drawn.height
      ? (parseFloat(seam.style.top) || 0) + (target - (drawn.top + drawn.height / 2))
      : bottom - rowRect.top + Math.max((nextBox ? nextBox.top - bottom : 16) / 2, 2) - seam.offsetHeight / 2;

    // Only when it moves: writing the same value on every scan is a mutation,
    // and a mutation on our own node is what a scan loop feeds on.
    const nextTop = `${Math.round(Math.max(top, floor))}px`;
    if (seam.style.top !== nextTop) seam.style.top = nextTop;
  }

  /**
   * The day a post belongs to, as the page prints it.
   *
   * Teams prints a time on every post but puts no day over them, so the label is
   * counted from the post's own stamp: the page's clock decides whether that
   * day is Today, Yesterday or a date, and the reader's locale prints it. The
   * year only appears when it is not this one.
   */
  function dayLabelOf(ts) {
    const date = new Date(ts);
    if (!Number.isFinite(date.getTime())) return '';
    const midnight = (value) =>
      new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const today = new Date();
    const days = Math.round((midnight(today) - midnight(date)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const options = { weekday: 'long', day: 'numeric', month: 'long' };
    if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric';
    try {
      return date.toLocaleDateString(undefined, options);
    } catch (_) {
      return date.toDateString();
    }
  }

  /**
   * Draws the line that separates one day's posts from the next.
   *
   * The line hangs in the gap after `row`, in the light purple and with the date
   * in it. Which row carries it, and which date it names, depends on the order
   * Teams lists the posts in — see refreshDaySeparators.
   */
  function paintDaySeparator(row, ts) {
    let sep = row.querySelector(':scope > [data-tpp-ui="day-sep"]');
    // Inbox Zero replaces the read markers with its own tabs.
    const wanted = Boolean(features) && features.dayLines && !features.inboxZero && ts > 0;
    if (!wanted) {
      sep?.remove();
      row.classList.remove('tpp-day-row');
      return;
    }

    row.classList.add('tpp-day-row');
    if (!sep) {
      sep = document.createElement('div');
      sep.className = 'tpp-day-sep';
      sep.dataset.tppUi = 'day-sep';
      sep.innerHTML =
        '<span class="tpp-day-line"></span>' +
        '<span class="tpp-day-label"></span>' +
        '<span class="tpp-day-line"></span>';
      // In the gap after the row: above the day below it in newest-first order,
      // below the day it names in newest-last order.
      row.append(sep);
    }
    const label = dayLabelOf(ts);
    const slot = sep.querySelector('.tpp-day-label');
    if (slot && slot.textContent !== label) slot.textContent = label;
  }

  /**
   * Whether the list prints its newest post at the top, as Teams does by
   * default. The "See new posts at bottom" setting turns the list round, and the
   * day's line closes each day's run instead of opening it.
   */
  function postsNewestFirst(list) {
    const scope = list || (lastList && lastList.isConnected ? lastList : null);
    if (!scope) return true;
    // The answer is kept on the list rather than read again on every frame. A
    // row Teams is re-drawing loses its stamp for a moment, and a reading taken
    // then would turn the day's lines and the pinned edge round for a frame and
    // move the posts under the reader.
    //
    // The order is taken from the posts in the order they are drawn, by
    // position, not from the first and last rows in the markup: Teams positions
    // these rows itself and recycles the nodes, so a row can sit anywhere in the
    // list whatever its place on screen.
    const rows = [];
    for (const row of scope.querySelectorAll('.tpp-post')) {
      const ts = Number(row.dataset.tppTs) || 0;
      if (!ts) continue;
      const box = row.getBoundingClientRect();
      if (box.height <= 0) continue;
      rows.push({ top: box.top, ts });
    }

    // Asked of every neighbouring pair, not of the two ends. One row can carry a
    // stamp from the post it held before, or be drawn away from its place, or
    // sit below the fold with a newer stamp than the whole visible run — and
    // comparing the ends let any one of those turn the whole list round: the
    // day's lines then named the other side of every gap, and the pinned date
    // moved to the far edge and named a different, older day each time a long
    // post was scrolled. A pair from the same day says nothing either way, so
    // only pairs more than a day apart are counted, and the majority decides.
    if (rows.length > 1) {
      rows.sort((a, b) => a.top - b.top);
      let down = 0;
      let up = 0;
      for (let i = 1; i < rows.length; i += 1) {
        const step = rows[i].ts - rows[i - 1].ts;
        if (Math.abs(step) <= 86400000) continue;
        if (step < 0) down += 1;
        else up += 1;
      }
      // A split vote is not an answer: the order stays as it was read last.
      const order = down === up ? '' : down > up ? '1' : '0';
      if (order && scope.dataset.tppNewestFirst !== order) {
        scope.dataset.tppNewestFirst = order;
        dayLinesStale = true;
      }
      // The evidence, for a console report: rows read, then how many pairs
      // said newest-first and how many said newest-last.
      const seen = `${rows.length}:${down}/${up}`;
      if (scope.dataset.tppOrder !== seen) scope.dataset.tppOrder = seen;
    }
    return scope.dataset.tppNewestFirst !== '0';
  }

  /**
   * Decides where the day's lines go, and what they say.
   *
   * The rows are walked in the order Teams lists them. A post ends its day when
   * the next post with a stamp is from another day. Newest first, that boundary
   * is drawn above the older day's first post — the gap after this one — and says
   * that older day, so each day's run starts with its date. Newest last, the
   * line closes the day whose posts are above it, as before. A post whose stamp
   * cannot be read is passed over rather than guessed at, and the day after it is
   * still compared with the day before it, so one unreadable post cannot split a
   * day in two or join two together.
   */
  function refreshDaySeparators() {
    if (!features || !features.dayLines) {
      for (const sep of document.querySelectorAll('[data-tpp-ui="day-sep"]')) sep.remove();
      for (const row of document.querySelectorAll('.tpp-day-row')) {
        row.classList.remove('tpp-day-row');
      }
      return;
    }

    const dated = [];
    for (const row of document.querySelectorAll('.tpp-post')) {
      // The day a post sits in is the day of its newest activity: a reply lifts
      // a post into today's run, and the date it was written would cut the run.
      const ts = activityStampOf(row);
      const date = ts > 0 ? new Date(ts) : null;
      dated.push({
        row,
        ts,
        day: date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : ''
      });
    }

    // Filled from the end so the next dated post is known in one pass.
    const nextDay = new Array(dated.length).fill('');
    const nextIndex = new Array(dated.length).fill(-1);
    let ahead = '';
    let aheadIndex = -1;
    for (let i = dated.length - 1; i >= 0; i -= 1) {
      nextDay[i] = ahead;
      nextIndex[i] = aheadIndex;
      if (dated[i].day) {
        ahead = dated[i].day;
        aheadIndex = i;
      }
    }

    const newestFirst = postsNewestFirst(lastList);
    for (let i = 0; i < dated.length; i += 1) {
      const entry = dated[i];
      const next = nextIndex[i];
      const boundary = Boolean(entry.day) && next >= 0 && nextDay[i] !== entry.day;
      if (!boundary) {
        paintDaySeparator(entry.row, 0);
      } else if (newestFirst) {
        paintDaySeparator(entry.row, dated[next].ts);
      } else {
        paintDaySeparator(entry.row, entry.ts);
      }
    }
  }

  /** The box the list scrolls in: the viewport Teams wraps the rows in. */
  function scrollPortOf(list) {
    return lastScrollBox && lastScrollBox.isConnected && lastScrollBox.contains(list)
      ? lastScrollBox
      : scrollBoxFor(list);
  }

  /**
   * The empty strip Teams leaves in the pane header, which the date line is drawn in.
   *
   * The line used to be fixed over the posts, which cost the list 20px of its own
   * height to stand in — room that moved every post under the reader when it was
   * given back and taken again. Teams leaves an empty flex box above the list, and
   * a line drawn there rides above the posts instead: the list keeps its height
   * and nothing scrolls beneath a strip that is not part of it.
   *
   * The strip is found by its shape rather than its generated class names: an
   * empty div, most of the list's width, sitting above the list in an earlier
   * branch of the pane. The nearest one wins, which is the strip directly above
   * the posts rather than a spacer further up the header.
   */
  function dayPinHost(port) {
    const portBox = port && port.getBoundingClientRect();
    if (!portBox || portBox.height < 40) return null;

    const isSlot = (el) => {
      if (!(el instanceof HTMLElement) || el.tagName !== 'DIV') return false;
      if (el.childElementCount || el.textContent.trim()) return false;
      if (el.hasAttribute('data-tpp-ui') || !el.getClientRects().length) return false;
      // The strip is beside the list, not in it and not a wrapper around it.
      if (port.contains(el) || el.contains(port)) return false;
      const box = el.getBoundingClientRect();
      if (box.width < Math.min(120, portBox.width * 0.4)) return false;
      if (box.bottom > portBox.top + 2) return false;
      // A strip too short for the line, and clipped at that, would hide it.
      if (box.height < DAY_PIN_HEIGHT) {
        const style = getComputedStyle(el);
        if (style.overflowY === 'hidden' || style.overflowY === 'clip') return false;
      }
      return true;
    };

    let best = null;
    let node = port;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      // Every sibling, whichever side of the list it sits on in the markup:
      // a pane that lays out bottom-up puts the header after the list. Only a
      // box that ends above the list's top is a strip over it.
      for (const sib of parent.children) {
        if (sib === node) continue;
        const pool = [sib];
        if (sib.childElementCount) pool.push(...sib.querySelectorAll('div'));
        for (const el of pool) {
          if (!isSlot(el)) continue;
          const distance = portBox.top - el.getBoundingClientRect().bottom;
          if (!best || distance < best.distance) best = { el, distance };
        }
      }
      node = parent;
    }
    return best ? best.el : null;
  }

  /**
   * The colour painted behind the list, for the line to stand on.
   *
   * A line over the posts needs a surface of its own, and the one colour that is
   * always right is the colour it covers: the list's own background, or the
   * nearest painted box above it. Teams repaints that per theme, so the colour
   * is sampled rather than guessed from a palette of ours, and a light or dark
   * switch is followed without a rule of its own.
   */
  function paintBehind(start) {
    for (let node = start; node; node = node.parentElement) {
      const color = String(getComputedStyle(node).backgroundColor || '');
      const rgb = /rgba?\(([^)]+)\)/.exec(color);
      if (!rgb) continue;
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) continue;
      // Half-transparent paint lets the posts through, which is the thing the
      // surface is there to stop; only a colour of its own will do.
      const alpha = parts.length > 3 ? parts[3] : 1;
      if (!Number.isFinite(alpha) || alpha < 0.99) continue;
      return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    }
    return '';
  }

  /**
   * The colour behind the line, re-read a couple of times a second at most.
   *
   * It is taken from the card at the edge rather than the pane, because that is
   * what is under the line as it scrolls: Teams' cards are a shade of their own,
   * and a band cut from the pane's surface is a stripe across them. A post that
   * is open has no card, and then the list's own colour is the one to match.
   */
  function pinPaintFor(port, row) {
    const now = performance.now();
    if (pinPaint && now - pinPaintAt < 500) return pinPaint;
    pinPaintAt = now;
    const card = row && features && features.compactPosts ? row.querySelector('.tpp-preview') : null;
    pinPaint = paintBehind(card || row || port) || pinPaint;
    return pinPaint;
  }

  /** The header strip for this list, cached: the lookup walks the pane header. */
  function pinHostFor(list) {
    const port = scrollPortOf(list);
    if (!port) return null;
    if (pinHost && pinHost.isConnected && pinHostPort === port) {
      // A strip the pane has collapsed or hidden takes the line with it: the
      // overlay over the posts is the fallback until it is back on screen.
      if (pinHost.getClientRects().length) return pinHost;
      restorePinHost();
      return null;
    }
    // A pane with no such strip is asked again at most once a second: this runs
    // on rebuilds and on scroll frames, not on every pixel of a scroll.
    const now = performance.now();
    if (!pinHost && pinHostTriedPort === port && now - pinHostTriedAt < 1000) return null;
    pinHostTriedPort = port;
    pinHostTriedAt = now;
    if (pinHost && pinHostPort !== port) restorePinHost();
    pinHost = dayPinHost(port);
    pinHostPort = port;
    return pinHost;
  }

  /** Puts the line in the header strip, or back over the list when there is none. */
  function mountDayPin(pin, host) {
    if (!host) {
      if (pin.parentElement !== document.body) document.body.append(pin);
      delete pin.dataset.tppHosted;
      return;
    }
    if (pin.parentElement !== host) host.append(pin);
    // An absolutely placed child needs a containing box. The strip's own inline
    // position is written down so teardown can give it back exactly.
    if (!host.hasAttribute('data-tpp-pin-host')) {
      host.dataset.tppPinHostPos = host.style.position || '';
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.setAttribute('data-tpp-pin-host', '');
    }
    pin.dataset.tppHosted = '1';
  }

  /** Gives every strip back the position the pin borrowed from it. */
  function restorePinHost() {
    for (const host of document.querySelectorAll('[data-tpp-pin-host]')) {
      host.style.position = host.dataset.tppPinHostPos || '';
      host.removeAttribute('data-tpp-pin-host');
      delete host.dataset.tppPinHostPos;
    }
    pinHost = null;
    pinHostPort = null;
  }

  /**
   * The line that holds the date at the edge being read from.
   *
   * The drawn separators live in the gaps between posts, so they travel with the
   * list. This one names the day at the reading edge and stands there until the
   * next day's line takes over. Teams leaves an empty strip in the pane header,
   * and the line is drawn in it (dayPinHost): it then rides above the posts
   * without the list giving up any of its height. A pane with no such strip
   * still gets the line as a fixed overlay at the edge of the scroll box.
   * It is `pointer-events: none` so nothing is ever in the way of a click, and a
   * separator already sitting at the edge is held out of sight rather than
   * doubled.
   */
  function updateDayPin(list) {
    if (!features || !features.dayLines || features.inboxZero) {
      hideDayPin();
      dropDayPinInset();
      return;
    }

    // The edge to hold the line against is the visible one: the box that
    // scrolls. Teams nests the rows in a runway inside the viewport, and the
    // runway moves with the posts, so its own box is no edge at all. The scan has
    // already found the box; this runs on every scroll frame, so it is not asked
    // again unless the list has moved out of it.
    const port = scrollPortOf(list);
    if (!port || !port.isConnected || !port.getClientRects().length) {
      hideDayPin();
      return;
    }

    const rect = port.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      hideDayPin();
      return;
    }

    // The line needs its own room at the edge, or the first post at the end of
    // the scroll sits under it. The list gives it that much padding before its
    // first post (newest first) or after its last (newest last). It is given by
    // the scan, before anything is measured, and only when the edge changes: a
    // scroll frame that rewrote the list's height is what moved the posts under
    // the reader, and in the bottom order it was worse, because the extra room
    // sat in the scroll range the reader was already at the end of.
    const newestFirst = postsNewestFirst(list);
    const host = pinHostFor(list);
    if (host) {
      // The header carries the line, so the list keeps its full height: any
      // room an earlier layout borrowed for an overlay is given back, once.
      if (list.dataset.tppPinEdge !== undefined) dropDayPinInset();
    } else if (list.dataset.tppPinEdge !== (newestFirst ? 'top' : 'bottom')) {
      applyDayPinInset(list, newestFirst);
    }

    const edge = newestFirst ? rect.top : rect.bottom;
    const row = postAtEdge(list, rect, newestFirst);
    const label = dayAtEdge(list, rect, newestFirst, row);
    if (!label) {
      hideDayPin();
      return;
    }

    // The line is drawn as wide as the posts, not the pane: Teams insets its
    // list, and a line running edge to edge does not sit with the cards. Both
    // edges come from a post's own box and are held inside the pane, so the
    // label's centre is the middle of the post's box. The last good box stands
    // in for a frame with no post at the edge.
    const box = row && row.getBoundingClientRect();
    if (box && box.width > 80) pinBox = { left: box.left, width: box.width };
    const bounds = pinBox || { left: rect.left, width: port.clientWidth };
    const pinLeft = Math.min(Math.max(bounds.left, rect.left), rect.right - 1);
    const pinRight = Math.min(bounds.left + bounds.width, rect.right);

    const pin = dayPinEl();
    mountDayPin(pin, host);

    // In the header the line is placed against the strip, not the window: the
    // same post-wide span, held inside the strip and centred in its height.
    let left;
    let width;
    let top;
    if (host) {
      const hostBox = host.getBoundingClientRect();
      const from = Math.min(Math.max(pinLeft, hostBox.left), hostBox.right - 1);
      const to = Math.min(pinRight, hostBox.right);
      left = `${Math.round(from - hostBox.left)}px`;
      width = `${Math.max(0, Math.round(to - from))}px`;
      top = `${Math.max(0, Math.round((hostBox.height - DAY_PIN_HEIGHT) / 2))}px`;
    } else {
      left = `${Math.round(pinLeft)}px`;
      width = `${Math.max(0, Math.round(pinRight - pinLeft))}px`;
      top = `${Math.round(newestFirst ? rect.top : rect.bottom - DAY_PIN_HEIGHT)}px`;
    }
    if (pin.style.left !== left) pin.style.left = left;
    if (pin.style.width !== width) pin.style.width = width;
    if (pin.style.top !== top) pin.style.top = top;
    // Over the posts the line needs a surface; in the header it stands on the
    // pane's own padding and a band there would only be a stripe.
    const paint = host ? '' : pinPaintFor(port, row);
    if (paint && pin.style.background !== paint) pin.style.background = paint;
    else if (!paint && pin.style.background) pin.style.background = '';
    pin.dataset.tppEdge = newestFirst ? 'top' : 'bottom';
    const slot = pin.querySelector('.tpp-day-label');
    if (slot && slot.textContent !== label) slot.textContent = label;
    if (pin.hidden) pin.hidden = false;

    // One line at the edge: the drawn separator that has arrived there is held
    // while the pin stands in for it, so the date is not printed twice.
    for (const sep of list.querySelectorAll('.tpp-day-sep')) {
      const box = sep.getBoundingClientRect();
      const near = newestFirst
        ? box.top < edge + DAY_PIN_HEIGHT && box.bottom > edge
        : box.bottom > edge - DAY_PIN_HEIGHT && box.top < edge;
      sep.classList.toggle('tpp-day-sep-held', near);
    }
  }

  /**
   * The date at the edge being read from.
   *
   * Only the post at the edge speaks for it. Its own drawn line speaks first
   * when that has reached the edge: the label is the day on the far side of it,
   * and it arrives a moment before that day's first post does — using the post
   * alone made the held line hand over late, with a day's posts already under a
   * pin still naming the day before. With no line of its own at the edge, the
   * day is the one that post belongs to.
   *
   * A line belonging to any other post is never consulted, however close to the
   * edge it measures. A post several screens long is the only post at the edge
   * for a long stretch of scrolling, and while it was open the pin walked
   * through the days of the posts further down the channel — Tuesday, October
   * 20, then September 21, then August 31 — naming posts that were nowhere near
   * the reader, over the one that had not moved. The line of a recycled row (a
   * box at the top of the page, or behind the list) was one way in; any line
   * that happens to sit near the edge while a long post is open is another.
   * Reading only the post at the edge makes the date a property of what is
   * under the line, so scrolling inside a post cannot change it.
   */
  function dayAtEdge(list, rect, newestFirst, row) {
    const edge = newestFirst ? rect.top : rect.bottom;
    // No post at the edge means nothing is known: the pin steps aside and the
    // drawn line, wherever it is, says the date.
    if (!row) return '';

    const banded = newestFirst
      ? (box) => box.top <= edge + 1 && box.bottom >= edge - DAY_PIN_HEIGHT
      : (box) => box.bottom >= edge - 1 && box.top <= edge + DAY_PIN_HEIGHT;

    for (const sep of row.querySelectorAll('.tpp-day-sep')) {
      if (sep.closest('.tpp-post') !== row) continue;
      const label = sep.querySelector('.tpp-day-label')?.textContent || '';
      if (!label) continue;
      const box = sep.getBoundingClientRect();
      if (box.height <= 0 || !banded(box)) continue;
      return label;
    }

    return dayLabelOf(activityStampOf(row));
  }

  /** The post at the edge of the scroll box, or the nearest one within a line. */
  function postAtEdge(list, rect, newestFirst) {
    const x = Math.round(rect.left + rect.width / 2);
    const y = newestFirst ? rect.top + 9 : rect.bottom - 9;
    try {
      const hit = document.elementFromPoint(x, y);
      const row = hit && hit.closest('.tpp-post');
      if (row && list.contains(row)) return row;
    } catch (_) {
      // No point lookup on this page: fall through to the boxes.
    }

    // A header or a margin took the point: the post whose box holds the edge is
    // the one being read.
    let nearest = null;
    let distance = Infinity;
    for (const row of list.querySelectorAll('.tpp-post')) {
      const box = row.getBoundingClientRect();
      if (box.height <= 0) continue;
      if (y >= box.top && y <= box.bottom) return row;
      const gap = Math.min(Math.abs(y - box.top), Math.abs(y - box.bottom));
      if (gap < distance) {
        distance = gap;
        nearest = row;
      }
    }
    return distance <= 40 ? nearest : null;
  }

  /**
   * Hides the held line and lets the drawn lines show.
   *
   * The room it borrowed stays where it is: taking 20px off the list and
   * putting it back a moment later is a jump of its own, and the pin returns on
   * the next frame in any case. Only a pin that is gone for good gives the room
   * back (dropDayPinInset).
   */
  function hideDayPin() {
    const pin = document.getElementById(DAY_PIN_ID);
    if (pin && !pin.hidden) pin.hidden = true;
    for (const sep of document.querySelectorAll('.tpp-day-sep-held')) {
      sep.classList.remove('tpp-day-sep-held');
    }
  }

  /** Gives the list back the room the pin borrowed, for a pin that is gone. */
  function dropDayPinInset() {
    for (const el of document.querySelectorAll('[data-tpp-pin-edge]')) {
      restoreDayPinInset(el);
    }
    pinBox = null;
  }

  /**
   * Gives the pinned line its 20px at the edge being read from: before the first
   * post when the newest is on top, after the last when it is at the bottom. The
   * change is made only when the edge changes, so scrolling does not rewrite the
   * list's padding on every frame.
   */
  function applyDayPinInset(list, newestFirst) {
    const edge = newestFirst ? 'top' : 'bottom';
    if (list.dataset.tppPinEdge === edge) {
      // The edge is the same; make sure the padding is still there. Teams
      // rewrites style attributes as it re-renders, and a padding taken back
      // that way would leave the first post under the line again.
      const base =
        parseFloat(
          edge === 'top' ? list.dataset.tppPinTopBase : list.dataset.tppPinBottomBase
        ) || 0;
      const pad =
        parseFloat(getComputedStyle(list)[edge === 'top' ? 'paddingTop' : 'paddingBottom']) || 0;
      if (pad >= base + DAY_PIN_HEIGHT - 1) return;
    }
    restoreDayPinInset(list);

    if (newestFirst) {
      list.dataset.tppPinTopInline = list.style.paddingTop || '';
      list.dataset.tppPinTopBase = getComputedStyle(list).paddingTop;
      const base = parseFloat(list.dataset.tppPinTopBase) || 0;
      list.style.paddingTop = `${base + DAY_PIN_HEIGHT}px`;
    } else {
      list.dataset.tppPinBottomInline = list.style.paddingBottom || '';
      list.dataset.tppPinBottomBase = getComputedStyle(list).paddingBottom;
      const base = parseFloat(list.dataset.tppPinBottomBase) || 0;
      list.style.paddingBottom = `${base + DAY_PIN_HEIGHT}px`;
    }
    list.dataset.tppPinEdge = edge;
  }

  /** Restores whatever padding the list had before the pin borrowed its edge. */
  function restoreDayPinInset(list) {
    if (!list || list.dataset.tppPinEdge === undefined) return;
    if (list.dataset.tppPinTopInline !== undefined) {
      list.style.paddingTop = list.dataset.tppPinTopInline;
      delete list.dataset.tppPinTopInline;
      delete list.dataset.tppPinTopBase;
    }
    if (list.dataset.tppPinBottomInline !== undefined) {
      list.style.paddingBottom = list.dataset.tppPinBottomInline;
      delete list.dataset.tppPinBottomInline;
      delete list.dataset.tppPinBottomBase;
    }
    delete list.dataset.tppPinEdge;
  }

  /** The fixed element the pin is drawn in, made on first use. */
  function dayPinEl() {
    let pin = document.getElementById(DAY_PIN_ID);
    if (pin) return pin;
    pin = document.createElement('div');
    pin.id = DAY_PIN_ID;
    pin.className = 'tpp-day-pin';
    pin.dataset.tppUi = 'day-pin';
    pin.setAttribute('aria-hidden', 'true');
    pin.innerHTML =
      '<span class="tpp-day-line"></span>' +
      '<span class="tpp-day-label"></span>' +
      '<span class="tpp-day-line"></span>';
    document.body.append(pin);
    return pin;
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

  /**
   * A post as it stands, written so two browsers describe it the same way.
   *
   * The token is Teams' own numbers — the newest stamp printed in the row, the
   * reply count and how many reactions the post carries. It is deliberately not
   * a hash of the rendered words or of the attachments: those can differ from
   * one device to another while the post is the same, and two browsers would
   * then disagree about whether a post synced as read had moved on. Only the two
   * counts are compared when a mark is reopened (see movedPast): the stamp is
   * kept for the record, not treated as activity of its own.
   */
  function activityTokenOf(row) {
    if (!row) return '';
    return [
      activityStampOf(row) || stampOf(row) || 0,
      replyCountOf(row),
      reactionCountOf(row)
    ].join('|');
  }

  /**
   * How many reactions the post carries, from the chips' own numbers.
   *
   * "Add reaction" prints no count and comes and goes with hover, so counting it
   * would reopen a post the pointer merely crossed; the counts are summed so a
   * second reaction on the same emoji counts as the post moving on.
   */
  function reactionCountOf(row) {
    let total = 0;
    try {
      for (const el of row.querySelectorAll(
        '[data-tid*="reaction" i], [aria-label*="reaction" i]'
      )) {
        if (el.closest('[data-tpp-ui]')) continue;
        const words = collapse(
          `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
        );
        const counts = words.match(/\d[\d,]*/g);
        if (!counts) continue;
        total += Number(counts[counts.length - 1].replace(/,/g, '')) || 0;
      }
    } catch (_) {
      // No reaction markup in this build: replies alone say the post moved on.
    }
    return total;
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

  /** Keeps only well-formed channel names, newest last, under the cap. */
  function normalizeRailUnread(stored) {
    if (!stored || typeof stored !== 'object') return {};
    // A latch is either the old plain `1` or `{ r, t }`: the reason it was
    // written and when, so a dot that stays can be asked why (teamsPlusPlusRail).
    const entries = Object.entries(stored).filter(
      ([name, value]) =>
        typeof name === 'string' &&
        name.length > 0 &&
        (value === 1 || (value && typeof value === 'object'))
    );
    return Object.fromEntries(entries.slice(-RAIL_UNREAD_LIMIT));
  }

  function saveRailSoon() {
    clearTimeout(railSaveTimer);
    railSaveTimer = setTimeout(() => {
      railSaveTimer = 0;
      persistRailUnread();
    }, 300);
  }

  function persistRailUnread() {
    const entries = Object.entries(railUnread);
    if (entries.length > RAIL_UNREAD_LIMIT) {
      railUnread = Object.fromEntries(entries.slice(-RAIL_UNREAD_LIMIT));
    }
    try {
      chrome.storage.local.set({ [RAIL_UNREAD_KEY]: railUnread }, () => {
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
      // The compact view's own marker: a latched unread mark keeps the card
      // unread until its card is opened (markPostOpened), however soon Teams
      // clears its own badge.
      if (refreshNewPost(id, row)) row.dataset.tppNew = '1';
      else if (row.dataset.tppNew !== undefined) delete row.dataset.tppNew;

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
    // Which channel these rows came from, under every name the rail gives it:
    // settleRailUnread refuses to judge one channel by another's posts.
    rowsKeys = openRailKeys();
    // The posts are now read: the rail's dot for this channel is decided with
    // them rather than from Teams' bold, which went as the channel opened.
    settleRailUnread();
    // The pinned line's room is given here, before the lines are measured, and
    // only from a scan: the walk that follows measures every gap against it,
    // and a scroll frame that rewrote the list's height would move the posts
    // under the reader.
    if (features && features.dayLines && !features.inboxZero) {
      // The header strip takes the line without the list giving up any room; the
      // inset is only for a pane where the line has to sit over the posts.
      if (pinHostFor(list)) dropDayPinInset();
      else applyDayPinInset(list, postsNewestFirst(list));
    } else if (list.dataset.tppPinEdge !== undefined) {
      // The date lines are off (or the view that drew them is): the room they
      // borrowed at the edge goes back with them.
      dropDayPinInset();
    }
    refreshDaySeparators();
    placeDaySeparators();
    watchPostSizes(list);
    updateDayPin(lastList);
    applyViewFiltering();
  }

  /**
   * The newest moment Teams prints on a post: the post itself, or a reply to it.
   *
   * A post answered today is lifted back up the channel and still prints the
   * time it was written, so its own stamp files it under the day it was posted —
   * and that line then cuts through today's run. The day lines follow the place
   * a post has in the list, so they go by the newest thing in the row instead: a
   * reply stamp Teams renders in it (a time element, a `timestamp-…` id, or the
   * words of a "last replied" line) wins when it is newer than the post's own.
   *
   * Asking is not free — a row can hold a whole thread — so the answer is kept on
   * the row until the post or its reply count changes, which is what a new reply
   * does. The newest answer is also kept by post id, because a re-render that has
   * not drawn the reply yet reads as an older post: the row's day would fall back
   * to the day it was written, and the line above it would name that day while
   * the post is still the one being read.
   */
  function activityStampOf(row) {
    if (!row) return 0;
    const own = stampOf(row);
    const seen = `${own}|${replyCountOf(row)}`;
    if (row.dataset.tppActOf === seen) return Number(row.dataset.tppActAt) || 0;

    let latest = own || previewTimeOf(row);
    const consider = (ts) => {
      // A date in the future is a misread, not news: a weekday printed without a
      // day can parse as the next one.
      if (Number.isFinite(ts) && ts > latest && ts <= Date.now() + 86400000) {
        latest = ts;
      }
    };
    try {
      for (const el of row.querySelectorAll('time[datetime]')) {
        consider(Date.parse(el.getAttribute('datetime') || ''));
      }
      // Replies are stamped the way posts are: `timestamp-1793472227903`.
      for (const el of row.querySelectorAll('[id^="timestamp-"]')) {
        const suffix = /(\d{10,})$/.exec(el.id || '');
        if (suffix) consider(Number(suffix[1]));
      }
      // A build that prints the newest reply as words rather than a time.
      const footer = first(S.replyCount, row);
      const words = /last\s+repl(?:y|ied)[^a-z0-9]*([^·•|]{4,40})/i.exec(
        footer ? collapse(footer.textContent || '') : ''
      );
      if (words) consider(Date.parse(words[1]));
    } catch (_) {
      // Nothing readable in the row: the post's own stamp stands.
    }

    // A post does not get older. The row's own reading is a snapshot of what
    // Teams had rendered a moment ago, and it is only trusted upwards.
    const id = row.dataset.tppId || '';
    const kept = id ? Number(activityNewest.get(id)) || 0 : 0;
    if (kept > latest) latest = kept;
    else if (id && latest > kept) keepActivity(id, latest);

    row.dataset.tppActOf = seen;
    row.dataset.tppActAt = String(latest || 0);
    return latest;
  }

  /**
   * Remembers the newest activity seen for a post.
   *
   * Kept for the session rather than on the row: Teams replaces a row's node as
   * often as it re-renders it, and the point of the memory is to outlast that.
   * Only the newest few hundred are kept — a post scrolled out of the list and
   * back is read again anyway, and the reading there is a fresh one.
   */
  function keepActivity(id, ts) {
    if (!id || !(ts > 0)) return;
    activityNewest.delete(id);
    activityNewest.set(id, ts);
    if (activityNewest.size > 600) activityNewest.delete(activityNewest.keys().next().value);
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
    row.classList.remove(
      'tpp-post',
      'tpp-unfold',
      'tpp-previewed',
      'tpp-ready',
      'tpp-day-row'
    );
    delete row.dataset.tppPainted;
    delete row.dataset.tppCardOf;
    delete row.dataset.tppTs;
    delete row.dataset.tppActOf;
    delete row.dataset.tppActAt;
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
    if (!target) return;
    restoreDayPinInset(target);
    if (target.dataset.tppPadApplied !== '1') return;
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
   * Takes Teams' own "press Ctrl+F" nudge out of sight.
   *
   * The nudge is a teaching popover in the app's chrome rather than a post, so
   * it is found by what it says: a small surface carrying the shortcut and the
   * word the shortcut stands for. The mark it is given hides it; Teams re-renders
   * the nudge as a new node, and the next check marks that one too.
   */
  function muteSearchNag() {
    let surfaces;
    try {
      surfaces = document.querySelectorAll(NAG_SURFACES);
    } catch (_) {
      return; // A hand-edited selector should never cost us the page.
    }
    for (const el of surfaces) {
      if (el.hasAttribute(NAG_ATTR)) continue;
      if (el.closest('.tpp-post, [data-tpp-ui]')) continue;
      const text = collapse(el.textContent || '');
      // A pane of the app is not a nudge: only a small surface is read.
      if (!text || text.length > 240) continue;
      if (!NAG_SHORTCUT.test(text) || !NAG_WORD.test(text)) continue;
      el.setAttribute(NAG_ATTR, '1');
    }
  }

  /** The nudge check for a scroll frame: no more than twice a second. */
  function muteSearchNagSoon() {
    const now = Date.now();
    if (now - nagCheckedAt < 500) return;
    nagCheckedAt = now;
    muteSearchNag();
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

      // The lines sit in the gaps between two posts, so they are re-measured
      // with everything else that is placed against the list.
      // The order was read the other way round a moment ago: the day's lines
      // were painted against the wrong side of their gaps and are drawn again.
      if (dayLinesStale) {
        dayLinesStale = false;
        refreshDaySeparators();
      }
      placeDaySeparators();
      updateDayPin(list);

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
    // The element itself was replaced, which is what a channel switch often
    // does: the title is read here as well as in the observer, so a swap that
    // never mutates the old node still folds the posts of the channel left.
    noteChannelTitle();
    if (!el) return;
    titleObserver = new MutationObserver(() => {
      if (!ready) return;
      noteChannelTitle();
      resetForChannelChange();
      scheduleScan(true);
    });
    titleObserver.observe(el, { childList: true, characterData: true, subtree: true });
  }

  /**
   * Folds the open posts when the channel on screen is not the one last seen.
   *
   * The title is the channel's name in Teams' own header, and a switch changes
   * it — by its text or by replacing the element. Only a different name counts:
   * Teams repaints the title for a mention count too, and folding the post
   * somebody is reading because a counter changed would be its own surprise.
   */
  function noteChannelTitle() {
    // A mention count can ride along in the header's text; that is not a channel.
    const name = (channelTitle() || '').replace(/\s*\(\d+\)$/, '');
    if (!name || name === lastChannelTitle) return;
    lastChannelTitle = name;
    foldOpenPosts();
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

  function saveNewSoon() {
    clearTimeout(newSaveTimer);
    newSaveTimer = setTimeout(() => {
      newSaveTimer = 0;
      persistNew();
    }, 200);
  }

  /**
   * The newest compact-view marks that fit in one sync item.
   *
   * Oldest first, so the entries dropped are the ones furthest back in the
   * channel: the same order the count limit drops them in, only measured in the
   * size chrome.storage.sync actually enforces.
   */
  function fitNewState(map) {
    const entries = Object.entries(map).slice(-NEW_POST_LIMIT);
    const cost = ([key, value]) => JSON.stringify(key).length + JSON.stringify(value).length + 2;
    let size = 2; // the braces around the map
    for (const entry of entries) size += cost(entry);
    while (entries.length > 1 && size > SYNC_ITEM_BUDGET) size -= cost(entries.shift());
    return Object.fromEntries(entries);
  }

  async function persistNew() {
    let trimmed = fitNewState(newState);
    newState = trimmed;
    if (await writeSync({ [NEW_POSTS_KEY]: trimmed })) return;

    trimmed = Object.fromEntries(
      Object.entries(trimmed).slice(-Math.max(10, Math.floor(NEW_POST_LIMIT / 4)))
    );
    newState = trimmed;
    await writeSync({ [NEW_POSTS_KEY]: trimmed });
  }

  /**
   * Writes the compact-view marks now, for a decision that must not wait: a card
   * the user has just opened is read on this page at once, and the write is what
   * clears the same post on the other browser.
   */
  function flushNew() {
    clearTimeout(newSaveTimer);
    newSaveTimer = 0;
    persistNew();
  }

  /** When a compact-view mark was made, in ms. A mark without one is oldest. */
  function markTimeOf(value) {
    return value && Number(value.t) > 0 ? Number(value.t) : 0;
  }

  /** Whether one mark is the newer decision about its post. */
  function newerMark(value, held) {
    const mine = value && typeof value === 'object' ? value : {};
    const theirs = held && typeof held === 'object' ? held : {};

    // A read against an unread mark is not a question of clocks: a browser can
    // be looking at Teams' badge on a post that was read on the other one — the
    // badge is just the state that device last got — and its sighting is stamped
    // after the read while describing older activity. So the two are compared by
    // the activity each one covers: a mark whose activity is past the read's is
    // news the read never saw, and wins; otherwise the read is what the post was
    // last known to be, and a badge alone never undoes it.
    const mineUnread = mine.n === 1;
    const theirsUnread = theirs.n === 1;
    if (mineUnread !== theirsUnread) {
      const unread = mineUnread ? mine : theirs;
      const read = mineUnread ? theirs : mine;
      const unreadWins =
        typeof unread.a === 'string' &&
        typeof read.a === 'string' &&
        movedPast(unread.a, read.a);
      return mineUnread ? unreadWins : !unreadWins;
    }

    // Two reads of the same post: the one covering more of it is the later read,
    // whatever the clocks say, because activity on a post only goes up.
    if (!mineUnread && !theirsUnread) {
      if (typeof mine.a === 'string' && typeof theirs.a === 'string') {
        if (movedPast(mine.a, theirs.a)) return true;
        if (movedPast(theirs.a, mine.a)) return false;
      }
    }

    const at = markTimeOf(mine);
    const was = markTimeOf(theirs);
    if (at !== was) return at > was;
    // Two marks of the same moment — or two written by an older build, with no
    // moment at all: one answer has to win on every browser, so the marks are
    // compared by what they say rather than by which one arrived last.
    return JSON.stringify(mine) > JSON.stringify(theirs);
  }

  /**
   * Folds two copies of the compact-view marks together, newest decision per post.
   *
   * Each browser keeps the whole map and Chrome Sync hands one whole map to the
   * other, so a map written a moment before the other's change is the one that
   * survives — which is how a post read on one computer came back unread after
   * the other saved. Taking the newer decision per post makes the two maps meet
   * on what the user last did; the entries are ordered oldest first, so trimming
   * keeps the recent ones.
   */
  function mergeNewStates(one, other) {
    const merged = new Map();
    for (const map of [one, other]) {
      for (const [id, value] of Object.entries(map || {})) {
        const held = merged.get(id);
        if (!held || newerMark(value, held)) merged.set(id, value);
      }
    }
    const entries = Array.from(merged.entries()).sort(
      (a, b) =>
        markTimeOf(a[1]) - markTimeOf(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    return Object.fromEntries(entries.slice(-NEW_POST_LIMIT));
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
    // The pinned line borrows 20px at the end of the list in the bottom order,
    // and that room is part of the scroll range. It is left out of both sums: a
    // short tab keeps no scroll range, and the end of a long one is the end of
    // the posts, not a strip of blank the clamp then pulls the reader off.
    const inset = list.dataset.tppPinEdge === 'bottom' ? DAY_PIN_HEIGHT : 0;
    setRoomPad(Math.max(0, Math.round(box.clientHeight - shown) - 2 - inset));

    // Only a scroll this script is allowed to answer is pulled back. A scan
    // that moved the scroll while Teams was paging a channel's history was read
    // by Teams as being at the end of what it had, and it fetched the next
    // batch: that is how a whole channel's history ended up loading into the
    // list. The pad alone is enough to keep the end of the tab honest.
    if (!moveScroll) return;
    const limit = Math.max(0, last + inset - box.clientHeight);
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
    // The Ctrl+F nudge is shown on the first scroll of a channel, and again
    // after Teams re-renders it, so the check rides along with the scroll.
    muteSearchNagSoon();
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

    // Teams' Ctrl+F nudge comes and goes with the page's own rendering, so
    // every scan is a chance to take it down.
    muteSearchNag();

    // The rail is read on every scan, wherever Teams is: a channel can have news
    // while a chat is open. paintChannelRail throttles itself to once a second.
    paintChannelRail();
    // A channel Teams gives no list at all never rebuilds its rows, and its dot
    // would then never be settled. The same decision is made here; it only uses
    // rows read from this channel (rowsKeys), so a scan that has not reached the
    // posts yet cannot clear the dot of the one before it.
    settleRailUnread();

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
          for (const id of [DAY_PIN_ID, EMPTY_ID, CONFETTI_ID, TOAST_ID]) {
            document.getElementById(id)?.remove();
          }
          restorePinHost();
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
        for (const id of [DAY_PIN_ID, EMPTY_ID, CONFETTI_ID, TOAST_ID]) {
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
   * A MutationObserver callback runs before the browser lays the page out, so
   * doing the work that decides a row's height here means a batch of older posts
   * never appears at full height only to collapse a moment later. That flash is
   * what made the list jump on first load, and again whenever hovering made Teams
   * re-render a few rows.
   *
   * The card is part of that work, and it is the whole of it when compact posts
   * are on without Inbox Zero: a row they are folded into is a quarter of the
   * height Teams drew, so a row left at Teams' height until the debounced scan
   * grew the list by a whole post and then gave it back. Teams keeps the posts
   * under the reader still with a ResizeObserver that compensates for exactly
   * that change (applyAnchoring), and in the bottom order — the end of the list,
   * where every one of those changes lands on the reading edge — its correction
   * is what the reader sees as the posts skipping. Folding here, before the row
   * is ever laid out, leaves it nothing to compensate for. Everything else
   * (buttons, day lines, pins, the Inbox walk) still waits for the scan.
   */
  function absorbNodes(nodes) {
    if (!ready || !features || channelMode !== true) return;
    if (!features.inboxZero && !features.compactPosts) return;
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

      // Teams re-renders a row's contents more often than the row itself, and
      // the card goes with them: the row is left folded with nothing to show,
      // or (until its classes are read again) at Teams' full height. Putting the
      // card back here, before the browser measures the row, is the difference
      // between a post that keeps its place and one that moves the list.
      if (features.compactPosts) {
        const owner = node.parentElement && node.parentElement.closest('.tpp-post');
        if (
          owner &&
          owner.dataset.tppId &&
          !owner.classList.contains('tpp-unfold') &&
          !owner.querySelector(':scope > [data-tpp-ui="preview"]') &&
          !inTeamsPane(owner)
        ) {
          paintRow(owner);
        }
      }

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
        // The card now, not in 300ms: see the note above.
        if (features.compactPosts) paintRow(row);
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

    if (!features.dayLines) {
      // The date lines come off, with the band the drawn ones were given and
      // the room the held one borrowed at the edge.
      for (const el of document.querySelectorAll('[data-tpp-ui="day-sep"]')) el.remove();
      for (const el of document.querySelectorAll('.tpp-day-row')) el.classList.remove('tpp-day-row');
      hideDayPin();
      dropDayPinInset();
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
    unwatchPostSizes();
    perf.loadStartedAt = 0;
    settleTries = 0;
    listDirty = true;
    lastScrollBox = null;
    titleObserver?.disconnect();
    titleObserver = null;
    titleEl = null;
    for (const id of [TABS_ID, DAY_PIN_ID, EMPTY_ID, TOAST_ID, CONFETTI_ID]) {
      document.getElementById(id)?.remove();
    }
    // Every list that ever carried the pinned line's room gives it back, and
    // every header strip the line was drawn in gets its own position back.
    dropDayPinInset();
    restorePinHost();

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
      [NEW_POSTS_KEY]: null,
      [VIEW_KEY]: null
    });

    features = normalize(items[STORAGE_KEY]);
    readState = normalizeMap(items[UNREAD_KEY], READ_LIMIT);
    newState = normalizeMap(items[NEW_POSTS_KEY], NEW_POST_LIMIT);
    try {
      const local = await chrome.storage.local.get([
        ACTIVITY_KEY,
        RAIL_UNREAD_KEY,
        LEGACY_CASCADE_KEY
      ]);
      activityState = normalizeActivity(local && local[ACTIVITY_KEY]);
      // The unread baseline an older build kept for Teams' cascade: following
      // the badge needs none, so the map goes rather than spending the quota.
      if (local && local[LEGACY_CASCADE_KEY]) {
        chrome.storage.local.remove(LEGACY_CASCADE_KEY, () => void chrome.runtime.lastError);
      }
      // The rail dot is off in this release, so no latch is read back, and the
      // map an older build wrote is dropped: kept, it would dot the rail the
      // moment the feature is switched on again, from news long since read.
      railUnread = features.railDot ? normalizeRailUnread(local && local[RAIL_UNREAD_KEY]) : {};
      if (!features.railDot && local && local[RAIL_UNREAD_KEY]) {
        chrome.storage.local.remove(RAIL_UNREAD_KEY, () => void chrome.runtime.lastError);
      }
    } catch (_) {
      activityState = {};
      railUnread = {};
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

    // What the day lines are drawn from, asked the same way with
    // `teamsPlusPlusDays()`: a post filed under the wrong day is a question
    // about the stamps Teams printed on that row, and this prints them.
    window.teamsPlusPlusDays = () =>
      Array.from(document.querySelectorAll('.tpp-post')).map((row) => {
        const own = stampOf(row);
        const activity = activityStampOf(row);
        return {
          id: row.dataset.tppId || '',
          post: own ? new Date(own).toISOString() : '',
          activity: activity ? new Date(activity).toISOString() : '',
          day: activity ? dayLabelOf(activity) : '',
          replies: replyCountOf(row)
        };
      });

    // What the rail's dots are drawn from, asked from the page's own console
    // with `teamsPlusPlusRail()`: a dot that will not go away is a question
    // about the row Teams drew, and this prints that row rather than guessing.
    window.teamsPlusPlusRail = () => {
      const selector = (S.channelItem || []).join(',');
      const rows = [];
      for (const item of document.querySelectorAll(selector)) {
        if (item.querySelector(selector)) continue;
        const name = railNameOf(item);
        if (!name) continue;
        rows.push({
          name: collapse(name.textContent || ''),
          selected: isCurrentRailRow(item),
          weight: getComputedStyle(name).fontWeight,
          badge: hasUnreadMark(item),
          dot: name.dataset.tppUnreadName === '1',
          aria: item.getAttribute('aria-label') || '',
          role: item.getAttribute('role') || ''
        });
      }
      return {
        build: BUILD,
        open: openRailKeys(),
        rowsKeys,
        latched: { ...railUnread },
        cued: Object.fromEntries(railCued),
        settled: Array.from(railSettled),
        pending: Object.fromEntries(railPending),
        posts: rowsById.size,
        newPosts: Array.from(rowsById.values()).filter(
          (entry) => entry.row.dataset.tppNew === '1'
        ).length,
        rows
      };
    };
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
    // Which post a press in the row was on, for the fold it may cancel.
    document.addEventListener('pointerdown', onAnyPointerDown, true);
    document.addEventListener('keydown', onPostKeyDown, true);
    window.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });
    window.addEventListener('resize', reposition);

    bootstrap();
  }

  // Keep an open tab in sync when settings, archives or activity change elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (changes[NEW_POSTS_KEY]) {
      const incoming = normalizeMap(changes[NEW_POSTS_KEY].newValue, NEW_POST_LIMIT);
      newState = mergeNewStates(newState, incoming);
      // The map here held a decision newer than the one that arrived: write the
      // fold back, so the browser that saved first sees the newer one too.
      if (JSON.stringify(newState) !== JSON.stringify(incoming)) saveNewSoon();
      scheduleScan(true);
    }
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
