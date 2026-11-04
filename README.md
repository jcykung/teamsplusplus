# Teams++

A Chrome extension (Manifest V3) that turns Microsoft Teams channels into a
readable list. Every post becomes a compact card you can open when you want the
rest of it.

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
5. Open <https://teams.microsoft.com> and pick a channel: its posts appear as
   compact cards to browse.

The welcome screen opens on first install, and the changelog opens after an update.
Access can be revoked at any time from `chrome://extensions` → **Site access**.

## Features

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

The card carries Teams' own **New** badge beside the time, so a folded post says
at a glance that it has arrived, and it wears a bright purple border instead of
the usual hairline until it has been read. The same purple marks the channel's
name in the left rail while Teams bolds it for unread activity, so the channel
and its new posts read as one thing. Teams' **Last read** divider closes the last
post you read, so the card copies Teams' own divider into the gap underneath that
post and centres it between the two cards — same line, same wording, same
spacing. Where Teams' divider is already on screen, the copy stands down rather
than double it.

Opening a card is the one thing that marks a post read. Until then it keeps its
**New** badge and purple border, even after Teams clears its own badge when the
channel is opened — Teams' idea of read is not the one this view follows. Opening
a post that has moved on since you last read it brings the markers back, so a
reply, a reaction, a new attachment or an edit puts the card back in view.

### Manually mark as read

On by default. A post Teams marks **New** keeps its badge and purple border until
you open its card — Teams clearing its badge when the channel opens does not
count as reading it — so a channel says at a glance what has arrived. Turn the
switch off and the cards follow Teams instead: the badge and purple border show
while Teams marks the post new and clear when Teams marks it read.

Marking a post unread from Teams' own menu brings the badge back the same way,
and it stays until you open the card again — opening the post to reach that menu
is not what clears it.

The Compact posts switch lives in the popup, and its setting is stored in
`chrome.storage.sync`, so it follows the user to every Chrome profile signed in
with the same account.

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
src/content/selectors.js DOM anchors (message rows, bodies, authors)
src/content/content.js   Compact post cards, fold/open behaviour, scan
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
  rows, tags them with `data-tpp-id`, and repairs their cards and fold state.
- Posts are identified by Teams' `data-mid` / `data-message-id` / `data-item-id`
  when available, otherwise by a stable hash of the post text and timestamp.
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

To list every anchor Teams exposes on a page, run this in DevTools:

```js
[...document.querySelectorAll('[data-tid]')].map((el) => el.dataset.tid);
```

## Known limits

- A card is built from the post Teams has rendered. A post Teams has not mounted
  yet gets its card when it does, so a channel that is still loading fills in
  from the top as the posts arrive.
