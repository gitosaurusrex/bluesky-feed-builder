# Blue Feeds

Build custom Bluesky feeds and host them all from one free deployment on Vercel or Render. Sign in with your Bluesky
account to create, preview and publish feeds from a web dashboard, or define them in a few lines of TypeScript.

```ts
// feeds/cat-pics.ts
export default defineFeed({
  id: 'cat-pics',
  displayName: 'Cat Pics',
  sources: [{ type: 'search', query: 'cat', sort: 'top' }],
  filters: { media: 'images', includeKeywords: ['cat*', 'kitten*'], maxAgeHours: 48 },
  sort: 'hot',
})
```

## How it works

```
Bluesky app ──▶ Bluesky AppView ──getFeedSkeleton──▶ this service ──▶ Bluesky API
                                ◀── list of post URIs ──┘   (search, author feeds, lists, other feeds)
```

When someone opens your feed, Bluesky asks this service for a list of post URIs. The service pulls candidate posts
from the Bluesky API, filters and ranks them, and caches the result for a minute.

Most feed generators read the whole Bluesky firehose into a database, which needs an always-on server and storage.
This one assembles feeds on demand from the Bluesky API, so it runs on serverless free tiers. The trade-off is that
feeds are built from what search, author feeds, lists and other feeds return. It can't do "every post on the network
that matches X". For most personal feeds that's plenty.

There are two ways to manage feeds, and you can mix them:

- **Dashboard (recommended):** sign in with Bluesky, then create, edit, preview and publish feeds in the browser.
  Needs a free [Turso](https://turso.tech) database to store your feeds and sign-in.
- **Code:** feed files in `feeds/`, deployed with the app and published with a command. Supports custom filter
  functions. Needs no database.

## Quick start

Requires Node 20.12 or newer.

```sh
npm install
cp .env.example .env              # set BSKY_IDENTIFIER to your handle
npm run preview -- bsky-team      # print a feed in the terminal
npm run dev                       # dashboard at http://127.0.0.1:3000
```

To try the dashboard editor locally, add `TURSO_DATABASE_URL=file:local.db` to `.env`. That stores everything in a
local SQLite file, no Turso account needed. Then open **http://127.0.0.1:3000** (not `localhost`: Bluesky's sign-in
for local apps only returns to `127.0.0.1`) and choose **Sign in**. You can create and preview feeds locally, but
publishing has to happen from your deployed dashboard, since Bluesky must be able to reach the service.

## Deploying

Deploy first, then publish. Publishing tells Bluesky where your feeds are hosted, so the host has to exist.

### 1. Create a Turso database (for the dashboard)

Skip this if you only want feeds defined in code.

- **On Vercel:** after importing the project (step 2a), open its **Storage** tab, or the
  [Turso Cloud integration](https://vercel.com/marketplace/tursocloud/database) in the Vercel Marketplace, create a
  database and connect it to the project. That sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you.
  **Untick Production under "Create Database Branch for Deployment"** in the connection's settings. Otherwise every
  production deploy gets its own fresh copy of the database, and your sign-in and saved feeds seem to vanish after
  each deploy. (Published feeds restore themselves from their backups, but nothing else does.) The dashboard footer
  shows which database the app is using.
- **Elsewhere:** sign up at [turso.tech](https://turso.tech) (the free plan is plenty) and create a database. Copy its
  URL (`libsql://<name>-<org>.turso.io`) and create an auth token for it. With the Turso CLI:
  `turso db show <name> --url` and `turso db tokens create <name>`.

The app creates its tables on first use. It also generates the private key it uses to sign its requests to Bluesky,
which keeps you signed in much longer, and stores it in the database alongside your session. To manage
that key yourself instead, run `npm run oauth-key` and set the printed `OAUTH_PRIVATE_KEY`, ideally before you first
sign in; changing the key later means signing in again.

### 2a. Vercel (recommended)

Vercel's free Hobby plan suits this best: there are no cold starts long enough to time out Bluesky's request. Note
that Hobby is for non-commercial use.

1. Push this repo to GitHub, then **Add New → Project** in Vercel and import it. No build settings are needed.
2. Under **Settings → Environment Variables**, add:
   - `BSKY_IDENTIFIER`: your handle, e.g. `you.bsky.social`. This is the admin account.
   - `ALLOWED_ACCOUNTS` (optional): handles of other people who may sign in, see [Inviting others](#inviting-others).
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, unless the Turso integration already added them.

   The hostname is detected automatically.
3. Deploy, open `https://<your-project>.vercel.app` and sign in.

Sign-in uses your production domain, so sign in there rather than on preview deployment URLs.

### 2b. Render

1. In Render choose **New → Blueprint** and pick this repo. `render.yaml` sets up a free web service.
2. Fill in the variables it asks for, as in the Vercel steps.

Use Turso rather than a `file:` database on Render: free services have no persistent disk, so a local file is wiped
on every deploy and restart. Free services also sleep after 15 minutes without traffic and take up to a minute to
wake. The first person to open your feed after a quiet spell may see an error until it wakes.

### Anywhere else

It's a plain Node server too: `npm run build && npm start` works on Railway, Fly.io, Koyeb or a Raspberry Pi. It
listens on `PORT` and must be reachable over HTTPS on port 443. Set `FEEDGEN_HOSTNAME` to its public hostname.

## Using the dashboard

- **New feed** opens the editor: name, sources, filters and ordering, with a **Preview** button that shows the posts
  the feed would contain right now.
- **Publish** adds the feed to your Bluesky profile, with an optional avatar. After that, edits to sources and filters
  show up in Bluesky within a minute. Publish again only after changing the name, description or avatar; the
  dashboard flags feeds where those are out of date.
- **Unpublish** removes a feed from Bluesky but keeps it in the dashboard. **Delete** (in the editor) does both.
- **Backups:** publishing a feed made in the editor also saves its settings in the feed's own Bluesky record (the
  `blueFeeds` field), and saving changes keeps that copy current. If the database is ever lost or replaced, the feed
  rebuilds itself the next time Bluesky asks for it, or when you open the dashboard. `/health` shows a fingerprint of
  the database in use, so a swapped database is easy to spot.
- Feeds defined in code show up too. You can preview and publish them, but edit them in `feeds/`.

### Moving feeds from SkyFeed

Your SkyFeed feeds appear on the dashboard under **Your feeds on other services**. **Import** converts a feed's
SkyFeed settings into the editor and lists anything that works differently. You can also paste a SkyFeed export, or
any SkyFeed feed's link, on the **Import** page. Save it, check it with **Preview**, then choose **Move to Blue
Feeds**. The feed keeps its link, likes and pins, and its SkyFeed settings stay in the record, so republishing it
from SkyFeed moves it back.

Inputs from accounts, lists, feeds and posts convert, as do regex filters, reply/repost/quote removal, sorting and
limits. SkyFeed's whole-network input can't be converted. Imported feeds start with **Remember posts** off, even if the
SkyFeed feed used its "remember" block, so they look through each account's latest 1,000 posts and older matches drop
off. Tick it in the editor to keep every match, as SkyFeed did.

### Remembering posts

Sources only reach so far back: the latest 1,000 posts for an account, or whatever search returns. With **Remember
posts** ticked, every post that matches is also saved in your database and stays in the feed after the sources stop
returning it, up to the newest 2,000 per feed. Saved posts still have to pass the filters, so tightening them hides old
posts too, and switching the option off forgets them. A post is only saved if it appears while the feed is being built,
which happens whenever someone views it; with sources that reach back hundreds of posts, nothing slips through.

### Sign-in and permissions

Sign-in uses Bluesky's OAuth: you approve access on Bluesky's own page, and the app never sees your password. It asks
only for permission to:

- create, update and delete feed records (`app.bsky.feed.generator`),
- upload images, for feed avatars,
- run searches and read your likes, for the `search` and `likes` sources.

It can't post, follow, change your profile or read your messages. The session is stored in your database so search
feeds keep working when you're away. **Sign out** ends only the dashboard login; to cut the app off entirely, revoke
it in Bluesky's settings. If the session ever expires, search and likes feeds stop until you sign in again; other
feeds keep working. Setting `BSKY_APP_PASSWORD` as well makes search independent of the session.

### Inviting others

By default only the `BSKY_IDENTIFIER` account can sign in. To let someone else use the site, add their handle to
`ALLOWED_ACCOUNTS` (several handles separated by commas or spaces, e.g. `friend.bsky.social, other.bsky.social`)
and redeploy. They then sign in at `/login` with their own Bluesky handle.

- Each person sees and edits only their own feeds. Feeds they publish appear on their own profile, from their own
  account, and their search and likes feeds run with their own sign-in.
- Feed ids only need to be unique per account, so two people can both have a feed called `cats`.
- Removing someone from `ALLOWED_ACCOUNTS` signs them out and stops their feeds being served; their saved feeds stay
  in the database, so adding them back restores everything.
- Feeds defined in code (`feeds/`) belong to the admin.

Feeds saved before invited accounts existed are moved to the admin account automatically.

## Defining feeds in code

Each feed is a file in `feeds/`, listed in `feeds/index.ts`. Your editor autocompletes every option. The dashboard
editor offers the same options, apart from custom filter functions.

```ts
import { defineFeed } from '../src/feeds/define.js'

export default defineFeed({
  id: 'my-feed',               // 1–15 chars: a-z, 0-9, dashes. Part of the feed URL, so keep it stable.
  displayName: 'My Feed',      // up to 24 characters
  description: 'What this feed is about',
  avatar: 'avatars/my-feed.png', // optional PNG or JPEG, uploaded by publish-feeds
  sources: [/* where posts come from, merged and de-duplicated */],
  filters: {/* which posts to keep */},
  sort: 'newest',              // 'newest' | 'top' (most engagement) | 'hot' (engagement, decayed by age)
  pinned: [],                  // post URLs to pin at the top
  maxPosts: 500,
  cacheSeconds: 60,
  remember: false,             // keep matches after the sources stop returning them (needs a database)
})
```

### Sources

| Source | Example | Needs sign-in |
| --- | --- | --- |
| `search` | `{ type: 'search', query: 'rust lang', sort: 'latest', lang: 'en' }`. Also accepts `author`, `domain`, `tags`. | yes |
| `author` | `{ type: 'author', actors: ['alice.bsky.social', 'did:plc:…'], filter: 'posts_no_replies' }` | no |
| `list` | `{ type: 'list', list: 'https://bsky.app/profile/me.bsky.social/lists/3k…' }`: posts by list members | no |
| `feed` | `{ type: 'feed', feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot' }`: remix another feed | no |
| `likes` | `{ type: 'likes' }`: posts you liked | yes |
| `posts` | `{ type: 'posts', posts: ['https://bsky.app/profile/…/post/…'] }`: hand-picked | no |

"Needs sign-in" means a dashboard sign-in or `BSKY_APP_PASSWORD`, because Bluesky only serves these to signed-in
accounts. Every source takes a `limit` (how many posts to fetch, default 100; `author` is per account, default 50).
Anywhere a URI is expected you can paste a bsky.app link instead.

### Filters

| Filter | Meaning |
| --- | --- |
| `includeKeywords` / `excludeKeywords` | Whole-word, case-insensitive. `cat*` matches "cats", `#tag` matches hashtags, and `open source` matches the two words together. Also searches image alt text and link card titles. |
| `includeRegex` / `excludeRegex` | JavaScript regular expressions, case-insensitive |
| `languages` | e.g. `['en', 'es']`. Posts with no language set are kept. |
| `media` | `'any'`, `'required'`, `'images'`, `'video'`, `'none'` |
| `links` | `'any'`, `'required'`, `'none'` |
| `excludeReplies`, `excludeReposts`, `excludeQuotes` | `true` to drop them |
| `minLikes`, `minReposts`, `minReplies` | Engagement thresholds |
| `maxAgeHours` | Drop older posts. Also speeds up fetching. |
| `includeAuthors` / `excludeAuthors` | Handles or DIDs |
| `excludeLabels` | Moderation labels, e.g. `['porn', 'sexual', 'nudity', 'graphic-media']` |

For anything else, add a custom function. It runs after the other filters:

```ts
filter: (post) => (post.record as { text?: string }).text?.includes('?') ?? false, // only questions
```

The **Playground** page at `/playground` takes a feed definition as JSON and shows the posts it would return. It's
available when you're signed in, or with `ADMIN_TOKEN` if you don't use the dashboard.

### Publishing feeds from code

You can publish code feeds from the dashboard, or from the command line with an app password. Create one at
**Settings → Privacy and security → App passwords** (https://bsky.app/settings/app-passwords), then put
`BSKY_APP_PASSWORD` and `FEEDGEN_HOSTNAME` (your deployment's hostname, e.g. `my-feeds.vercel.app`) in `.env`:

```sh
npm run publish-feeds -- --dry-run   # see what will change
npm run publish-feeds                # create or update every feed in feeds/
npm run publish-feeds -- --only cat-pics
npm run publish-feeds -- --prune     # also remove published feeds that no longer exist
```

Run it again whenever you add a feed or change a name, description or avatar. Changes to sources, filters and
sorting only need a redeploy. Changing a feed's `id` creates a new feed, and people who saved the old one lose it.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `BSKY_IDENTIFIER` | | Your handle. The admin account, which owns the feeds defined in code. |
| `ALLOWED_ACCOUNTS` | | Other handles that may sign in and make their own feeds, separated by commas |
| `TURSO_DATABASE_URL` | | Turns on the dashboard editor and sign-in. `libsql://…` for Turso, `file:local.db` locally. |
| `TURSO_AUTH_TOKEN` | | Turso auth token |
| `OAUTH_PRIVATE_KEY` | generated, stored in the database | From `npm run oauth-key`, to manage the signing key yourself |
| `BSKY_APP_PASSWORD` | | For `publish-feeds`, and for search without a dashboard sign-in |
| `ADMIN_TOKEN` | | Enables the playground without signing in |
| `FEEDGEN_HOSTNAME` | auto on Vercel/Render | Public hostname, no `https://`. Required for `publish-feeds`. |
| `FEEDGEN_PUBLISHER_DID` | resolved from handle | Set this if `BSKY_IDENTIFIER` is an email address |
| `FEEDGEN_SERVICE_DID` | `did:web:<hostname>` | Only if you registered a `did:plc` for the service |
| `CACHE_SECONDS` | `60` | How long a feed is reused before refetching |
| `STALE_SECONDS` | `600` | How long an expired feed may be served while it refreshes |
| `BSKY_SERVICE` | `https://bsky.social` | Your PDS, for app-password logins if you self-host |
| `OAUTH_SCOPE` | see `src/auth.ts` | Overrides the permissions requested at sign-in |

## Limits worth knowing

- **Coverage:** feeds only see what Bluesky's search and feeds return. Search finds most recent posts but isn't a
  complete index. Raise a source's `limit` to look further back.
- **Rate limits:** every source is one or a few API calls per refresh, and each feed refreshes at most once per
  `CACHE_SECONDS`. Feeds that follow hundreds of accounts with `author` are slow; use a `list` source for those.
- **Same for everyone:** feeds aren't personalized per viewer ("posts from people I follow about X").
- **Invite-only:** only the admin and the accounts in `ALLOWED_ACCOUNTS` can sign in, and only their feeds are
  served.
- **Uptime:** if the service or the database is down, code feeds keep working and dashboard feeds are served from the
  last copy loaded. If the whole service is down, the feed shows an error in Bluesky. Nothing breaks permanently.

## Project layout

```
feeds/            feeds defined in code
src/feeds/        engine: sources, filters, ranking, caching, pagination, registry
src/app.ts        feed generator endpoints (did.json, describeFeedGenerator, getFeedSkeleton), preview
src/manage.ts     sign-in, editor and publishing routes
src/auth.ts       Bluesky OAuth and dashboard logins
src/db.ts         Turso/SQLite storage
src/publish.ts    feed records, shared by the dashboard and publish-feeds
src/web/          dashboard HTML
api/index.ts      Vercel entry point
src/server.ts     Node entry point (Render, local)
scripts/          publish-feeds, preview and oauth-key CLIs
```

`npm test` runs the unit tests and `npm run typecheck` checks types.
