# Teams++

A Chrome extension (Manifest V3) that turns Microsoft Teams channels into an
inbox. Archive posts like read email, and keep pinned posts one click away.

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

Every post gets an **Archive** button at the top. Archiving hides the post from the
channel, just like moving a read email out of your inbox.

- A post comes back automatically when someone replies to it. Teams++ remembers how
  many replies the thread had when you archived it, and un-hides it when that number
  grows.
- Posts you have not archived always stay visible.
- When every post in the channel is archived, the empty space shows confetti and an
  **Inbox Zero!** message.
- A **Show All Posts** button at the bottom switches to the normal Teams view and
  shows every post. In that view the button becomes **Show Unread Posts** to return
  to Inbox Zero. Archived posts are marked with a violet edge while shown.

### Pinned posts

Pinned posts appear in thin bars at the top of the channel.

- Posts pinned by a channel moderator (Teams' own pins) sit first, in Teams purple.
- Posts you pin yourself sit below them in a lighter violet.
- Multiple pins stack vertically; the stack scrolls if it gets tall.
- Click a bar to jump to the post. Click the crossed-pin icon on a bar to unpin it
  (your own pins are removed immediately; Teams pins use Teams' own unpin control
  when it is available).
- Every post also has a **Pin** button, so anyone can keep a post at the top.

Both features are independent switches in the popup. Archive state, pins and the
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
src/content/content.js   Archive/pin buttons, Inbox Zero, confetti, pinned bars
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
