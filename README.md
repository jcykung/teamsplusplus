# Teams++

A Chrome extension (Manifest V3) that turns Microsoft Teams channels into an
inbox. Archive posts like read email, and keep pinned posts one click away.

Everything here applies to a channel's **Posts** area only. Chats, Calendar,
Files, Calls and the rest of Teams are left exactly as Teams draws them.

It uses the same popup, welcome-screen and changelog design as the Better Teacher
Portal and Classroom++ extensions, with Teams++ branding and a purple-and-white
palette that matches Microsoft Teams.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the extension popup and click **Enable on Microsoft Teams**. Chrome asks
   for access to Teams only at that moment — nothing runs before you click.
5. Open <https://teams.microsoft.com>, pick a channel, and use the buttons on each
   post.

The welcome screen opens on first install, and the changelog opens after an update.
Access can be revoked at any time from `chrome://extensions` → **Site access**.

## Features

### Inbox Zero

Every post gets **Archive** and **Pin** buttons in its left margin, which appear
when you hover the post and stay out while it is open. Comments and replies
never get them — only the post
itself can be archived or pinned. The margin they float in is taken out of the
message list's own left edge, not added to it, so no post moves on screen. Archiving hides the post from the channel, just
like moving a read email out of your inbox; an archived post keeps only its
**Unarchive** button, since it is no longer part of the channel view.

- A post carries no tag until you archive it: archiving tags it **archive**
  and unarchiving removes the tag again, so an untagged post is an Inbox post.
  New posts arrive untagged. The Inbox tab shows the untagged posts and the
  Archive tab the archive-tagged ones, so a post is never in both.
- When every post in the channel is archived, the empty space shows confetti and an
  **Inbox Zero!** message.
- **Inbox** and **Archive** sit in the channel tab bar in place of **Posts**,
  in its style: the Posts tab leaves the layout and the tabs beside it slide over
  by the width the pair needs, so **Shared**, **Files** and the rest stay put.
  Archive is the Posts list filtered, not a second list: the same posts with
  their tag set. Nothing is re-dressed, and the empty box Teams wrapped a
  filtered-out post in goes with it, so no violet edges or ghost rows are left
  behind. Posts carry an **Unarchive** button showing a white archive box in a
  filled purple circle, the same filled treatment a pinned post's pin gets.
- Hovering the space between two posts draws a purple line, never wider than a
  post, with a centred **Archive all older posts** button. The two posts either
  side of the line are compared by the date and time they show — not by where
  they sit — and everything on the older side is archived in one click, so it is
  right whether the channel lists newest-first or oldest-first, and after you
  flip that in Teams' settings. The posts slide to the right and fade as they go
  rather than vanishing.
- If there is nothing archived yet, the Archive tab says so instead of looking
  broken, and it leaves the channel's list exactly as Teams laid it out. Hiding
  every post in a virtualised list gives it no height, so it decides it has been
  scrolled to the end and fetches the channel's whole history; keeping the list
  in place is what stops an empty Archive from paging through every old post.
- The tabs carry no count: a number could only ever count the posts Teams has
  mounted right now, so it would move on its own as the list virtualises.
- Clicking either tab also asks Teams for the Posts panel, so both of them still
  work after you have visited Shared, Calendar or another channel tab.

### Compact posts

On by default. Every post is drawn as a card you can browse: the author's
picture in a circle, their name and the time, the post's opening line as a big
bold headline, and the first two lines of the words under it. A chevron sits on
the right, so the card reads as something that opens.

The card keeps everything else out of the fold — the reply thread, reactions,
Teams' own hover toolbar, images, videos and attachments — so a channel becomes a
list of headlines instead of a wall of detail. Teams' own post is still there,
behind the card, untouched.

Hovering fills the card with Teams purple the way a filled button reads, and
clicking it opens the post to its full height, handed straight back to Teams'
own layout, replies and all; clicking it again folds it back. A channel that
showed two posts now shows a dozen, which is the usual complaint about Teams'
post list.

Light and dark are both the card's own: white with dark type in light mode, a
soft charcoal with near-white type in dark. The theme is read from the page — a
theme attribute or class Teams leaves on `<html>`, or the colour actually
painted behind the posts, with the desktop setting only as a last resort — so the
card matches Teams even when the desktop is set the other way, and it repaints
the moment Teams switches.

A folded post keeps the signals that tell you where to start reading: Teams' own
**New** badge rides on the card, and the **Last read** divider closes the post
that was last read — under its card, in Teams' own style.

The switch lives in the popup and writes one synced preference, so it applies to
every Teams tab and every signed-in Chrome profile.

### Pinned posts

Pinned posts sit at the very top of the channel pane, above the **Post in
channel** box (and at the top even when the composer is docked at the bottom),
in the page flow, so they take space rather than covering the composer or the
channel tabs.

- Each pin is a purple bar reading `Author: subject` and the start of the post;
  clicking it eases the channel to the post and flashes it, rather than cutting
  straight to it, so the move is visible and the eye follows it.
  The post is never moved, copied or re-parented, so replies, reactions, the
  reply box, **see more** and every menu Teams portals out (emoji, formats,
  attachments) are Teams' own and work exactly as they do in the stream.
- A pinned post stays in the channel where it was posted — the bar is a shortcut
  to it, not a second copy of it — so unpinning only takes the bar away.
- Pins belong to the channel they were made in. The bars show this channel's
  pins only, and each channel keeps its own list in `chrome.storage.sync` under
  its path, so pinning in Biology 101 leaves Biology 202 with none. Pins made
  before this change named no channel and are adopted by the channel the user is
  in when the update runs.
- Every pin keeps a copy of the post's words from the moment it is pinned. Teams
  stops holding old posts, so when the search reaches the end of the channel's
  history without finding one, the bar opens that copy in a read-only card
  instead of an apology — a pin always has something to show.
- A pinned post is never archived, by the button or by **Archive all older
  posts**: its Archive button is inert and says so, and the pin is taken down
  first. That is what keeps a bar from pointing at a post that is hidden.
- Teams only keeps the posts it has rendered, so an old pin is often not in the
  page at all. Clicking its bar walks the message list back through its history,
  pushing at the top of the list to make Teams fetch each older batch, and waits
  for the list to actually grow before moving on — so a post dozens of batches
  back is still found, then scrolled to and flashed. A **Stop searching** button
  sits at the bottom of the page while it runs, and stopping puts the channel
  back where it was. If the post has gone from the channel entirely, the list is
  restored and a message says so.
- Each bar carries its own unpin button on its left, so a pin is taken down from
  the bar in one click rather than by finding the post first.
- Posts pinned for everyone by a channel moderator sit first, then the ones you
  pinned yourself.
- A pin belongs to the channel when Teams lists it in the **Pinned** accordion
  under "In this channel". Such a pin gets no controls at all for a user Teams
  does not let pin there; someone who may pin gets **Unpin for everyone**, which
  uses Teams' own unpin control.
- A pin whose post Teams has not loaded still shows its author and the words
  kept with the pin, and clicking it starts the same walk back through the
  channel.
- Multiple pins stack vertically; the stack scrolls if it gets tall.
- Every post also has a **Pin** button — a filled white pin on Teams purple while
  pinned, an outline while not — so anyone can keep a post at the top.
- Status messages (archived, unarchived, pins) are a larger translucent card
  centred on the post they are about, so the news appears where the change
  happened. With no single post involved they sit in the middle of the list.

All three features are independent switches in the popup. Archive state, pins and the
current view are stored in `chrome.storage.sync`, so they follow the user to every
Chrome profile signed in with the same account.

## Layout

```
manifest.json            MV3 manifest: optional Teams host access, storage/scripting,
                         popup, and no statically injected content script
background.js            Owns the optional permission. Registers the content script
                         after Enable, unregisters it if access is revoked, opens the
                         welcome screen on install and the changelog on update
onboarding.html          Welcome screen shown on first install
onboarding.js            Requests Teams access, opens Teams, the changelog and Ko-fi
changelog.html           Timeline of what changed in each version
changelog.js             Links the changelog back to the welcome screen
src/shared/features.js   Feature registry + sync-storage keys and helpers
src/content/selectors.js DOM anchors (message rows, bodies, authors, pins)
src/content/content.js   Archive/pin buttons, Inbox/Archive tabs, gaps, pinned bars
src/content/teams.css    All injected UI, gated by data-tpp-* on <html>
src/popup/               Popup markup, styling and access/switch logic
icons/icon*.png          Extension icons — the files manifest.json points at
icons/teamsplusplus.png              Source artwork (1254×1254, white background)
icons/teamsplusplus-transparent.png   Same artwork with the background knocked out
```

Regenerate the icon sizes after replacing the source artwork (macOS `sips`). Resize
from the transparent file so the icons keep their cut-out background:

```bash
for size in 16 32 48 128; do
  sips -z "$size" "$size" icons/teamsplusplus-transparent.png --out "icons/icon${size}.png"
done
```

## How it works

- Chrome grants no Teams host permission at install. The content script is registered
  dynamically with `chrome.scripting.registerContentScripts` only after the user
  clicks Enable, and is removed again if access is revoked.
- Teams re-renders its message list constantly, so the content script runs one
  debounced scan (300 ms) after DOM changes. The scan finds the outermost message
  rows, tags them with `data-tpp-id`, and repairs buttons, hidden posts and overlays.
- Posts are identified by Teams' `data-mid` / `data-message-id` / `data-item-id`
  when available, otherwise by a stable hash of the post text and timestamp.
- Archived posts are hidden with CSS (`display: none`) rather than removed, so Teams
  keeps rendering the thread and replies are still detected.
- Reply counts are read from Teams' "N replies" text. If Teams changes that wording,
  update `replyCount()` in `src/content/content.js`.
- The UI is anchored to the message list with fixed positioning, recalculated on
  resize and scroll. It never rewrites Teams' own markup beyond adding classes and
  buttons.

## Adding a feature switch

1. **Register it** in `src/shared/features.js`:

   ```js
   {
     id: 'hideMeetingBar',
     attr: 'data-tpp-hide-meeting-bar',
     label: 'Hide the meeting bar',
     hint: 'Removes the bar shown during a call.',
     default: false
   }
   ```

2. **Style it** in `src/content/teams.css`, gated on the attribute:

   ```css
   html[data-tpp-hide-meeting-bar] [data-tid='meeting-bar'] {
     display: none !important;
   }
   ```

3. If it needs DOM work, add it to the scan in `src/content/content.js`.

The popup is generated from the registry, so it needs no changes.

## Verifying selectors after a Teams update

Teams' hashed class names change between releases, so everything is keyed off
`data-tid` attributes, ARIA labels and roles. If something stops working, inspect the
element in DevTools and check these in order:

1. `src/content/selectors.js` — the candidate lists, most likely fix.
2. `replyCount()` and `isNativePinned()` in `src/content/content.js` if reply counts
   or moderator pins are no longer detected.

To list every anchor Teams exposes on a page, run this in DevTools:

```js
[...document.querySelectorAll('[data-tid]')].map((el) => el.dataset.tid);
```

## Known limits

- Teams does not expose a public API for pinned posts. Moderator pins are detected
  from the pin indicator on a post, and from Teams' pinned-messages pane while it is
  open. If Teams renders neither, the post will not get a bar automatically; the Pin
  button always works.
- Reply counts are read from visible "N replies" text. A thread whose replies are only
  reachable through a separate pane may show zero, in which case a reply still
  un-archives it as soon as Teams shows a count.
- The archive and pin maps are capped (150 posts and 40 pins) and trimmed if Chrome
  Sync's per-item quota is reached. The newest entries are kept.
- Archived posts are hidden per channel by post id, not per Teams account. Because
  the data lives in Chrome Sync, a different signed-in Chrome profile sees the same
  archive only if Chrome Sync is enabled for the extension.
