/**
 * DOM anchors used by the content script.
 *
 * Teams ships hashed class names that change between releases, so everything
 * here is keyed off `data-tid` attributes, ARIA labels and roles instead. Each
 * entry is a list of candidates tried in order; edit these if a tweak stops
 * finding its target after a Teams update.
 *
 * To discover the right value: open Teams, right-click the element, Inspect,
 * then look for `data-tid` on it or a nearby ancestor. Or run this in DevTools:
 *
 *   [...document.querySelectorAll('[data-tid]')].map((el) => el.dataset.tid)
 */
(function (root) {
  'use strict';

  const SELECTORS = {
    /** The scrolling element that holds channel posts. */
    messageList: [
      '[data-tid="message-pane-list-runway"]',
      '[data-tid="message-pane-list-viewport"]',
      '[data-tid="chat-pane-message-list"]',
      '[data-tid="channel-pane-message-list"]',
      'div[role="log"]'
    ],

    /** A single post row. */
    messageRow: [
      '[data-tid="chat-pane-message"]',
      '[data-tid="message-pane-list-message"]',
      '[data-tid="message-body"]'
    ],

    /** The compose box container. */
    composer: [
      '[data-tid="message-pane-compose"]',
      '[data-tid="channel-pane-compose"]',
      '[data-tid="compose-container"]'
    ],

    /** The editable field inside the compose box. */
    composerEditor: [
      '[data-tid="ckeditor"] [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],

    /** Teams' own control for opening pinned posts. */
    pinnedControl: [
      '[data-tid="channel-pane-header-pinned"]',
      '[data-tid="chat-pane-header-pinned"]',
      '[data-tid="channel-pane-header-pinned-messages"]',
      '[aria-label*="Pinned messages" i]',
      '[title*="Pinned messages" i]',
      '[aria-label*="Pinned" i]'
    ],

    /** Text containers to skip when looking for dividers. */
    messageBody: ['[data-tid="message-body"]', '[data-tid="messageBodyContent"]']
  };

  root.BetterTeamsSelectors = SELECTORS;
})(globalThis);
