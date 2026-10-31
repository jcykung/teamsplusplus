# Better Teams

A Chrome extension (Manifest V3) that makes new posts easier to spot in Microsoft Teams
channels. It follows the same shape as the Better Teacher Portal extension: a content
script applies feature toggles to the host page, each toggle is stored in
`chrome.storage.sync`, and a popup exposes the switches.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open <https://teams.microsoft.com>, pick a channel, and click the extension icon to
   toggle tweaks. Changes apply to open tabs without a reload.

## Tweaks

| Toggle | What it does | How it works |
| --- | --- | --- |
| Unread banner | Shows "N new posts" with **Jump to unread** and **Mark as read** above the list | Overlay anchored to the list; reads Teams' own "new messages" separator |
| Sticky date dividers | Pins each day's label to the top while scrolling, with rules either side | Content script tags Teams' date rows; CSS makes them `position: sticky` |
| Separate each post | Offsets avatars and adds spacing plus a hairline between posts | Pure CSS on message rows |
| Red line above unread posts | Bright red rule where new messages begin | CSS on the tagged "new messages" row |
| Floating compose box | Lifts the compose box off the list so posts scroll behind it | Content script tags the composer; CSS makes it sticky with a shadow |
| Pinned messages shortcut | Pin button in the corner of the message pane | Clicks Teams' own pinned-messages control |

## Layout

```
manifest.json            MV3 manifest: content script matches, storage permission, popup
src/shared/features.js   Feature registry — the single source of truth for toggles
src/content/selectors.js DOM anchors (message list, rows, composer, pinned control)
src/content/content.js   Applies state, tags dividers, builds the banner and pin button
src/content/teams.css    One CSS block per feature, gated by an attribute on <html>
src/popup/               Popup markup, styling and checkbox logic
icons/                   icon16 / icon32 / icon48 / icon128, generated from the transparent master
teamsplusplus.png        Source artwork (1254×1254, white background)
teamsplusplus-transparent.png  Same artwork with the background knocked out — the resize source
```

Regenerate the icon sizes after replacing the source artwork (macOS `sips`). Resize from
`teamsplusplus-transparent.png` so the icons keep their transparency:

```bash
for size in 16 32 48 128; do
  sips -z "$size" "$size" teamsplusplus-transparent.png --out "icons/icon${size}.png"
done
```

## Adding a UI tweak

1. **Register it** in `src/shared/features.js`:

   ```js
   {
     id: 'hideMeetingBar',
     attr: 'data-bt-hide-meeting-bar',
     label: 'Hide the meeting bar',
     hint: 'Removes the bar shown during a call.',
     default: false
   }
   ```

2. **Style it** in `src/content/teams.css`, gated on the attribute:

   ```css
   html[data-bt-hide-meeting-bar] [data-tid='meeting-bar'] {
     display: none !important;
   }
   ```

3. If it needs DOM work that CSS can't express, add an `on()` / `off()` pair under
   `CUSTOM` in `src/content/content.js`.

The popup is generated from the registry, so it needs no changes.

## Verifying selectors after a Teams update

Teams' hashed class names change between releases, so everything is keyed off `data-tid`
attributes, ARIA labels and roles. If a tweak stops working, inspect the element in
DevTools and check these in order:

1. `src/content/selectors.js` — the candidate lists, most likely fix.
2. The text matching in `markDividers()` (`src/content/content.js`) if the date or
   "new messages" labels are no longer detected.

To list every anchor Teams exposes on a page, run this in DevTools:

```js
[...document.querySelectorAll('[data-tid]')].map((el) => el.dataset.tid);
```

## Known limits

- Teams does not expose the timestamp of its "new messages" separator in the DOM, so the
  banner counts posts rather than saying "since 7:14 PM".
- **Mark as read** scrolls the list to the newest post, which is what Teams itself uses to
  clear unread state. It does not call a private API.
- The pin button only appears when Teams' own pinned-messages control is present; if it
  is missing, the tweak does nothing rather than opening a panel of its own.
- Divider detection reads row text, so a post whose entire body is just a date could be
  mistaken for a separator. The check skips anything inside a message body.
- Icons in `icons/` are generated from `teamsplusplus-transparent.png`; regenerate with the
  command in the Layout section after replacing the source artwork.
