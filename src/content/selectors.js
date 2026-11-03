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

    /**
     * A single post row. Nested matches are collapsed to the outermost row, so
     * an id-bearing message container wins over the body inside it.
     */
    messageRow: [
      '[data-tid="post-message"]',
      '[data-tid="chat-pane-message"]',
      '[data-tid="channel-pane-message"]',
      '[data-tid="message-pane-list-message"]',
      '[data-tid="message-pane-list-message-body"]',
      '[data-mid]',
      '[data-message-id]',
      '[data-tid="message-body"]'
    ],

    /**
     * Teams' own shimmer placeholders while it fetches more posts: a blank
     * avatar and grey text bars. Never a post, and taken out of the layout on a
     * filtered view (markLoadingRows in content.js).
     */
    loadingRow: [
      '[data-tid*="skeleton" i]',
      '[data-tid*="loading" i]',
      '[data-tid*="placeholder" i]',
      '[data-tid*="spinner" i]',
      '[data-tid*="progress" i]',
      '[aria-label*="loading" i]',
      '[role="progressbar"]',
      '[class*="skeleton" i]',
      '[class*="spinner" i]'
    ],

    /**
     * Header markers, one per post. Teams renders `post-message-subheader` for a
     * post and a different prefix (`comment-message-*`) for comments, so the
     * first selector below is what tells a post container from everything else.
     * The post container itself carries no stable attribute, so it is found by
     * climbing from this marker (see headerRows in content.js).
     */
    postHeader: ['[data-tid="post-message-subheader"]'],

    /** Text containers. Used to read the post and to avoid UI false positives. */
    messageBody: [
      '[data-tid="post-message-body"]',
      '[data-tid="message-body"]',
      '[data-tid="messageBodyContent"]',
      '[data-tid="message-body-content"]',
      '[id^="content-"]'
    ],

    /** Author name, shown before the preview in a pinned bar. */
    messageAuthor: [
      '[id^="author-"]',
      '[data-tid="post-message-author"]',
      '[data-tid="message-author"]',
      '[data-tid*="message-author" i]',
      '[data-tid*="author" i]'
    ],

    /**
     * The time Teams shows beside a post's author. In the compact view it comes
     * out of the header, which is the part that made the header wrap onto a
     * second line; the name and the subject keep the line.
     */
    messageTime: [
      '[id^="timestamp-"]',
      'time',
      '[data-tid*="timestamp" i]',
      '[data-tid*="message-time" i]',
      '[data-tid*="created" i]'
    ],

    /**
     * The picture Teams draws for a post's author. The compact card shows it at
     * the top of the card, so it is read from the post rather than guessed. It
     * may be an <img> or a painted background; either is used.
     */
    messageAvatar: [
      '[data-tid*="avatar" i]',
      '[data-tid*="profile-picture" i]',
      '[data-tid*="profilephoto" i]',
      '[class*="fui-Avatar" i]',
      '[class*="persona" i] img',
      'img[alt*="avatar" i]',
      '[aria-label*="profile picture" i]'
    ],

    /**
     * A post's subject, when Teams renders one beside the author. Posts without
     * one fall back to the first line of the text, which is where a channel post
     * usually puts its headline anyway.
     */
    messageSubject: [
      '[id^="subject-"]',
      '[data-tid="post-message-subject"]',
      '[data-tid*="post-subject" i]'
    ],

    /**
     * Ancestors that mean a row is a comment or a reply rather than a post.
     * Only posts get archive/pin buttons, so matches here are skipped. Teams
     * prefixes comment markup with `comment-message-*`, which the second entry
     * catches; the generic `comment` one covers the rest of its variants.
     */
    commentRoot: [
      '[data-tid*="comment" i]',
      '[data-tid*="reply" i]',
      '[data-tid*="thread-response" i]',
      '[class*="replyContainer" i]',
      '[aria-label*="replies" i][role="list"]'
    ],

    /** Teams' own "Post in channel" box; the pinned bars sit just above it. */
    newPostBox: [
      '[data-tid="post-compose-collapsed"]',
      '[data-tid="post-compose-collapsed-renderer"]',
      '[data-tid="compose-start-new-draft"]',
      '[data-tid*="post-compose" i]',
      '[data-tid="channel-pane-new-post"]',
      '[data-tid*="new-post" i]',
      '[data-tid*="post-in-channel" i]',
      '[data-tid*="channel-compose" i]',
      '[contenteditable="true"][aria-label*="Post in channel" i]',
      '[contenteditable="true"][data-tid*="compose" i]',
      '[placeholder*="Post in channel" i]'
    ],

    /**
     * Teams' own list of pinned posts: the "Pinned" accordion in the "In this
     * channel" sidebar, or a pinned-messages pane. A post listed here is pinned
     * for the whole channel (a moderator's pin), which is what makes its bar
     * unpinnable for a regular user.
     */
    pinnedPane: [
      '[data-tid="channel-info-pane-pinned-posts-list"]',
      '[aria-label="Pinned post list" i]',
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
