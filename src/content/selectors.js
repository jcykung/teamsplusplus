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
      '[data-tid*="shimmer" i]',
      '[data-tid*="spinner" i]',
      '[data-tid*="progress" i]',
      '[aria-label*="loading" i]',
      '[role="progressbar"]',
      '[class*="skeleton" i]',
      '[class*="shimmer" i]',
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

    /** Author name, shown on a folded post's card. */
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
      '[data-tid="subject-line"]',
      '[id^="subject-"]',
      '[data-tid="post-message-subject"]',
      '[data-tid*="subject-line" i]',
      '[data-tid*="post-subject" i]'
    ],

    /**
     * The "N replies" text on a post. A thread's count is printed on the post
     * itself, so an archived post whose thread has grown can be spotted without
     * its replies being rendered (replyCountOf in content.js).
     */
    replyCount: [
      '[data-tid*="reply-count" i]',
      '[data-tid*="replies-count" i]',
      '[data-tid*="reply-summary" i]',
      '[data-tid*="replies" i]',
      '[aria-label*="replies" i]',
      '[data-tid*="message-footer" i]',
      '[data-tid*="post-footer" i]'
    ],

    /**
     * Teams' own "New" badge on a post — the unread flag the user already reads
     * in Teams. Inbox Zero honours it beside the install clock (newMarkerOf in
     * content.js), so a post Teams marks goes to the Inbox and is kept there.
     */
    unreadMarker: [
      '[data-tid="new-message-badge"]',
      '[data-tid*="new-message-status" i]',
      '[data-tid*="unread" i]',
      '[aria-label*="unread" i]'
    ],

    /**
     * Teams' own "New" badge on a post, when it renders one. The folded card
     * carries this so an unread post still says so while Teams' row is hidden.
     */
    newBadge: [
      '[data-tid="new-message-badge"]',
      '[data-tid*="new-message-status" i]'
    ],


    /**
     * A channel row in Teams' left rail. Teams signals unread posts by bolding
     * the channel's name, and a computed font weight cannot be selected in CSS,
     * so paintChannelRail (content.js) reads the weight and marks the name.
     *
     * The current rail gives its rows no `data-tid` at all, so the role is what
     * finds them: rows are treeitems, with the channel rows nested inside group
     * treeitems. The last entry is the one that actually matches there — the
     * data-tid entries are kept for builds that still print them.
     */
    channelItem: [
      '[data-tid="channel-list-item"]',
      '[data-tid*="channel-list-item" i]',
      '[data-tid*="channelListItem" i]',
      '[role="treeitem"][data-tid*="channel" i]',
      '[role="treeitem"]'
    ],

    /** The name element inside a channel row, when Teams gives it a name. */
    channelName: [
      '[data-tid*="channel-name" i]',
      '[data-tid*="channelName" i]',
      '[data-tid*="channel-title" i]'
    ],

    /**
     * Ancestors that mean a row is a comment or a reply rather than a post.
     * Only posts get an Archive button, so matches here are skipped. Teams
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

    /** Teams' own "Post in channel" box. */
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

  };

  root.TeamsPlusPlusSelectors = SELECTORS;
})(globalThis);
