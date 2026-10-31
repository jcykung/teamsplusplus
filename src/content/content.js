/**
 * Teams++ content script.
 *
 * Two features live here:
 *
 *   Inbox Zero      Adds Archive / Pin buttons to each post. Archived posts are
 *                   hidden until a newer reply arrives, at which point the
 *                   thread comes back just like a reply in an email inbox. A
 *                   Show All Posts button at the bottom restores the normal
 *                   Teams view.
 *
 *   Pinned posts    Shows pinned posts in a thin purple bar at the top of the
 *                   channel. Posts pinned by a channel moderator sit first in
 *                   Teams purple; posts you pin yourself sit below them in a
 *                   lighter violet.
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

  const STACK_ID = 'tpp-pin-stack';
  const TOGGLE_ID = 'tpp-view-toggle';
  const EMPTY_ID = 'tpp-empty-state';
  const TOAST_ID = 'tpp-toast';

  const PIN_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6z"/><path d="M12 15v6"/></svg>';
  const UNPIN_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6z"/><path d="M12 15v6"/><path d="M3 3l18 18"/></svg>';
  const ARCHIVE_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>';
  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
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
  let view = 'inbox';

  /** id -> { row, text, author, replies, archived } for the latest scan. */
  let rowsById = new Map();
  /** id -> { id, text, author } for posts Teams itself has pinned. */
  let nativePins = new Map();
  /** Archived posts the user asked to see (jumping from a pinned bar). */
  const forceShow = new Set();

  let observer = null;
  let lastList = null;
  let rescanTimer = 0;
  let archiveSaveTimer = 0;
  let pinsSaveTimer = 0;
  let frame = 0;
  let toastTimer = 0;

  // --------------------------------------------------------------- helpers

  function first(selectors, root) {
    const scope = root || document;
    for (const selector of selectors) {
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

    const time = row.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    return 'h:' + hash(`${text}|${time}`);
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

  function replyCount(row) {
    const candidates = row.querySelectorAll(
      '[data-tid*="repl" i], [aria-label*="repl" i], button, a'
    );
    for (const el of candidates) {
      if (el.closest('.tpp-post-actions')) continue;
      const label = el.getAttribute('aria-label') || '';
      const text = collapse(el.textContent || label);
      const match = text.match(/(\d+)\s+repl(?:y|ies)/i);
      if (match) return parseInt(match[1], 10);
    }

    const match = collapse(row.textContent).match(/(\d+)\s+repl(?:y|ies)/i);
    return match ? parseInt(match[1], 10) : 0;
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
   * Every outermost message row inside `root`. Nested matches (a message body
   * inside its own row) are dropped so one post is never handled twice.
   */
  function collectRows(root, allowDialog) {
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(S.messageRow.join(',')));
    } catch (_) {
      return [];
    }

    const set = new Set(nodes);
    return nodes.filter((el) => {
      for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
        if (set.has(parent)) return false;
      }
      if (el.closest('.tpp-post-actions, .tpp-pin-stack, .tpp-empty-state')) return false;
      if (!allowDialog && el.closest('[role="dialog"]')) return false;
      return true;
    });
  }

  function rebuildRows(list) {
    const next = new Map();
    const native = new Map();
    let archiveChanged = false;
    let pinsChanged = false;

    for (const row of collectRows(list, false)) {
      const text = previewOf(row);
      if (!text) {
        row.classList.remove('tpp-post');
        continue;
      }

      const id = idFor(row, text);
      if (row.dataset.tppId !== id) row.dataset.tppId = id;
      row.classList.add('tpp-post');

      const replies = replyCount(row);
      const nativePinned = isNativePinned(row);
      const authored = authorOf(row);

      // Email behaviour: a newer reply puts an archived thread back in the inbox.
      const saved = archive[id];
      if (saved && replies > (Number(saved.c) || 0)) {
        delete archive[id];
        archiveChanged = true;
        toast('New reply — a thread is back in your inbox.');
      }

      // Keep a pinned bar's preview in step with an edited post.
      if (pins[id] && pins[id].x !== text) {
        pins[id].x = text;
        pinsChanged = true;
      }

      const isArchived = Boolean(archive[id]);
      const hidden = features.inboxZero && isArchived && view === 'inbox' && !forceShow.has(id);

      row.classList.toggle('tpp-archived', hidden);
      row.classList.toggle(
        'tpp-archived--visible',
        features.inboxZero && isArchived && !hidden
      );

      injectActions(row, isArchived, nativePinned);
      if (nativePinned) native.set(id, { id, text, author: authored });
      next.set(id, { row, id, text, author: authored, replies, archived: isArchived });
    }

    rowsById = next;
    nativePins = native;
    harvestPinnedPane();

    if (archiveChanged) saveArchiveSoon();
    if (pinsChanged) savePinsSoon();
  }

  /** Picks up posts from Teams' own pinned-messages pane when it is open. */
  function harvestPinnedPane() {
    const pane = first(S.pinnedPane);
    if (!pane || pane.getClientRects().length === 0) return;

    for (const row of collectRows(pane, true)) {
      const text = previewOf(row);
      if (!text) continue;
      const id = idFor(row, text);
      if (!nativePins.has(id)) {
        nativePins.set('pane:' + id, { id, text, author: authorOf(row) });
      }
    }
  }

  // ------------------------------------------------------------- row buttons

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
      archiveBtn.innerHTML = ARCHIVE_SVG + '<span></span>';
      archiveBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleArchive(row.dataset.tppId);
      });
      actions.append(archiveBtn);
    }
    archiveBtn.hidden = !features.inboxZero;
    const archiveLabel = archiveBtn.querySelector('span');
    const archiveText = isArchived ? 'Unarchive' : 'Archive';
    if (archiveLabel.textContent !== archiveText) archiveLabel.textContent = archiveText;
    archiveBtn.title = isArchived
      ? 'Move this post back into your inbox'
      : 'Archive this post — a new reply will bring it back';
    archiveBtn.setAttribute('aria-label', archiveBtn.title);
    archiveBtn.classList.toggle('is-on', isArchived);

    let pinBtn = actions.querySelector('.tpp-pin-btn');
    if (!pinBtn) {
      pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'tpp-post-btn tpp-pin-btn';
      pinBtn.dataset.tppUi = 'pin';
      pinBtn.innerHTML = PIN_SVG + '<span></span>';
      pinBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePin(row.dataset.tppId);
      });
      actions.append(pinBtn);
    }
    pinBtn.hidden = !features.pinnedMessages;

    const locallyPinned = Boolean(pins[row.dataset.tppId]);
    const pinLabel = pinBtn.querySelector('span');
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

  function toggleArchive(id) {
    if (!id) return;

    if (archive[id]) {
      delete archive[id];
      forceShow.delete(id);
    } else {
      const record = rowsById.get(id);
      archive[id] = { c: record ? record.replies : 0, t: Date.now() };
    }

    saveArchiveSoon();
    scan();
  }

  function togglePin(id) {
    if (!id) return;

    if (pins[id]) {
      delete pins[id];
    } else {
      const record = rowsById.get(id);
      pins[id] = {
        x: record?.text || '',
        a: record?.author || '',
        t: Date.now()
      };
    }

    savePinsSoon();
    scan();
  }

  // ------------------------------------------------------------ pinned bars

  function buildPinEntries() {
    const entries = [];
    const seen = new Set();

    // Moderator pins always sit above the user's own pins.
    for (const pin of nativePins.values()) {
      if (pin.id && seen.has(pin.id)) continue;
      if (pin.id) seen.add(pin.id);
      entries.push({ ...pin, kind: 'native' });
    }

    for (const [id, pin] of Object.entries(pins)) {
      if (seen.has(id)) continue;
      entries.push({
        id,
        text: pin.x || 'Pinned post',
        author: pin.a || '',
        kind: 'user'
      });
    }

    return entries;
  }

  function pinBar(entry) {
    const label = entry.author ? `${entry.author}: ${entry.text}` : entry.text;

    const bar = document.createElement('div');
    bar.className = `tpp-pin-bar tpp-pin-bar--${entry.kind}`;
    bar.dataset.tppUi = 'pin-bar';
    bar.tabIndex = 0;
    bar.setAttribute('role', 'button');
    bar.title =
      entry.kind === 'native'
        ? `Pinned by a channel moderator — ${label}`
        : `Pinned by you — ${label}`;

    const icon = document.createElement('span');
    icon.className = 'tpp-pin-bar-icon';
    icon.dataset.tppUi = 'pin-icon';
    icon.innerHTML = PIN_SVG;

    const text = document.createElement('span');
    text.className = 'tpp-pin-bar-text';
    text.textContent = label;

    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'tpp-pin-bar-unpin';
    unpin.dataset.tppUi = 'unpin';
    unpin.innerHTML = UNPIN_SVG;
    unpin.title = 'Unpin this post';
    unpin.setAttribute('aria-label', 'Unpin this post');
    unpin.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (entry.kind === 'user') togglePin(entry.id);
      else unpinNative(entry.id);
    });

    const go = () => jumpTo(entry);
    bar.addEventListener('click', go);
    bar.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go();
      }
    });

    bar.append(icon, text, unpin);
    return bar;
  }

  function renderPins(list) {
    const existing = document.getElementById(STACK_ID);
    const entries = features.pinnedMessages ? buildPinEntries() : [];

    if (!list || !features.pinnedMessages || entries.length === 0) {
      existing?.remove();
      clearTopInset(list);
      return;
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

    // Only rebuild when the set or wording changes, so Teams' own mutations
    // do not make the stack flicker.
    const signature = entries
      .map((entry) => `${entry.kind}:${entry.id}:${entry.text}:${entry.author}`)
      .join('|');

    if (stack.dataset.signature !== signature) {
      stack.dataset.signature = signature;
      stack.textContent = '';
      for (const entry of entries) stack.append(pinBar(entry));
    }

    anchor(stack, list, { top: 8, full: true });

    // Nudge the first post below the bars instead of letting them cover it.
    const height = stack.getBoundingClientRect().height;
    applyTopInset(list, height + 8);
  }

  /**
   * Pinned bars float over the top of the list. A matching padding-top keeps
   * the first post readable when a channel opens, without changing Teams' own
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

    const control = first(S.unpinControl, row);
    if (control) {
      control.click();
      toast('Asked Teams to unpin this post.');
      return;
    }

    toast('This post is pinned in Teams. Use the post’s ⋯ menu to unpin it.');
  }

  // ------------------------------------------------------------------- jump

  function findRow(id) {
    if (!id) return null;
    for (const el of document.querySelectorAll('[data-tpp-id]')) {
      if (el.dataset.tppId === id) return el;
    }
    return null;
  }

  function findByText(text) {
    const needle = collapse(text).slice(0, 80).toLowerCase();
    if (!needle) return null;

    for (const record of rowsById.values()) {
      if (record.text.toLowerCase().includes(needle)) return record.row;
    }
    return null;
  }

  function jumpTo(entry) {
    let row = findRow(entry.id) || findByText(entry.text);
    if (!row) {
      toast('That post is not loaded yet. Scroll the channel to find it.');
      return;
    }

    const id = row.dataset.tppId;
    if (id && archive[id] && !forceShow.has(id)) {
      forceShow.add(id);
      scan();
      row = findRow(id) || row;
    }

    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('tpp-flash');
    setTimeout(() => row.classList.remove('tpp-flash'), 1800);
  }

  // ------------------------------------------------------------- empty state

  function renderEmpty(list) {
    const existing = document.getElementById(EMPTY_ID);

    if (!features.inboxZero || view !== 'inbox') {
      existing?.remove();
      return;
    }

    const records = Array.from(rowsById.values());
    if (records.length === 0) {
      existing?.remove();
      return;
    }

    const hidden = records.filter(
      (record) => record.archived && !forceShow.has(record.id)
    ).length;
    if (hidden < records.length) {
      existing?.remove();
      return;
    }

    let empty = existing;
    if (!empty) {
      empty = document.createElement('div');
      empty.id = EMPTY_ID;
      empty.className = 'tpp-empty-state';
      empty.dataset.tppUi = 'empty';

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
        'Every post in this channel is archived. A new reply will bring a thread back to your inbox.';

      empty.append(confetti, check, title, copy);
      document.body.append(empty);
    }

    anchor(empty, list, { top: 0, full: true, matchHeight: true });
  }

  // ------------------------------------------------------------ view toggle

  function renderToggle(list) {
    const existing = document.getElementById(TOGGLE_ID);

    if (!features.inboxZero || !list) {
      existing?.remove();
      return;
    }

    let wrap = existing;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = TOGGLE_ID;
      wrap.className = 'tpp-view-toggle';
      wrap.dataset.tppUi = 'view-toggle';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tpp-view-btn';
      button.addEventListener('click', () => {
        view = view === 'inbox' ? 'all' : 'inbox';
        forceShow.clear();
        writeSync({ [VIEW_KEY]: view });
        apply();
      });

      wrap.append(button);
      document.body.append(wrap);
    }

    const button = wrap.querySelector('button');
    const label = view === 'inbox' ? 'Show All Posts' : 'Show Unread Posts';
    if (button.textContent !== label) button.textContent = label;
    button.title =
      view === 'inbox'
        ? 'Show every post, including the ones you archived'
        : 'Hide archived posts and return to Inbox Zero';

    anchor(wrap, list, { bottom: 14, full: true });
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
    } else {
      el.style.left = 'auto';
      el.style.right = `${Math.max(window.innerWidth - rect.right, 0) + (options.right || 0)}px`;
      el.style.width = options.width || 'auto';
    }

    if (options.matchHeight) {
      el.style.height = `${Math.max(rect.height, 120)}px`;
    }
  }

  function toast(message) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.className = 'tpp-toast';
      el.dataset.tppUi = 'toast';
      el.setAttribute('role', 'status');
      document.body.append(el);
    }

    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3400);

    const list = findMessageList();
    if (list) anchor(el, list, { bottom: 58, full: true });
  }

  function reposition() {
    if (!ready || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const list = findMessageList();
      if (!list) return;

      const stack = document.getElementById(STACK_ID);
      if (stack) anchor(stack, list, { top: 8, full: true });

      const toggle = document.getElementById(TOGGLE_ID);
      if (toggle) anchor(toggle, list, { bottom: 14, full: true });

      const empty = document.getElementById(EMPTY_ID);
      if (empty) anchor(empty, list, { top: 0, full: true, matchHeight: true });

      const tip = document.getElementById(TOAST_ID);
      if (tip) anchor(tip, list, { bottom: 58, full: true });
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

  // ------------------------------------------------------------------- scan

  function scan() {
    if (!ready) return;

    const list = findMessageList();

    // Our own overlays and buttons must not re-trigger the observer.
    if (observer) observer.disconnect();
    try {
      if (!list) {
        document.getElementById(STACK_ID)?.remove();
        document.getElementById(TOGGLE_ID)?.remove();
        document.getElementById(EMPTY_ID)?.remove();
        clearTopInset();
        return;
      }

      lastList = list;
      rebuildRows(list);
      renderPins(list);
      renderToggle(list);
      renderEmpty(list);
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

    if (!features.inboxZero) {
      for (const el of document.querySelectorAll('.tpp-archived, .tpp-archived--visible')) {
        el.classList.remove('tpp-archived', 'tpp-archived--visible');
      }
      forceShow.clear();
    }

    if (!features.pinnedMessages) {
      document.getElementById(STACK_ID)?.remove();
      clearTopInset();
    }

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
