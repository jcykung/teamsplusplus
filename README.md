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
second click; clicking the open post folds it back, and **Escape** does too.
Only one post is open at a time — opening another closes the one before it, and
the post that opens is scrolled up to the top of the list so it reads from its
first line; closing it again brings the condensed card back to the top too.
Selecting a post's text — dragging over it, or double-clicking a word — leaves
the post open so the words can be copied. A channel that showed
two posts now shows a dozen, which is the usual complaint about Teams' post
list.

Light and dark are both the card's own: white with dark type in light mode, a
soft charcoal with near-white type in dark. The theme is read from the page — a
theme attribute or class Teams leaves on `<html>`, or the colour actually
painted behind the posts, with the desktop setting only as a last resort — so the
card matches Teams even when the desktop is set the other way, and it repaints
the moment Teams switches.

A post that Teams marks **New** wears a bright purple border and a mark beside
the time, so what still waits for you stands out at a glance. There are two
words on that mark, because there are two different things: a post you have not
opened yet says **Unread**, and one you have opened that has since been answered
or reacted to says **Updated**, with what it gained — "2 new replies and 1 new
reaction since you read it" — in the mark's tooltip. The badge is the arrival
signal, not the whole rule: the first sighting is written down and the mark stays
until you open the card, so Teams clearing its own badge does not quietly mark a
post read.

The posts are also split by day. A line in a lighter purple carries the date in
the middle of it: **Today**, **Yesterday**, then the day's name, drawn from the
stamps on the posts themselves. In the default view the line sits above the
first post of each day, so every run starts with its date; with new posts at the
bottom it closes the day above it. The date also holds, as wide as the posts,
naming the day at the edge you are reading from — the top of the list, or the
bottom when new posts arrive there — and moves on when that day's line arrives.
It stands on the colour behind it, so the posts scrolling under it cannot be
read through it; where the pane leaves an empty strip above the list, the date
is drawn there instead. The line is drawn whether the posts are compact cards or
Teams' own, so the two switches work apart from each other.

A post answered today sits in today's run. The line follows the newest activity
Teams prints on the row — the post's own time, or a newer reply's — so a post
lifted back up by a reply is filed under the day it came back rather than the
day it was written.

Opening a card marks a post read. Closing it again does not. The mark and the
purple border go the moment the card is opened — and because the read is written
to sync storage straight away, the same post clears on the other browsers signed
in to the same profile. That is the browser's own sync service at work — Chrome
signed in to the same account on another computer — and it does not reach a
different browser, such as Brave or Dia, each of which keeps its own marks.
Teams' lingering New badge is ignored; what brings the mark back is the post
itself moving on. A post that has been answered or reacted
to since you read it wears the mark again, as **Updated**, naming in its tooltip
what arrived while it was folded.

Changing channel folds whatever was open. A channel is always entered as a list of
cards, the way it looked before any of them was opened, so a post you were
reading in one channel does not come back open the next time you visit it.

Teams' own **Mark as unread** is left to Teams. It brings the badge back on that
post and on the newer ones in the channel, and the cards do not change: a post
read here stays read, on every signed-in browser, because a mark put back that
way carries no reply or reaction behind it. Only real activity reopens a post,
which is what makes an **Updated** one different. Opening a card is still the
only thing that clears a mark, and closing it again does not restore one.

The Compact posts and Date lines switches live in the popup, and their settings
are stored in `chrome.storage.sync`, so they follow the user to every Chrome
profile signed in with the same account.

## Privacy and security

Teams++ is built so that there is nothing to leak:

- **Nothing leaves the browser.** The extension makes no network requests of its
  own — no analytics, no telemetry, no error reporting, no fonts, no remote code.
  The only URLs it opens are the Teams site itself and the optional Ko-fi page.
- **Page content is read locally.** Post text, author names and timestamps are
  read from the page that is already open, used to draw the cards, and kept in
  the browser. None of it is sent anywhere, logged or shared.
- **Storage is settings and marks, not content.** `chrome.storage.sync` holds the
  feature switches, the view, and post ids with an activity token and a
  read/unread mark — no message text, no author names, no attachments. Local
  storage holds only fingerprints derived from the page.
- **Access is optional and revocable.** No Teams host access is granted at
  install. The content script is registered with `chrome.scripting` only after the
  user clicks **Enable on Microsoft Teams**, and it is unregistered again if the
  user revokes access in Chrome.
- **Least privilege.** The manifest asks for `storage` and `scripting` and the
  three Teams web origins as *optional* host permissions. There is no `tabs`,
  `cookies`, `identity` or `<all_urls>` request, and no statically injected
  content script.
- **No remote code.** All JavaScript ships in the package; the extension-page CSP
  is `script-src 'self'; object-src 'self'`.

The full policy is in [PRIVACY.md](PRIVACY.md).

Teams++ is an independent project. It is not affiliated with, endorsed by, or
sponsored by Microsoft, and Microsoft Teams is a trademark of Microsoft
Corporation.

## Publishing to the Chrome Web Store

The listing copy, the answers to every field in the Chrome Web Store item form
(single purpose, permission justifications, remote-code statement, data-usage
disclosures) and a pre-submission checklist live in
[STORE-LISTING.md](STORE-LISTING.md).

Build the upload zip from the repository root, excluding development files:

```bash
zip -r teamsplusplus.zip . \
  -x '.git/*' '.freebuff/*' '*.md' '.gitattributes' '.gitignore' 'icons/teamsplusplus*'
```

## Layout

```
manifest.json            MV3 manifest: optional Teams host access, storage/scripting,
                         popup, and no statically injected content script
background.js            Owns the optional permission. Registers the content script
                         after Enable, unregisters it if access is revoked, opens the
                         welcome screen on install and the changelog on update
onboarding.html          Welcome screen shown on first install
onboarding.js            Requests Teams access, opens Teams, the changelog and Ko-fi
PRIVACY.md               Privacy policy, ready to publish
STORE-LISTING.md         Chrome Web Store copy and form answers
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
