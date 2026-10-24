# Bluesky Feed Builder

Define custom Bluesky feeds in a few lines of TypeScript, preview them in a small dashboard, and host them all from one
free deployment on Vercel or Render.

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
This one assembles feeds on demand from the Bluesky API, so it runs on serverless free tiers with no database. The
trade-off is that feeds are built from what search, author feeds, lists and other feeds return. It can't do
"every post on the network that matches X". For most personal feeds that's plenty.

## Quick start

Requires Node 20.12 or newer.

```sh
npm install
cp .env.example .env              # add your handle and an app password
npm run preview                   # list feeds
npm run preview -- bsky-team      # print a feed in the terminal (works without credentials)
npm run dev                       # dashboard at http://localhost:3000
```

Create an app password at **Settings → Privacy and security → App passwords** (https://bsky.app/settings/app-passwords).
Never use your main password. The app password is only needed for `search` and `likes` sources (Bluesky requires
sign-in for those) and for publishing.

## Defining feeds

Each feed is a file in `feeds/`, listed in `feeds/index.ts`. Your editor autocompletes every option.

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
})
```

### Sources

| Source | Example | Needs app password |
| --- | --- | --- |
| `search` | `{ type: 'search', query: 'rust lang', sort: 'latest', lang: 'en' }`. Also accepts `author`, `domain`, `tags`. | yes |
| `author` | `{ type: 'author', actors: ['alice.bsky.social', 'did:plc:…'], filter: 'posts_no_replies' }` | no |
| `list` | `{ type: 'list', list: 'https://bsky.app/profile/me.bsky.social/lists/3k…' }`: posts by list members | no |
| `feed` | `{ type: 'feed', feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot' }`: remix another feed | no |
| `likes` | `{ type: 'likes' }`: posts you liked | yes |
| `posts` | `{ type: 'posts', posts: ['https://bsky.app/profile/…/post/…'] }`: hand-picked | no |

Every source takes a `limit` (how many posts to fetch, default 100; `author` is per account, default 50). Anywhere a
URI is expected you can paste a bsky.app link instead.

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

### Trying ideas quickly

The **Playground** page at `/playground` takes a feed definition as JSON and shows the posts it would return, before
you commit anything. Set `ADMIN_TOKEN` to enable it.

## Deploying

Deploy first, then publish. Publishing tells Bluesky where your feeds are hosted, so the host has to exist.

### Vercel (recommended)

Vercel's free Hobby plan suits this best: there are no cold starts long enough to time out Bluesky's request. Note
that Hobby is for non-commercial use.

1. Push this repo to GitHub, then **Add New → Project** in Vercel and import it. No build settings are needed;
   `vercel.json` handles routing.
2. Under **Settings → Environment Variables**, add `BSKY_IDENTIFIER`, `BSKY_APP_PASSWORD` and `ADMIN_TOKEN`.
   The hostname is detected automatically.
3. Deploy, then open `https://<your-project>.vercel.app`. The dashboard should list your feeds, and
   `/.well-known/did.json` should show your hostname.

### Render

1. In Render choose **New → Blueprint** and pick this repo. `render.yaml` sets up a free web service.
2. Fill in `BSKY_IDENTIFIER` and `BSKY_APP_PASSWORD` when prompted. `ADMIN_TOKEN` is generated for you.

Free Render services go to sleep after 15 minutes without traffic and take up to a minute to wake. The first person
to open your feed after a quiet spell may see an error until it wakes, which is fine for a personal feed.

### Anywhere else

It's a plain Node server too: `npm run build && npm start` works on Railway, Fly.io, Koyeb or a Raspberry Pi. It
listens on `PORT` and must be reachable over HTTPS on port 443.

## Publishing feeds to Bluesky

With `FEEDGEN_HOSTNAME` in your local `.env` set to your deployment's hostname (e.g. `my-feeds.vercel.app`):

```sh
npm run publish-feeds -- --dry-run   # see what will change
npm run publish-feeds                # create or update every feed
```

This writes an `app.bsky.feed.generator` record per feed to your account and prints each feed's link. Open it, pin it,
and share it. Run it again whenever you add a feed or change a name, description or avatar. Changes to sources,
filters and sorting only need a redeploy.

- **Removing a feed:** delete it from `feeds/index.ts`, then run `npm run publish-feeds -- --prune`.
- **Renaming:** change `displayName` freely. Changing `id` creates a new feed, and people who saved the old one lose it.
- **One feed only:** `npm run publish-feeds -- --only cat-pics`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `BSKY_IDENTIFIER` | | Your handle. Used to log in and to find your DID. |
| `BSKY_APP_PASSWORD` | | App password, for search and likes sources and for publishing |
| `ADMIN_TOKEN` | | Enables the playground |
| `FEEDGEN_HOSTNAME` | auto on Vercel/Render | Public hostname, no `https://`. Required for `publish-feeds`. |
| `FEEDGEN_PUBLISHER_DID` | resolved from handle | Set this if `BSKY_IDENTIFIER` is an email address |
| `FEEDGEN_SERVICE_DID` | `did:web:<hostname>` | Only if you registered a `did:plc` for the service |
| `CACHE_SECONDS` | `60` | How long a feed is reused before refetching |
| `STALE_SECONDS` | `600` | How long an expired feed may be served while it refreshes |
| `BSKY_SERVICE` | `https://bsky.social` | Your PDS, if you self-host |

## Limits worth knowing

- **Coverage:** feeds only see what Bluesky's search and feeds return. Search finds most recent posts but isn't a
  complete index. Raise a source's `limit` to look further back.
- **Rate limits:** every source is one or a few API calls per refresh, and each feed refreshes at most once per
  `CACHE_SECONDS`. Feeds that follow hundreds of accounts with `author` are slow; use a `list` source for those.
  Bluesky also limits logins per account (about 300 a day). Each serverless cold start logs in once, which is fine at
  personal-feed traffic.
- **Same for everyone:** feeds aren't personalized per viewer ("posts from people I follow about X").
- **Uptime:** if the service is down, the feed shows an error in Bluesky. Nothing breaks permanently.

## Project layout

```
feeds/            your feed definitions (start here)
src/feeds/        engine: sources, filters, ranking, caching, pagination
src/app.ts        HTTP routes: did.json, describeFeedGenerator, getFeedSkeleton, dashboard
src/web/          dashboard HTML
api/index.ts      Vercel entry point
src/server.ts     Node entry point (Render, local)
scripts/          publish-feeds and preview CLIs
```

`npm test` runs the unit tests and `npm run typecheck` checks types.
