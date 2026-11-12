# Working notes for Teams++

Conventions that are not obvious from the code, and the one word that starts a
release.

## "engage!"

When the user says **engage!** — in honour of Jean-Luc Picard — cut a release.
It means all of the following, in this order, without asking again:

1. **Bump the version.** `manifest.json` (`version`), the footer label in
   `src/popup/popup.html` (it is replaced from the manifest when the popup loads,
   but the file on disk still says what it said), and `CONTENT_VERSION` in
   `background.js` — that stamp is what makes open Teams tabs reload the new
   content script, so it must change whenever the content script does. Its
   `BUILD` in `src/content/content.js` is bumped with every content-script change,
   not only with a release.
2. **Add the changelog entry.** A new item at the top of the timeline in
   `changelog.html`, with the same long explanatory prose as the entries below it
   and a `tag-new`, `tag-improve` or `tag-fix` badge. The previous release's item
   loses `class="timeline-item latest"` and its `Current` badge.
3. **Update the documentation** wherever it names the version or describes
   behaviour that changed — `README.md`, `STORE-LISTING.md` (its release
   checklist names the version), and `PRIVACY.md` if what is stored, or whether
   anything leaves the browser, has changed.
4. **Check the JavaScript** parses: `node --check` on every file touched.
5. **Commit and push to `main`**, in this repository's commit style: one sentence
   saying what the release is, e.g. "Keep a lost read mark, and publish as
   v1.1.2."

## House style

- Comments are long explanatory prose: they say what went wrong and why the code
  is shaped the way it is, not what the next line does.
- Changelog entries are written for the person using the extension: the symptom
  they saw first, then the cause, then the fix.
