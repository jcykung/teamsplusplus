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

Every post is **read** or **unread**, and gets an **Archive** button in its left
margin, which appears when you hover the post and stays out while it is open.
Comments and replies never get it — only the post itself can be filed. The margin
it floats in is taken out of the message list's own left edge, not added to it,
so no post moves on screen. Archiving marks the post read
and takes it out of the channel view, just like moving a read email out of your
inbox; a read post keeps only its **Unarchive** button, which marks it unread and
brings it back.

- Read state is Teams++'s own, not Teams'. The moment the extension is
  installed is stored once, and every post Teams stamps after that moment starts
  in the Inbox; everything already in the channel is read, so it is in the
  Archive from the first visit. That is the whole rule — no badge to race, no
  divider to misread.
- From then on only the buttons change a post: **Archive** marks it read,
  **Unarchive** marks it unread. A post is never in both tabs.
- When every loaded post is read — an empty Inbox — the space says **Inbox
  Zero!** and points at the Archive, rather than looking like a broken list.
- **Inbox** and **Archive** sit in the channel tab bar in place of **Posts**,
  in its style: the Posts tab leaves the layout and the tabs beside it slide over
  by the width the pair needs, so **Shared**, **Files** and the rest stay put.
  Archive is the Posts list filtered, not a second list: the same posts, read or
  unread. Nothing is re-dressed, and the empty box Teams wrapped a filtered-out
  post in goes with it, so no violet edges or ghost rows are left behind. Read
  posts carry an **Unarchive** button showing a white archive box in a filled
  purple circle.
- A post you archive slides to the right and fades as it leaves the Inbox rather
  than vanishing, so the eye sees where it went. Unarchiving sends it the other
  way — left and out of sight — and the space it held closes up behind it.
- The Inbox ends at its last post: scrolling is held to the last post on screen
  rather than carrying on into blank space. A tab whose posts fit does not scroll
  at all: the room after the last post is sized to fill the pane exactly, so there
  is no scroll range — nothing is locked and nothing is pulled back, which is what
  rubber-banded — and a tab whose posts need more room simply scrolls.
- Posts sit together with no gaps, in the order Teams posted them: a post the
  view hides is closed up and takes no room at all, so each tab is one unbroken
  run starting at the top of the list. The room after the last row is only a
  top-up — enough to fill the pane with the posts on show, never more — so a
  nearly empty Inbox never looks like it has run out (which is what stops Teams
  topping it up with the channel's history) and a short tab never has blank space
  to scroll into.
  A tab with no post on show at all (an emptied Inbox) is the exception: nothing
  is collapsed there, the list is left exactly as Teams laid it out and taken
  out of sight, and the empty state speaks for it.
- If nothing is read yet, the Archive tab says so instead of looking
  broken, and it leaves the channel's list exactly as Teams laid it out. Hiding
  every post in a virtualised list gives it no height, so it decides it has been
  scrolled to the end and fetches the channel's whole history; keeping the list
  in place is what stops an empty Archive from paging through every old post.
- The tabs carry no count: a number could only ever count the posts Teams has
  mounted right now, so it would move on its own as the list virtualises.
- Clicking either tab also asks Teams for the Posts panel, so both of them still
  work after you have visited Shared, Calendar or another channel tab. That panel
  is Teams' to re-render, so a thin bar crosses the top of the list while the
  posts for the chosen view are still arriving, and leaves as soon as they are
  there — the click is never answered with a blank area and no explanation.
- A view that is still arriving is re-scanned every 200 ms for a couple of
  seconds, so its posts and their condensed cards appear as soon as Teams renders
  them rather than waiting for the next unrelated change to the page.

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
own layout, replies and all. The same click makes the post the message Teams'
own keyboard shortcuts act on, so they work straight away rather than after a
second click; clicking the open post folds it back, and **Escape** does too. A
channel that showed two posts now shows a dozen, which is the usual complaint
about Teams' post list.

Light and dark are both the card's own: white with dark type in light mode, a
soft charcoal with near-white type in dark. The theme is read from the page — a
theme attribute or class Teams leaves on `<html>`, or the colour actually
painted behind the posts, with the desktop setting only as a last resort — so the
card matches Teams even when the desktop is set the other way, and it repaints
the moment Teams switches.

The card drops Teams' own **New** badge and **Last read** line on purpose: with
an Inbox and an Archive, the tabs already say what is read, so a post is just
name, time, headline and two lines.

The switch lives in the popup and writes one synced preference, so it applies to
every Teams tab and every signed-in Chrome profile.

### Pinned posts

Pinned posts sit at the very top of the channel pane, just under the Inbox /
Archive tabs, floating over the list rather than living in it. Teams' list is a
scroll box, so a bar placed inside it scrolls away the moment the Inbox opens on
the newest post; anchored to the list's top edge it stays put, and the list
reserves a matching padding so the first post is never covered.

- Only posts a channel moderator has pinned **for everyone** get a bar. Teams++
  adds no pin of its own: there is no Pin button on a post, no saved copy, and
  nothing of ours to keep in step with Teams.
- Each pin is a purple bar reading `Author: subject` and the start of the post.
- Clicking a bar opens the post in the channel: the card unfolds, the list lines
  the post up with the top of the scroll area so it reads from its first line
  down, and the post takes the keyboard so Teams' shortcuts act on it. If the
  post is not loaded yet, the channel is searched the long way (below).
- A pinned post stays in the channel where it was posted — the bar is a shortcut
  to it, not a second copy of it.
- The post is never moved or re-parented, so replies, reactions, the reply box,
  **see more** and every menu Teams portals out (emoji, formats, attachments)
  are Teams' own and work exactly as they do in the stream.
- Bars belong to the channel they were read in: Teams lists a channel's pins per
  channel, and nothing about them is stored by the extension.
- A pinned post in the Inbox has no Archive button until it is unpinned, because
  a bar must never point at a post hidden in the Archive. In the Archive the same
  post is simply a filed post and can be unarchived.
- Teams only keeps the posts it has rendered, so an old pin is often not in the
  page at all. When there is no sidebar item to hand to, clicking a bar walks the
  message list back through its history, pushing at the top of the list to make
  Teams fetch each older batch, and waits for the list to actually grow before  moving on — so a post dozens of batches back is still found, then opened. A
  **Stop searching** button sits at the bottom of the page while it runs, and
  stopping puts the channel back where it was.
- Each bar carries its own unpin button on its left when Teams lets this user pin
  in the channel; it uses Teams' own unpin control. Without that control the bar
  has no button, since Teams would refuse the request.
- A pin whose post has not loaded yet still shows its author and the post's
  wording, and clicking it opens the same Teams item once the list catches up.
- Multiple pins stack vertically; the stack scrolls if it gets tall.
- Status messages (archived, unarchived, pins) are a larger translucent card in
  the middle of the posts, so an action always reports itself in the same place.

All three features are independent switches in the popup. Archive state and the
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
src/content/content.js   Archive button, Inbox/Archive tabs, gaps, pinned bars
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
- A post the current view filters out is closed up: no height, no margins, no
  room in the list, so the posts on show form one unbroken run in Teams' own
  order. Nothing is measured and nothing is compensated — that is deliberate. An
  earlier build handed the hidden posts' height back to the list as padding, and
  because that total was recomputed on every scan it moved the posts as it
  changed. Instead a block of room sits after the last row (`data-tpp-room`, set
  by `markRoom` on the box that holds the rows — Teams measures that box, not the
  scrolling element, which is why padding on the scroller only produced a
  scrollbar and no end to the paging): a list emptied by the filter would
  otherwise send it paging through the channel's whole history. Its size is a
  top-up, `clientHeight - shown`, computed in `clampScroll` from the posts on
  show, so it fills the pane and stops: a short tab has no scroll range at all,
  and because only the posts on show feed it, a hidden batch arriving cannot
  change it. A view with no post on show skips the collapse altogether and sets
  `data-tpp-empty-view`, which hides the list: an all-collapsed pane is what
  Teams kept re-measuring, with the posts jumping while it did.
- The collapse also runs outside the scan: a MutationObserver callback fires
  before the browser paints, so `absorbNodes` gives a freshly inserted read post
  its id and its tucked mark right there. Otherwise a fetched batch painted at
  full height and collapsed 300ms later, and the list appeared to leap for every
  batch — on first load, and on every hover that made Teams re-render rows.
- Because the filtered list is still taller than what is on show, the scroll is
  clamped to the last post the current view displays (`clampScroll`). Otherwise
  a wheel carried the view into the blank space where hidden posts sit, and
  every one of those positions asked Teams for older posts, which arrived and
  were hidden again. A pin search is exempt: it walks the list through its
  history on purpose.
- Read state comes from one synced timestamp: the moment the extension was
  installed. A post stamped later is unread and waits in the Inbox; anything
  older is read. Teams' unread badge and Last read divider are not consulted at
  all — they clear themselves when a channel opens, which is what once swept a
  whole channel into the Inbox in one scan.
- Only the Archive and Unarchive buttons write per-post state, a small synced
  map, so a channel's history costs no storage and nothing is ever re-decided.
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
  from the pin indicator on a post, and from Teams' own **Pinned** list under "In
  this channel". If Teams renders neither, the post gets no bar — Teams++ does not
  pin anything itself.
- Reply counts are read from visible "N replies" text. A thread whose replies are only
  reachable through a separate pane may show zero, in which case a reply still
  un-archives it as soon as Teams shows a count.
- Read/unread decisions are capped (240 posts) and trimmed if Chrome Sync's
  per-item quota is reached. The newest entries are kept, so a channel with more
  than 240 posts unread at once would file the oldest of them as read.
- Archived posts are hidden per channel by post id, not per Teams account. Because
  the data lives in Chrome Sync, a different signed-in Chrome profile sees the same
  archive only if Chrome Sync is enabled for the extension.
