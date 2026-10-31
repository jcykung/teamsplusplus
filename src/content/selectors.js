/**
 * DOM anchors used by the content script.
 *
 * Teams ships hashed class names that change between releases, so everything
 * here is keyed off `data-tid` attributes, ARIA labels and roles instead. Each
 * entry is a list of candidates tried in order; edit these if a feature stops
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

    /** A single post row. Nested matches are collapsed to the outermost row. */
    messageRow: [
      '[data-tid="chat-pane-message"]',
      '[data-tid="message-pane-list-message"]',
      '[data-tid="message-pane-list-message-body"]',
      '[data-tid="message-body"]'
    ],

    /** Text containers. Used to read the post and to avoid UI false positives. */
    messageBody: [
      '[data-tid="message-body"]',
      '[data-tid="messageBodyContent"]',
      '[data-tid="message-body-content"]'
    ],

    /** Author name, shown before the preview in a pinned bar. */
    messageAuthor: [
      '[data-tid="message-author"]',
      '[data-tid*="message-author" i]',
      '[data-tid*="author" i]'
    ],

    /** Teams' own pinned-messages pane, when the user has it open. */
    pinnedPane: [
      '[data-tid="pinned-messages-pane"]',
      '[data-tid="channel-pane-pinned-messages"]',
      '[data-tid="chat-pane-pinned-messages"]',
      '[aria-label*="Pinned messages" i][role="region"]',
      '[aria-label*="Pinned messages" i][role="dialog"]'
    ],

    /** A marker inside a post row that means Teams itself has pinned it. */
    nativePin: [
      '[data-tid="pinned-message"]',
      '[data-tid="message-pinned"]',
      '[data-tid*="pinned" i]',
      '[data-tid="pin"]',
      '[data-tid*="pin-indicator" i]',
      '[aria-label*="pinned" i]',
      '[title*="pinned" i]'
    ],

    /** Teams' own "unpin" control inside a post, when it is rendered. */
    unpinControl: [
      '[data-tid*="unpin" i]',
      '[aria-label*="unpin" i]',
      '[title*="unpin" i]'
    ]
  };

  root.TeamsPlusPlusSelectors = SELECTORS;
})(globalThis);
