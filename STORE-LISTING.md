# Chrome Web Store submission pack — Teams++

Everything needed to submit v1.0.7 of Teams++: copy for the listing, answers for
every question in the item form, and the checks a reviewer is likely to make.

The extension collects no data and makes no network requests, which makes the
privacy section simple to answer honestly: **no collection, no transmission.**

---

## 1. Before you submit

- [ ] `manifest.json` version is the version you are uploading (`1.0.7`).
- [ ] The zip contains `manifest.json` at its **root** (not inside a folder).
- [ ] The zip contains no development files: `.git/`, `.freebuff/`, `*.md`,
      `icons/teamsplusplus*.png`.
- [ ] `PRIVACY.md` is published at a public URL (see §6) and the URL is in the
      item form.
- [ ] At least one screenshot (1280×800 or 640×400) is uploaded.
- [ ] The privacy practices questionnaire is filled in (§5) — all "no".
- [ ] The permission justifications in §4 are pasted in.
- [ ] The single purpose in §3 is pasted in.
- [ ] The listing says the extension is not affiliated with Microsoft (§8).

Build the upload zip from the repository root:

```bash
zip -r teamsplusplus.zip . \
  -x '.git/*' '.freebuff/*' '*.md' '.gitattributes' '.gitignore' 'icons/teamsplusplus*'
```

---

## 2. Listing fields

| Field | Value |
| --- | --- |
| Name | `Teams++` |
| Summary (132 chars max) | `Turns Microsoft Teams channel posts into compact, scannable cards with unread marks you control.` |
| Category | Productivity |
| Language | English (United States) |
| Homepage URL | `https://github.com/jcykung/teamsplusplus` |
| Support URL | `https://github.com/jcykung/teamsplusplus/issues` |
| Privacy policy URL | published copy of `PRIVACY.md` (see §6) |

### Detailed description (paste as plain text)

```
Teams++ makes Microsoft Teams channels readable.

Every post in a channel becomes a compact card: the author's picture, their name and the time, the post's opening line as a headline, and the first two lines of the text. Click a card to open the whole post, replies and all; click it again or press Escape to fold it.

The card carries the read state too. A post that has arrived, or one answered since you last read it, wears an Unread badge and a purple border until you open the card. Opening a card is what marks it read — nothing is marked read behind your back. Never miss a new message again!

The popup has two switches, Compact posts and Date lines. The cards print the date in the gaps between one day's posts and the next, hold the date of the day you are reading at the edge you read from, and both can be turned off.

Teams++ only runs in a channel's Posts area on the Teams web app. Chats, Calendar, Files, Calls and the rest of Teams are left exactly as Teams draws them.

PRIVACY: Teams++ collects nothing. It makes no network requests, has no analytics and no remote code. Post text is read from the page on your screen to draw the cards and is never stored or sent. Its settings and read marks live in your own Chrome storage. Access to Microsoft Teams is optional: nothing runs until you click Enable, and you can revoke it at any time from chrome://extensions.

Teams++ is an independent project. It is not affiliated with, endorsed by, or sponsored by Microsoft, and Microsoft Teams is a trademark of Microsoft Corporation.
```

### What's new in this version (paste into the item form)

```
Date lines now belong to the post you are reading. Scrolling through one long
open post used to walk the held date through the days of the posts further down
the channel; the date is now the day of the post under the edge, and it hands
over only when that post's own next day arrives.

The order of a channel is read from the whole run of posts rather than its two
ends, so the day's lines land on the right side of every gap and the date holds
at the edge you read from. A post also keeps the day its newest reply gave it
while Teams re-renders the row.

Compact posts and Date lines are now two independent switches, and the date
lines can be kept with Teams' own posts as well as with the cards. The Manually
mark as read switch is gone: a card keeps its Unread badge until you open it.
```

---

## 3. Single purpose (required field)

Paste this exactly; it must be one narrow purpose:

```
Teams++ has one purpose: to change how the Microsoft Teams web app displays a
channel's list of posts, showing each post as a compact card that can be opened
in place, with a local read/unread mark on each card. Everything it does serves
that one purpose; it adds no unrelated features and works on no other site.
```

If a second field asks how the extension uses the permissions it requests, answer
with §4.

---

## 4. Permission justifications

**`storage`**

```
Saves the extension's own settings (which features are on, the selected view)
and the per-post read/unread marks, so the same cards and marks appear next time
and, through Chrome Sync, on the user's other Chrome profiles. No page content,
message text or personal data is stored.
```

**`scripting`**

```
Used only to register the extension's own content script for the Microsoft Teams
web origins with chrome.scripting.registerContentScripts, after the user clicks
Enable, and to unregister it when access is revoked. No script is injected into
any other site, and no code is loaded from anywhere but the extension package.
```

**Host permission (optional) — `https://teams.microsoft.com/*`,
`https://teams.cloud.microsoft/*`, `https://teams.live.com/*`**

```
Required to read the channel post list on the Microsoft Teams web app and draw
the compact cards over it. The three origins are the same Teams web app at its
current and legacy hostnames; no narrower pattern covers them and no other site
is needed. The permission is requested from the user only when they click
"Enable on Microsoft Teams" in the welcome screen or popup, never at install
time, and is released if they revoke it in Chrome.
```

If the form offers a free-text "anything else the reviewer should know":

```
The extension does nothing until the user grants the optional Teams host
permission. To test: install, click "Enable on Microsoft Teams" on the welcome
screen, open https://teams.microsoft.com, sign in, and open any channel's Posts
tab. Posts appear as cards; clicking a card opens the post.

No data leaves the browser. The extension makes no network requests, contains no
remote code, and its extension-page CSP is script-src 'self'; object-src 'self'.
```

---

## 5. Privacy practices questionnaire

Chrome defines "collect" as transmitting data off the device to a server or third
party. Teams++ does no such thing, so **every data-type answer is "no"**.

| Question | Answer |
| --- | --- |
| Does the extension collect personally identifiable information? | No |
| Health information? | No |
| Financial and payment information? | No |
| Authentication information? | No |
| Personal communications? | No |
| Location? | No |
| Web history? | No |
| User activity? | No |
| Website content? | No |
| Does it sell or transfer data to third parties? | No |
| Is data used or transferred for purposes unrelated to the single purpose? | No |
| Is data used or transferred to determine creditworthiness or for lending? | No |

If the form insists on a justification for the "website content" answer, use:

```
Post text is read locally from the Teams page the user already has open, used
on the device to render the cards, and discarded. It is not stored as text and
is never transmitted off the device, so nothing is collected under Chrome's
definition.
```

Certify the three required statements (not selling data, not using data for
unrelated purposes, not using data for creditworthiness/lending) — all are true.

**Remote code:** answer **"No, I am not using remote code."** All JavaScript ships
in the package; there is no `eval`, no remote script tag, no dynamically loaded
module, and the extension-page CSP is locked to `'self'`.

**Data use / limited use:** no third-party APIs are used, so no additional
limited-use attestation is required beyond the statements above.

---

## 6. Privacy policy URL

Chrome asks for a public URL. Publish `PRIVACY.md` in either of these ways:

1. **GitHub Pages** (recommended) — enable Pages for the repository, then use
   `https://<user>.github.io/teamsplusplus/PRIVACY.html`. GitHub renders Markdown
   from the repo, so `https://<user>.github.io/teamsplusplus/PRIVACY` works once
   Pages is on and Jekyll has built the file.
2. **The repository file itself** —
   `https://github.com/jcykung/teamsplusplus/blob/main/PRIVACY.md`.

Both are public and need no login. Update the "Last updated" date whenever the
storage behaviour changes.

---

## 7. Store assets

| Asset | Requirement | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `icons/icon128.png` |
| Screenshots | 1–5, 1280×800 or 640×400, PNG/JPEG, no transparency | **to capture** |
| Small promo tile | 440×280, optional | not provided |
| Marquee | 1400×560, optional | not provided |

Screenshot suggestions (each 1280×800):

1. A channel with the compact cards and a purple-bordered new post.
2. A card opened to the full post, showing replies.
3. The popup with the switches.
4. The welcome screen.

Capture them from the unpacked build at 1280×800, with Teams in light mode for
the first and dark mode for one of them. Do not include other people's names,
avatars or message text in anything you would not publish; use a test channel.

---

## 8. Trademark and policy notes

- The name, icon and copy use "Microsoft Teams" only to say what the extension
  works with (nominative use). The icon is original artwork — no Microsoft or
  Teams logo — and the listing and welcome screen carry a "not affiliated with
  Microsoft" line.
- Do not use Microsoft's logo, the Teams logo, or Microsoft brand colours as the
  extension's identity in the listing. Purple is used as a UI accent, not as a
  logo.
- If a reviewer rejects the name as implying affiliation, the quickest fix is to
  rename to something descriptive such as **Compact Posts for Teams**; no code
  change is needed beyond `manifest.json`, the popup and the onboarding titles.
- The Ko-fi link is an optional donation link, not a paywall: every feature works
  without it. It is disclosed in the privacy policy.
- The changelog opens once after an update, and the welcome screen once after
  install. Both are extension pages and close with one click.

---

## 9. Reviewer test plan (paste if asked)

1. Install the extension. The welcome screen opens; no site access has been
   granted yet (`chrome://extensions` → Site access shows nothing).
2. Click **Enable on Microsoft Teams** and accept the Chrome prompt. The content
   script registers for the three Teams origins only.
3. Open `https://teams.microsoft.com`, sign in, and open a channel → **Posts**.
   Each post is a compact card; a chevron opens it.
4. Click a card: the post opens in Teams' own layout with replies intact; click
   again (or press Escape) to fold it. Opening is what marks it read.
5. Use Teams' own **Mark as unread** on a post: its card comes back as UNREAD
   with a purple border. Open the card: the mark clears.
6. Open the popup: two switches, Compact posts and Date lines. Each works on its
   own — date lines can be left on with compact posts off. Toggling them changes
   the page behaviour; settings survive a reload and sync.
7. Revoke site access in `chrome://extensions` → Site access → remove Teams. The
   content script is unregistered and Teams renders untouched.
8. Watch the DevTools Network panel while using the extension: there are no
   requests originated by the extension.

---

## 10. Release checklist for this version

- `manifest.json` → `1.0.7`
- `background.js` → `CONTENT_VERSION` bumped so open Teams tabs pick up the new
  content script after an extension reload
- `changelog.html` → v1.0.7 entry marked Current, v1.0.6 demoted
- `src/popup/popup.html` → footer version (the popup also reads the version from
  the manifest on load, so this is only what is there before it runs)
- The "What's new in this version" text in §2 pasted into the item form
- `README.md` → read/unread rules and privacy sections current
- `PRIVACY.md` → published and linked
