# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Browser app for browsing and watching videos from the official English Peppa Pig YouTube channel, with per-video watch status (unwatched / watching / completed). UI text is Korean. No build step and no npm dependencies: plain HTML/CSS/ES modules served by a tiny Node static server.

## Commands

- `npm start` — serves `public/` at http://localhost:5173 (`PORT` env var overrides; `node server.js --open` also opens the browser). Must be served over http; the YouTube IFrame player does not work from `file://`.
- `npm run package` — builds `dist/peppa-pig-player.zip` for other PCs via `scripts/package.ps1`.
- `node --check public/app.js` — quick syntax check (there is no test suite or linter).

## Deployment

- **Hosted copy:** https://masonofmason.github.io/peppa-pig-player/ (public repo `masonofmason/peppa-pig-player`).
- **Pipeline:** `.github/workflows/pages.yml` deploys `public/` as-is on every push to `main`. There is no build step.
- **Paths:** everything in `public/` must use relative paths, because the site is served under the `/peppa-pig-player/` subpath.
- **Cache busting:** GitHub Pages sends `max-age=600`.
  - Every JS/CSS reference (in `index.html`, and the ES-module imports in `app.js`/`search.js`) carries `?v=dev`. The workflow rewrites it to the short commit SHA, so new HTML never runs with stale cached JS. **Add `?v=dev` to any new asset reference or import.**
  - A cached old `index.html` can still meet new JS for up to 10 minutes, so JS must tolerate missing new elements (see the guard on the voice buttons).
- **No baked-in key:** `public/config.js` must keep `apiKey: ''` in the repo. The site is public, so users enter their own key per device.
- **Mobile / PWA:** `manifest.webmanifest`, `icons/`, and Apple meta tags enable "Add to Home Screen". There is deliberately no service worker, so updates are never served stale.

## Architecture

- **Two interchangeable servers.** Changes to serving behavior must be made in both.
  - `server.js` (Node) and `server.ps1` (Windows PowerShell 5.1 + `HttpListener`, for recipient PCs without Node) serve `public/` the same way: path-traversal guard, `no-cache`, port 5173 with fallback to +1..+9.
  - Before falling back, each checks whether port 5173 is already serving this app (by looking for `<title>Peppa Pig Player</title>`) and just opens the browser if so. This matters because localStorage, and therefore the watch history, is scoped per origin including the port.
  - The probe uses `127.0.0.1`, because PS 5.1 tries `::1` first for `localhost` and times out.
- **Distribution launchers.** `start.bat` uses Node if it is on PATH, otherwise runs `server.ps1`. `start.command` is for macOS/Linux and uses Node or `python3 -m http.server`. `INSTALL.txt` is the Korean guide for recipients. `scripts/package.ps1` stages only those files plus `public/`, `server.*` and `package.json`. It writes zip entries with `/` separators itself, because PS 5.1 `Compress-Archive` writes `\`, which breaks macOS extraction. It also forces CRLF in `start.bat`.
- **File encoding.** `server.ps1` and `scripts/package.ps1` must stay ASCII-only, because PS 5.1 reads BOM-less files as ANSI. `start.bat` is UTF-8 with Korean text and relies on `chcp 65001`.
- `public/config.js` — optional `window.PEPPA_CONFIG.apiKey`, a default API key baked into a distribution. A key entered in the settings dialog (localStorage) takes precedence.
- `public/app.js` — all app logic in one module:
  - **Catalog, not search.** `search.list` (100 units/call) is deliberately not used.
    - `syncCatalog()` pages through the uploads playlist of `CHANNEL_ID` (`UU` + id without `UC`) via `playlistItems.list`, then calls `videos.list` per 50 ids for duration and `liveBroadcastContent`. That is 2 units per 50 videos.
    - Live/upcoming streams are skipped. Private/deleted videos drop out because `videos.list` doesn't return them.
    - The first run fetches everything and saves `nextPageToken` after each page, so an interrupted sync resumes.
    - Once `complete`, refreshes walk from the newest page and stop at the first page containing an already-known id. This runs on load if `lastSync` is older than 1h, or via the "새 영상 확인" button.
    - Catalog items are stored minimally (`id/title/publishedAt/duration`). Thumbnail URL and channel name are derived in `toVideo()` to keep localStorage small.
  - **Korean search** (`search.js`, `ko-dictionary.js`) — `compileQuery()` turns the query into AND-groups.
    - Korean words are translated through the dictionary, and each Korean term becomes an OR-group of English words. Typed English tokens stay plain substring matches.
    - Korean is matched greedily, longest key first, ignoring spaces, so "아빠 돼지" equals "아빠돼지". Leftover Korean runs are split at spaces and stripped of trailing particles from `KO_NOISE`; anything still 2+ chars is reported as `unknown`. A single-char particle is stripped only once, so "뽀로로" stays intact.
    - English dictionary words match as whole words, allowing a trailing s/es/'s. The regex avoids lookbehind for old TV browsers.
    - If only unknown Korean was typed, nothing matches (`matchesNothing`).
    - To unit-test, copy both files into a dir with `{"type":"module"}` in package.json and import from Node.
  - **Voice search** — Web Speech API, `SpeechRecognition || webkitSpeechRecognition`, interim results.
    - The language toggle (`voiceLang`, persisted as `pp.voiceLang`) switches between `ko-KR` and `en-GB`, because recognition handles only one language at a time.
    - `language-not-supported` while on EN falls back to Korean instead of hiding the button.
    - Korean-mode transliterations of English words ("버스데이") live in a dedicated section of `ko-dictionary.js`. `search.js` drops English filler words (`EN_STOPWORDS`) and normalizes curly apostrophes.
    - The transcript is written into the search box, so it goes through the same Korean dictionary search.
    - The button stays hidden unless the API exists. It is hidden again on `service-not-allowed` / `language-not-supported`, because some TV browsers expose the API but can't use it.
    - To test without a mic, re-render the page via `document.write` (replace `src="app.js?v=dev"` with a fresh query) with a mock class assigned to **both** globals. Chrome now has the unprefixed `SpeechRecognition`, so mocking only `webkitSpeechRecognition` is not enough.
  - **Title search, date filter and sort are all client-side** over the catalog, so they cost no quota. Cards render in chunks of `RENDER_STEP` with a "더 보기" button.
  - **Playback / progress tracking**: the YouTube IFrame Player API runs inside a `<dialog>`. Position is saved every 2s while playing, on pause, on close, and on `pagehide`. The `ENDED` state forces completion.
  - **Status rules** (`statusOf`): completed if the `ENDED` event fired, ≥95% watched, or ≤10s remaining; watching if position ≥3s; otherwise unwatched. Once completed, a video never goes back to watching on rewatch. Users can reset it or mark it completed from the player footer.
  - **Filters**: "전체" and "아직 안 본 영상" operate on the catalog. "보고 있는 영상" and "본 영상" read from the full watch history in localStorage (sorted by `updatedAt`), so they work without an API key or after the quota is exhausted.
  - **Upload-date filter**: cascading year → month → day → hour selects (a lower level is enabled only after the one above it is chosen). `dateRange()` turns the selection into a half-open `[start, end)` range in the **browser's local timezone**. `inDateRange()` applies it, together with the title query, to every tab, including the history tabs.
- localStorage keys: `pp.apiKey`, `pp.progress` (map videoId → record with title/thumb/publishedAt/duration/position/completed/updatedAt), `pp.catalog` (`{videos, nextPageToken, complete, lastSync}`), `pp.filter`, `pp.dateFilter`, `pp.sort`. The obsolete `pp.searchCache` is removed on startup. The history records store enough metadata to render cards without calling the API, including videos watched under the old search-based version.
- The API key is entered by the user in the settings dialog and stored only in localStorage. Nothing is committed to the repo.
