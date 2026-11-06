# Teams++ Privacy Policy

**Last updated: 4 November 2026**

Teams++ is a Chrome extension that changes how Microsoft Teams on the web draws
a channel's Posts area, showing each post as a compact card. This policy
explains what the extension does with your data. In short: it collects nothing,
transmits nothing, and keeps its few settings and read marks in your own browser.

Teams++ is an independent project. It is not affiliated with, endorsed by, or
sponsored by Microsoft, and Microsoft Teams is a trademark of Microsoft
Corporation.

## What Teams++ does not do

- It does **not** collect, transmit, sell, share or disclose any personal data.
- It makes **no network requests** of its own. There is no analytics, telemetry,
  crash reporting, advertising, tracking pixel, remote configuration or remote
  code.
- It does **not** read your messages to send them anywhere. Post text, author
  names, avatars and timestamps are read from the page that is already open on
  your screen only for as long as it takes to draw the cards, and are never
  stored as text or transmitted.
- It does **not** access your Microsoft account, credentials, cookies, contacts,
  files, calendar, calls or chats. It has no access to any site other than the
  Microsoft Teams web origins listed below.

## What Teams++ stores, and where

Everything is stored in your own browser, under the extension's own storage
keys. Nothing is uploaded to the developer or to any third party.

- **`chrome.storage.sync`** — follows you between Chrome profiles signed in with
  the same Google account, through Chrome's own sync service:
  - feature switches (which parts of Teams++ are on);
  - the selected view (Inbox or Archives);
  - post identifiers with a timestamp, a short fingerprint derived from the
    post's on-screen content, and a read/unread mark;
  - the installation time, used to decide which posts are new.
- **`chrome.storage.local`** — stays on this device:
  - fingerprints of posts taken when they were read or filed, and channel names
    whose unread dot was latched.

These records contain no message text, no author names, no attachments and no
links. They are small, capped, and exist only so the extension can remember
which cards you have already opened. Removing the extension, or clearing its
data from `chrome://extensions`, deletes them.

## Permissions, and why each is needed

- **`storage`** — remember the switches, the view and the read/unread marks
  described above.
- **`scripting`** — register the content script for Teams after you enable it,
  and remove it again if you revoke access.
- **Optional host access to `teams.microsoft.com`, `teams.cloud.microsoft` and
  `teams.live.com`** — required to draw the cards on the Teams page. No site
  access is granted at install time. Chrome asks for Microsoft Teams only when
  you click **Enable on Microsoft Teams**, and you can revoke it at any time
  from `chrome://extensions` → **Site access**. Without it, nothing runs.

The extension does not request access to all sites, tabs, cookies, history,
identity, downloads, clipboard or the microphone and camera.

## Third-party links

The welcome screen, the popup and the changelog contain a link to the developer's
Ko-fi page for optional donations, and links to the changelog and Teams itself.
Opening one of those links is a normal page visit to that site, governed by that
site's own privacy policy. Teams++ does not add any tracking parameters, and no
data about you is passed to those sites.

## Children

Teams++ is a general-purpose tool. It does not collect data from anyone,
including children under 13.

## Changes to this policy

If a future version of Teams++ changes what it stores or transmits, this policy
will be updated before that version is released, and the date at the top of this
page will change.

## Contact

Questions about this policy or the extension:
<https://github.com/jcykung/teamsplusplus/issues>
