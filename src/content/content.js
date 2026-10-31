/**
 * Content script: turns the saved feature state into DOM changes on Teams.
 *
 * Two kinds of tweak live here:
 *   - attribute-only:   the content script sets `data-bt-*` on <html> and
 *                       teams.css does the rest.
 *   - DOM-backed:       a matching CUSTOM entry marks rows, builds the unread
 *                       banner, or adds the pin button.
 *
 * DOM-backed work is driven by one debounced scan of the message list, so a
 * Teams re-render or channel switch repairs itself without a page reload.
 */
(function () {
  'use strict';

  const { STORAGE_KEY, FEATURES, normalize } = globalThis.BetterTeams;
  const S = globalThis.BetterTeamsSelectors;

  const BANNER_ID = 'bt-unread-banner';
  const PIN_ID = 'bt-pin-button';
  const DIVIDER_CLASSES = ['bt-divider', 'bt-divider--date', 'bt-divider--unread'];
  const DOM_FEATURES = [
    'dateDividers',
    'unreadLine',
    'unreadBanner',
    'pinnedShortcut',
    'floatingComposer'
  ];

  const WEEKDAY = '(mon|tues|wednes|thurs|fri|satur|sun)day';
  const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
  const DATE_TEXT = new RegExp(
    '^(today|yesterday|' +
      WEEKDAY +
      '|' +
      MONTH +
      '\\s+\\d{1,2}(,\\s*\\d{4})?' +
      '|\\d{1,2}\\s+' +
      MONTH +
      '\\s+\\d{4}' +
      '|\\d{1,2}/\\d{1,2}/\\d{2,4})$',
    'i'
  );
  const UNREAD_TEXT = /^(new|unread) messages?\b/i;

  let current = null;
  let rescanTimer = null;
  let frame = 0;

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

  function collapses(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
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

  /**
   * Teams sometimes nests the whole list inside a single wrapper element, so
   * walk down while there is exactly one child holding a lot of content.
   */
  function rowHost(list) {
    let host = list;
    for (let depth = 0; depth < 6; depth += 1) {
      const only = host.children.length === 1 ? host.firstElementChild : null;
      if (!only || !only.children.length) return host;
      if (collapses(only.textContent).length < 200) return host;
      host = only;
    }
    return host;
  }

  function insideMessageBody(el) {
    return Boolean(el.closest(S.messageBody.join(',')));
  }

  // -------------------------------------------------------------- dividers

  const marked = new Set();

  function clearMarks() {
    for (const el of marked) el.classList.remove(...DIVIDER_CLASSES);
    marked.clear();
    for (const el of document.querySelectorAll('.bt-divider')) {
      el.classList.remove(...DIVIDER_CLASSES);
    }
  }

  function markRow(row, kind) {
    const className = `bt-divider--${kind}`;
    if (row.classList.contains(className)) return;
    row.classList.add('bt-divider', className);
    marked.add(row);
  }

  /**
   * Tag the rows that Teams already renders as date separators and as the
   * "new messages" separator. Teams does not expose a stable attribute for
   * either, so the rows are recognised by their text.
   */
  function markDividers(list) {
    if (!list) return;
    const host = rowHost(list);

    for (let row = host.firstElementChild; row; row = row.nextElementSibling) {
      const label = collapses(row.textContent);
      if (!label || label.length > 48) continue;
      if (insideMessageBody(row)) continue;

      if (UNREAD_TEXT.test(label)) markRow(row, 'unread');
      else if (DATE_TEXT.test(label)) markRow(row, 'date');
    }
  }

  function looksLikeMessage(row) {
    if (row.classList.contains('bt-divider')) return false;
    if (row.querySelector(S.messageRow.join(','))) return true;
    return Boolean(row.querySelector('[data-tid*="avatar"]'));
  }

  function countMessagesAfter(divider) {
    let count = 0;
    for (let row = divider.nextElementSibling; row; row = row.nextElementSibling) {
      if (looksLikeMessage(row)) count += 1;
    }
    return count;
  }

  // ---------------------------------------------------------------- overlay

  /**
   * Anchor a fixed-position overlay to the message list. Give `right` to pin the
   * element to the list's right edge, or leave it out for a full-width strip.
   */
  function placeOverlay(el, list, options) {
    const { top = 8, right = null, width = null } = options || {};
    const rect = list.getBoundingClientRect();
    el.style.top = `${Math.max(rect.top, 0) + top}px`;

    if (right === null) {
      el.style.right = 'auto';
      el.style.left = `${rect.left + 12}px`;
      el.style.width = width || `${Math.max(rect.width - 24, 220)}px`;
      return;
    }

    el.style.left = 'auto';
    el.style.right = `${Math.max(window.innerWidth - rect.right, 0) + right}px`;
    el.style.width = width || 'auto';
  }

  function buildBanner() {
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'bt-banner';
    banner.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.className = 'bt-banner-text';

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'bt-banner-button';
    jump.textContent = 'Jump to unread';
    jump.addEventListener('click', () => {
      document
        .querySelector('.bt-divider--unread')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    // Teams clears unread state once the newest post is in view, so scrolling
    // to the bottom is the same action as its own mark-as-read.
    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'bt-banner-button bt-banner-button--primary';
    read.textContent = 'Mark as read';
    read.addEventListener('click', () => {
      const list = findMessageList();
      if (!list) return;
      list.scrollTop = list.scrollHeight;
      const bannerEl = document.getElementById(BANNER_ID);
      if (bannerEl) bannerEl.remove();
    });

    banner.append(text, jump, read);
    return banner;
  }

  function renderUnreadBanner(list) {
    const divider = list ? list.querySelector('.bt-divider--unread') : null;
    if (!divider || !document.body) {
      document.getElementById(BANNER_ID)?.remove();
      return;
    }

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = buildBanner();
      document.body.append(banner);
    }

    const count = countMessagesAfter(divider);
    const text = banner.querySelector('.bt-banner-text');
    text.textContent =
      count > 0 ? `${count} new ${count === 1 ? 'post' : 'posts'}` : 'New posts below';

    placeOverlay(banner, list, { top: 8 });
  }

  function renderPinButton(list) {
    const control = first(S.pinnedControl);
    if (!control || !list || !document.body) {
      document.getElementById(PIN_ID)?.remove();
      return;
    }

    let button = document.getElementById(PIN_ID);
    if (!button) {
      button = document.createElement('button');
      button.id = PIN_ID;
      button.type = 'button';
      button.className = 'bt-pin-button';
      button.title = 'Pinned messages';
      button.setAttribute('aria-label', 'Pinned messages');
      button.textContent = '📌';
      button.addEventListener('click', () => {
        const target = first(S.pinnedControl);
        if (target) target.click();
      });
      document.body.append(button);
    }

    placeOverlay(button, list, { top: 8, right: 12, width: '32px' });
  }

  function findComposer() {
    const direct = first(S.composer);
    if (direct) return direct;

    const editor = first(S.composerEditor);
    if (!editor) return null;

    // Climb to the toolbar-sized container that wraps the editable field.
    for (let node = editor; node && node !== document.body; node = node.parentElement) {
      if (node.dataset && node.dataset.tid && node.clientWidth > 280) return node;
    }
    return editor.parentElement;
  }

  function floatComposer() {
    const composer = findComposer();
    if (composer) composer.classList.add('bt-composer-float');
  }

  function unfloatComposer() {
    for (const el of document.querySelectorAll('.bt-composer-float')) {
      el.classList.remove('bt-composer-float');
    }
  }

  // ------------------------------------------------------------------- scan

  function rescan() {
    if (!current) return;
    const list = findMessageList();

    if (current.dateDividers || current.unreadLine || current.unreadBanner) {
      markDividers(list);
    } else {
      clearMarks();
    }

    if (current.unreadBanner) renderUnreadBanner(list);
    else document.getElementById(BANNER_ID)?.remove();

    if (current.pinnedShortcut) renderPinButton(list);
    else document.getElementById(PIN_ID)?.remove();

    if (current.floatingComposer) floatComposer();
  }

  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      rescan();
    }, 350);
  }

  function repositionOverlays() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!current) return;
      const list = findMessageList();
      if (!list) return;
      const banner = document.getElementById(BANNER_ID);
      if (banner) placeOverlay(banner, list, { top: 8 });
      const pin = document.getElementById(PIN_ID);
      if (pin) placeOverlay(pin, list, { top: 8, right: 12, width: '32px' });
    });
  }

  // ---------------------------------------------------------------- actions

  const CUSTOM = {
    dateDividers: {
      on() {
        markDividers(findMessageList());
      },
      off() {
        if (!current.unreadLine && !current.unreadBanner) clearMarks();
      }
    },
    unreadLine: {
      on() {
        markDividers(findMessageList());
      },
      off() {
        if (!current.dateDividers && !current.unreadBanner) clearMarks();
      }
    },
    unreadBanner: {
      on() {
        scheduleRescan();
      },
      off() {
        document.getElementById(BANNER_ID)?.remove();
        if (!current.dateDividers && !current.unreadLine) clearMarks();
      }
    },
    pinnedShortcut: {
      on() {
        scheduleRescan();
      },
      off() {
        document.getElementById(PIN_ID)?.remove();
      }
    },
    floatingComposer: {
      on() {
        floatComposer();
      },
      off() {
        unfloatComposer();
      }
    }
  };

  function apply(next) {
    const html = document.documentElement;
    if (!html) return;

    current = next; // Set first so the CUSTOM handlers below see the new state.

    for (const feature of FEATURES) {
      const enabled = Boolean(next[feature.id]);

      if (feature.attr) {
        if (enabled) html.setAttribute(feature.attr, '');
        else html.removeAttribute(feature.attr);
      }

      const custom = CUSTOM[feature.id];
      if (custom) custom[enabled ? 'on' : 'off']();
    }

    if (DOM_FEATURES.some((id) => next[id])) scheduleRescan();
  }

  function readAndApply() {
    chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
      if (chrome.runtime.lastError) return; // Extension was reloaded mid-read.
      apply(normalize(items[STORAGE_KEY]));
    });
  }

  function start() {
    readAndApply();

    // Teams replaces list content constantly; rescan when it settles. Attribute
    // changes on <html> are watched separately so our own flags survive.
    new MutationObserver(scheduleRescan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    new MutationObserver(() => {
      if (!current) return;
      const html = document.documentElement;
      const missing = FEATURES.some(
        (f) => f.attr && current[f.id] && !html.hasAttribute(f.attr)
      );
      if (missing) apply(current);
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: FEATURES.filter((f) => f.attr).map((f) => f.attr)
    });

    window.addEventListener('scroll', repositionOverlays, { passive: true });
    window.addEventListener('resize', repositionOverlays);
  }

  // Keep an open tab in sync when toggles change in the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    apply(normalize(changes[STORAGE_KEY].newValue));
  });

  // At document_start the parser may not have created <html> yet, so wait for it
  // rather than reading a null documentElement.
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
