# Be Better Bulletin

A no-login, good-news-only reading page — daily stories, a "Daily Stoic" and
"Daily Parenting" practice panel, and an optional browser notification. It's
a static site (`index.html` + `stories.json`) hosted on GitHub Pages, kept
fresh by a GitHub Actions cron job. Nothing about running it day-to-day
depends on a chat session, an API key, or manual intervention.

## How it works

- **`index.html`** — the whole page (masthead, category rail, story cards,
  Daily Stoic / Daily Parenting / Daily Dad Joke / Reader Story panels, dark
  mode, notify toggle). On load it fetches `./stories.json` and renders
  whatever's there; if the fetch fails it shows a friendly "couldn't load
  stories" state instead of breaking.
- **`stories.json`** — the top ~80 stories, newest first. This is what the
  page actually reads.
- **`community-spotlight.json`** — today's featured reader story (name,
  city/state, story text). Written by `scripts/set-spotlight.mjs`, not by
  hand. If this file doesn't exist yet, the "📣 Reader Story" panel just
  shows a friendly "no story yet — be the first to share" message instead
  of breaking.
- **`data/stories-db.json`** — the full historical archive (capped at ~150,
  oldest pruned first). This is the source of truth for dedup, and
  `stories.json` is just its top slice.
- **`scripts/fetch-stories.mjs`** — a dependency-free Node script that
  fetches a few good-news RSS feeds, filters out horoscopes / history-trivia
  / opinion pieces / obituaries / partisan content, unrolls "weekly roundup"
  posts into their individual linked stories, categorizes and summarizes
  each story, dedupes against `data/stories-db.json`, and rewrites both JSON
  files.
- **`.github/workflows/daily-fetch.yml`** — runs that script on a daily cron
  schedule (and on-demand via the Actions tab), commits the updated JSON
  files if anything changed.
- **`.github/workflows/pages.yml`** — deploys the site to GitHub Pages on
  every push to `main`, which includes the daily commit above — so a normal
  day looks like: cron fires → new stories committed → Pages redeploys
  automatically, with nobody involved.

### Curation: API vs. heuristic

`fetch-stories.mjs` has a single classification step (decide whether to
include a story, pick its category, write its one-sentence summary) with two
implementations behind one interface:

- If the `ANTHROPIC_API_KEY` secret is set, it batches candidate stories to
  the Anthropic API for quality close to the original hand-curated feed.
- If it's not set — or the API call fails for any reason (bad key, rate
  limit, model renamed, network hiccup) — it automatically falls back to a
  keyword-based heuristic. No story ever gets stuck because of the API; the
  worst case is lower-quality categorization/summaries for that run, not a
  broken pipeline.

So the site works immediately with zero secrets, and gets better curation if
you add the key later.

## Setup

### 1. Create the GitHub repo and push

From this project folder:

```bash
git init
git add .
git commit -m "Initial commit: rebuild Be Better Bulletin on GitHub Pages"
```

Then either let the GitHub CLI create and push the repo in one step:

```bash
gh repo create be-better-bulletin --public --source=. --remote=origin --push
```

...or create an empty **public** repo named `be-better-bulletin` at
github.com/new (public is required for free GitHub Pages on a personal
account) and push to it manually:

```bash
git remote add origin https://github.com/<your-username>/be-better-bulletin.git
git branch -M main
git push -u origin main
```

### 2. (Optional) Add the ANTHROPIC_API_KEY secret

In the repo on GitHub: **Settings → Secrets and variables → Actions → New
repository secret**, name it `ANTHROPIC_API_KEY`, paste an API key from
[console.anthropic.com](https://console.anthropic.com). Skip this and the
site still works fine on the heuristic path.

### 3. Enable GitHub Pages

`pages.yml` deploys via GitHub's official Pages Actions (`configure-pages` /
`upload-pages-artifact` / `deploy-pages`), which needs Pages set to deploy
from **GitHub Actions**, not a branch:

**Settings → Pages → Build and deployment → Source → GitHub Actions.**

(Alternative, if you'd rather not use the Actions-based deploy: delete
`.github/workflows/pages.yml` and instead set **Source → Deploy from a
branch → `main` / `/ (root)`** — GitHub will serve `index.html` directly.
The daily-fetch workflow's commits will still trigger a redeploy either way.)

After the first successful deploy, the site is live at
`https://<your-username>.github.io/be-better-bulletin/`.

### 4. Confirm the cron schedule

`daily-fetch.yml` runs at `0 11 * * *` (11:00 UTC ≈ 6am America/Chicago,
5am during Central Daylight Time) and can also be triggered manually from
the repo's **Actions → Daily story fetch → Run workflow**. Edit the cron
expression in that file if you want a different time — GitHub Actions cron
is always UTC.

## Running the fetch script locally

Requires Node 18+ (uses the built-in `fetch`, no npm install needed):

```bash
node scripts/fetch-stories.mjs
```

This fetches the live RSS feeds, filters/categorizes/summarizes, and
overwrites `stories.json` + `data/stories-db.json` in place — so run it on a
branch or after a commit if you want to easily diff/revert.

Useful env vars:

- `DRY_RUN=1 node scripts/fetch-stories.mjs` — runs the full pipeline and
  logs what it would do, without writing any files.
- `ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-stories.mjs` — exercises
  the API-classification path locally instead of the heuristic one.
- `ANTHROPIC_MODEL=...` — override the model id if you need to (see
  [docs.claude.com/en/docs/about-claude/models](https://docs.claude.com/en/docs/about-claude/models)
  for current ids; the script's default may need updating over time).

## Reader stories: setup and daily use

Visitors can submit their own positive story (name, city/state, story text)
through a form on the page. You read submissions and pick one to feature
each day. This needs a one-time setup (creating a free Formspree account)
and then a simple daily step (running a script).

### One-time setup: connect the submission form to Formspree

The site can't collect form submissions itself (it's just static files with
no server), so it hands them off to [Formspree](https://formspree.io), a
free service made for exactly this — it emails you every submission and
gives you a dashboard to review them.

1. Go to [formspree.io](https://formspree.io) and sign up for a free
   account.
2. Create a new form (call it whatever you like, e.g. "Be Better Bulletin —
   Reader Stories").
3. Formspree will give you a **form endpoint URL**. It looks like
   `https://formspree.io/f/abcdwxyz` — that last part after `/f/` is your
   form ID.
4. Open **`index.html`** in VS Code and find this line (use Ctrl+F / Cmd+F
   to search for `YOUR_FORMSPREE_FORM_ID`):

   ```html
   <form class="spotlight-form" id="spotlight-form" action="https://formspree.io/f/YOUR_FORMSPREE_FORM_ID" method="POST">
   ```

   Replace `YOUR_FORMSPREE_FORM_ID` with the ID Formspree gave you, so it
   reads something like `action="https://formspree.io/f/abcdwxyz"`.
5. Save the file, then commit and push it (see the git steps you've used
   before: `git add index.html`, `git commit -m "Connect story form to
   Formspree"`, `git push`).

Until you do this, the "Share Your Story" form on the site will show a
message saying submissions aren't set up yet — it won't break or send
anything nowhere.

### Daily step: featuring a reader's story

1. Check your email (or your Formspree dashboard) for new submissions.
2. Pick the one you want to feature today.
3. In VS Code's terminal, from the project folder, run:

   ```bash
   node scripts/set-spotlight.mjs
   ```

4. It will ask you for the name, city/state, and story — type or paste
   each one in, pressing Enter when done (for the story, press Enter twice
   in a row — once to finish typing, once on the blank line — to move on).
   It then shows you a preview and asks you to confirm.
5. Once you confirm, it writes `community-spotlight.json` for you — you
   never need to edit that file by hand.
6. Commit and push it so the live site picks it up:

   ```bash
   git add community-spotlight.json
   git commit -m "Feature today's reader story"
   git push
   ```

   (If `git push` is rejected because the daily fetch workflow committed
   something in the meantime, run `git pull` first, then `git push` again
   — same as with any other change to this repo.)

## Adding more RSS sources

Edit the `FEEDS` array near the top of `scripts/fetch-stories.mjs` — each
entry is just `{ url, source }`. The filtering/categorizing pipeline applies
to every feed the same way.

## Notes

- The notify toggle uses the browser's `localStorage` + Notification API —
  it's per-browser, not a push subscription, so it only fires while you have
  the tab open (or reopen it) on a day it hasn't already notified you.
- Categories are fixed to exactly: `environment`, `science`, `community`,
  `animals`, `technology`, `society`, `culture`. `scripts/fetch-stories.mjs`
  and the category rail in `index.html` both assume this exact set.
