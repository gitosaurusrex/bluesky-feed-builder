# How Blue Feeds works

This is the engineer's tour: how requests flow, what's cached where, what's stored, and why. For setup and day-to-day use,
see the [README](../README.md).

- [The big picture](#the-big-picture)
- [Serving a feed](#serving-a-feed)
- [Building a feed](#building-a-feed)
- [Caching](#caching)
- [Pagination](#pagination)
- [Where feeds come from: the registry](#where-feeds-come-from-the-registry)
- [Storage](#storage)
- [Sign-in and sessions](#sign-in-and-sessions)
- [Members and privacy](#members-and-privacy)
- [Publishing, backups and self-healing](#publishing-backups-and-self-healing)
- [Remembering posts](#remembering-posts)
- [Importing from SkyFeed](#importing-from-skyfeed)
- [Hosting](#hosting)
- [Security notes](#security-notes)
- [Numbers worth knowing](#numbers-worth-knowing)
- [Code map](#code-map)
- [Testing and screenshots](#testing-and-screenshots)

## The big picture

A Bluesky custom feed is two things: a **record** in someone's repo (`app.bsky.feed.generator`) that names the feed and
points at a service DID, and a **service** that answers `app.bsky.feed.getFeedSkeleton` with a list of post URIs.
Bluesky's AppView calls the service, then fills in the posts itself.

```
            ┌────────────── Bluesky ──────────────┐
 Bluesky    │  AppView                            │
 app  ────▶ │  reads the feed record, finds the   │
            │  service from its did:web document  │
            └───────────────┬─────────────────────┘
                            │ getFeedSkeleton?feed=at://<owner>/app.bsky.feed.generator/<id>
                            ▼
            ┌────────────── Blue Feeds ───────────┐
            │  registry ─▶ engine ─▶ cache        │──▶ Bluesky API: search, author feeds,
            │      │                              │    lists, other feeds, likes
            │      ▼                              │
            │  Turso / SQLite: feeds, sessions,   │
            │  logins, remembered posts, locks    │
            └─────────────────────────────────────┘
```

Most feed generators subscribe to the firehose and index every post. Blue Feeds doesn't. It builds each feed **on
demand** from the Bluesky API, then caches the result. That's what lets it run on serverless free tiers with no
always-on process and only a small database. The cost is coverage: a feed can only contain posts that some API call
returns.

One deployment serves any number of feeds for any number of members. Feeds are keyed by **(owner DID, feed id)**.

## Serving a feed

`GET /xrpc/app.bsky.feed.getFeedSkeleton` (`src/app.ts`):

1. Parse `feed` as an `at://` URI. The host is the owner's DID, the rkey is the feed id.
2. Reject it unless the collection is `app.bsky.feed.generator` and the owner is a **member** (the admin or someone in
   `ALLOWED_ACCOUNTS`). This stops strangers pointing their own records at your service.
3. Look the feed up in the registry. If it's missing, try to **restore** it from the backup in its Bluesky record
   (see [self-healing](#publishing-backups-and-self-healing)).
4. Clamp `limit` to 1–100 (default 50), get the built feed from the engine's cache, and cut out one page.
5. Respond with `cache-control: public, max-age=0, s-maxage=30, stale-while-revalidate=60`, so a CDN in front can absorb
   bursts.

Errors are XRPC-shaped: `UnknownFeed` and `InvalidRequest` (400), `FeedUnavailable` (502).

`/.well-known/did.json` serves the `did:web` document that tells Bluesky where the service lives.
`describeFeedGenerator` lists every feed it serves.

## Building a feed

`FeedEngine.build()` in `src/feeds/engine.ts`:

```
sources ──fetch in parallel──▶ merge & de-duplicate ──▶ filters ──▶ (+ remembered posts) ──▶ rank ──▶ cap at maxPosts
pinned  ──resolve to at:// URIs───────────────────────────────────────────────────────────────────▶ first page only
```

- **Fetch.** Every source runs at once (`Promise.allSettled`). A failed source is reported in `errors` and the feed is
  built from the rest. Only if *every* source fails does the build throw.
- **Sources** (`src/feeds/sources.ts`) page through the API 100 at a time until they reach their `limit`, run out, or,
  for chronological sources with `maxAgeHours` set, page past the cutoff. `author` sources fetch up to 6 accounts in
  parallel and tolerate individual accounts failing. `search` and `likes` need a signed-in session (Bluesky doesn't
  serve them anonymously); everything else reads from the public AppView and only falls back to a session on 401/403.
- **Merge.** Posts are de-duplicated by URI. When a post appears both directly and as a repost, the original wins.
- **Filter** (`src/feeds/filters.ts`). Compiled once per build into one predicate. Keyword matching is whole-word and
  case-insensitive, supports `word*` prefixes, `#tags` and multi-word phrases, and also searches image alt text and
  link-card titles. Keywords in scripts without spaces (Chinese, Japanese, Thai) match anywhere. A code feed's custom
  `filter` function runs last.
- **Rank** (`src/feeds/rank.ts`). Engagement is `likes + 2 × (reposts + quotes) + replies`.
  - `newest`: by time, ties broken by URI so order and cursors are stable.
  - `top`: by engagement.
  - `hot`: `(engagement + 1) / (ageHours + 2)^1.8`, Hacker News style, so newer posts need fewer likes to rank.

Feed definitions are validated with zod (`src/feeds/define.ts`), and code feeds and editor feeds share that schema.

## Caching

Each instance keeps an in-memory cache entry per feed, keyed by owner and id and tagged with the definition's
**version** (the row's `updated_at` for editor feeds). Editing a feed changes the version, so the next request starts
over instead of serving results from the old definition.

| Age of the cached build | What happens |
| --- | --- |
| under `cacheSeconds` (60) | Served from cache. |
| up to `cacheSeconds + STALE_SECONDS` (60 + 600) | Served stale; one refresh starts in the background (kept alive with Vercel's `waitUntil`). |
| older, or nothing cached | The request waits for the refresh. If it fails and anything is cached, the old copy is served. |

Concurrent requests share one in-flight refresh. A refresh that hasn't settled in 30 s is treated as lost (a frozen
serverless instance, say) and a new one is allowed. On top of this, the CDN header above lets an edge cache answer for
30 s.

Previews from the editor and playground (`POST /api/preview`) call `build()` directly, bypassing the cache. They're
marked read-only, so trying out settings never adds to what a feed remembers.

## Pagination

Cursors are opaque to Bluesky, so each sort order uses whatever stays correct for it:

- `newest` uses a **position** cursor, `t:<sortAt>:<uri>`. The next page starts after that post even if new posts have
  arrived at the top in the meantime.
- `top` and `hot` reshuffle as engagement changes, so they use a plain **offset**, `o:<n>`.

Pinned posts (up to 10) are shown on the first page only, marked with `skeletonReasonPin`. Reposts carry
`skeletonReasonRepost` so Bluesky shows who reposted.

## Where feeds come from: the registry

`src/feeds/registry.ts` merges two sources:

- **Code feeds** in `feeds/`, compiled into the bundle and owned by the admin. They're read-only in the dashboard, and
  a code feed wins over a saved feed with the same id.
- **Editor feeds** in the `user_feeds` table.

The combined list is re-read from the database at most every **10 seconds**, so an edit made on one serverless instance
reaches the others quickly. If the database can't be reached, the last good list keeps being served. Saved feeds that
no longer validate (after a schema change, say) are set aside as *broken* and shown to their owner instead of breaking
everything else.

## Storage

Without `TURSO_DATABASE_URL` there's no database: only code feeds, no sign-in, no editor. With it, `src/db.ts` creates
these tables on first use:

| Table | Holds |
| --- | --- |
| `user_feeds` | Editor feeds: `(owner, id)` → definition JSON, created and updated times. |
| `remembered` | Posts kept by feeds with **Remember posts** on: `(feed_id, uri)` → the post as last seen. |
| `kv` | Namespaced key–value pairs with optional expiry: OAuth state (1 h) and sessions, dashboard logins (30 days), the generated OAuth signing key, the database creation time. |
| `locks` | Short leases shared by every instance (see below). |

`libsql://` and `https://` addresses use libsql's pure-`fetch` web client, which keeps native SQLite bindings out of
serverless bundles. `file:` addresses use the regular client.

`/health` reports `{ ok, feeds, database: { id, createdAt } }`. The `id` is a hash of the database address and
`createdAt` is written once. If either changes between deploys, the app is talking to a different or emptied database.

## Sign-in and sessions

Sign-in is Bluesky OAuth via `@atproto/oauth-client-node` (`src/auth.ts`).

- **Scopes** are as narrow as Bluesky allows: `repo:app.bsky.feed.generator` (feed records), `blob:image/*` (avatars),
  and AppView RPC permission for `searchPosts` and `getActorLikes`. The app can't post, follow, edit profiles or read
  DMs. `OAUTH_SCOPE` overrides this.
- **Confidential client.** In production the app serves `/client-metadata.json` and `/oauth/jwks.json` and signs token
  requests with an ES256 key (`private_key_jwt`). Bluesky gives signed clients much longer-lived sessions. The key comes
  from `OAUTH_PRIVATE_KEY`, or is generated once and stored in `kv`. Tokens are DPoP-bound.
- **Local development** uses Bluesky's loopback client on `http://127.0.0.1:<port>`, which needs no hosted metadata but
  gives short sessions. That's why `localhost` redirects to `127.0.0.1`.
- **OAuth sessions** live in the database, keyed by DID, so a member's search and likes feeds keep working while
  they're away. Token refreshes take a database **lock** so two serverless instances never refresh the same token at
  once. That would invalidate it.
- **Dashboard logins** are separate from OAuth sessions: a random 32-byte token in an `httpOnly`, `SameSite=Lax`
  cookie. The database stores only its SHA-256 hash, so a leaked database can't be used to sign in. Signing out
  deletes the login but leaves the OAuth session, so feeds keep running.
- The **admin's app password** (`BSKY_APP_PASSWORD`), if set, is used for the admin's search and likes and for
  `npm run publish-feeds`. It never covers other members.

## Members and privacy

`src/members.ts` resolves the admin (`BSKY_IDENTIFIER`, or `FEEDGEN_PUBLISHER_DID`) and `ALLOWED_ACCOUNTS` to DIDs, and
caches them for 5 minutes. Handles that fail to resolve are skipped and retried later. Everything is stored by DID,
never by handle, since handles change.

Membership is checked on **every** request, not just at sign-in, so removing someone signs them out and stops their
feeds being served. Their saved feeds stay in the database, so adding them back restores everything.

Privacy rules:

- Signed-out visitors see only the welcome page. No route lists or previews feeds without a member login.
- Each member sees and edits only their own feeds.
- `getFeedSkeleton` serves only members' feeds. Published feeds work in Bluesky for everyone, since that's the point.
- `robots.txt` disallows everything.

## Publishing, backups and self-healing

Publishing (`src/publish.ts`) writes an `app.bsky.feed.generator` record to the **member's own repo** using their OAuth
session: display name, description, optional avatar blob, and `did` set to this service's DID (`did:web:<hostname>`).
The dashboard compares each feed with its record and flags it as *published*, *outdated* (name, description or avatar
differ), *elsewhere* (the record points at another service) or *unpublished*. Changes to sources and filters never need
republishing, because the record doesn't contain them.

**Backups.** Records from the editor also carry a `blueFeeds` field: `{ version: 1, definition, savedAt }`, where
`definition` is the feed's settings **as a JSON string**. It's a string because atproto records can't hold floats, and
settings like `maxAgeHours: 1.5` exist. Saving a feed in the editor refreshes the backup if the feed is published.

**Self-healing.** If Bluesky asks for a feed the database doesn't have, after a database swap or loss say,
`FeedRestorer` (`src/backup.ts`) fetches the record straight from the owner's PDS, checks that it points at this
service and carries a valid backup, and recreates the feed. Concurrent requests share one restore. Misses are
remembered for 5 minutes so a bad record isn't fetched on every request. Opening the dashboard runs the same restore
for any of the member's records that point here but aren't in the database.

## Remembering posts

Sources only reach so far back: an author's latest posts up to the source limit, or whatever search returns. With
`remember: true`, every post that passes the filters is also written to `remembered`, and the next build adds back
remembered posts that the sources no longer return.

- Fresh copies win over remembered ones, since their engagement counts are current.
- Remembered posts must still pass the current filters, so tightening the filters hides them. Turning the option off
  deletes them.
- Each feed keeps its newest **2,000**. Older ones are pruned in the same write.
- Posts are only saved when the feed is built, which happens whenever someone views it.

## Importing from SkyFeed

SkyFeed stores its builder settings in the feed record as `skyfeedBuilder`. `src/feeds/skyfeed.ts` converts those blocks
into a Blue Feeds definition: account, list, feed and post inputs; regex filters; reply, repost and quote removal;
sorting; and limits. It returns a list of notes for anything that works differently or couldn't be converted.
SkyFeed's whole-network input has no equivalent, because Blue Feeds doesn't read the firehose. Its "remember" block maps
to a 1,000-post lookback per account, with **Remember posts** left off for the owner to decide.

**Move to Blue Feeds** rewrites the record's `did` to point here and keeps the URI, likes and pins, and the
`skyfeedBuilder` field. Republishing from SkyFeed moves the feed back.

## Hosting

- **Vercel** (`api/index.ts`): `vercel.json` rewrites every path to one function, which hands the request to the Hono
  app. `waitUntil` keeps background refreshes alive after the response is sent. The hostname comes from
  `VERCEL_PROJECT_PRODUCTION_URL`.
- **Render and anything Node** (`src/server.ts`): `@hono/node-server` on `PORT`. The hostname comes from
  `RENDER_EXTERNAL_HOSTNAME` or `FEEDGEN_HOSTNAME`. Free Render services sleep, and the first request after a sleep can
  time out.
- `npm run build` bundles `src/server.ts` with esbuild for `npm start`.

The app is stateless apart from the database and per-instance caches, so it scales out freely. Everything that must
be consistent across instances (feeds, sessions, logins, token refreshes) goes through the database.

## Security notes

- **CSRF:** every form post must carry an `Origin` whose host matches the service's (Hono's `csrf` middleware).
- **Admin token:** `ADMIN_TOKEN` enables the playground's preview API without a login. It's compared in constant time
  (SHA-256 both sides, then `timingSafeEqual`).
- **Publishing from a local server is blocked**, since the record would point at an address Bluesky can't reach.
- **Reserved ids:** `new` and `import` can't be feed ids, since they're routes.
- Database hosts are shown to the owner, but auth tokens never are.

## Numbers worth knowing

| What | Value | Where |
| --- | --- | --- |
| Cache lifetime | 60 s (`CACHE_SECONDS`, or a feed's `cacheSeconds`) | `src/config.ts` |
| Stale window | 600 s (`STALE_SECONDS`) | `src/config.ts` |
| Lost-refresh timeout | 30 s | `src/feeds/engine.ts` |
| CDN caching of skeletons | `s-maxage=30, stale-while-revalidate=60` | `src/app.ts` |
| Registry re-read | 10 s | `src/feeds/registry.ts` |
| Member list cache | 5 min | `src/members.ts` |
| Restore miss cache | 5 min | `src/backup.ts` |
| Dashboard login | 30 days | `src/auth.ts` |
| Page size from Bluesky | 100 | `src/feeds/sources.ts` |
| Source `limit` | 1–1,000, default 100 (`author`: 50 per account) | `src/feeds/define.ts` |
| Parallel author fetches | 6 | `src/feeds/sources.ts` |
| `maxPosts` | 1–2,000, default 500 | `src/feeds/define.ts` |
| Remembered posts per feed | 2,000 | `src/feeds/define.ts` |
| Pinned posts | up to 10 | `src/feeds/define.ts` |
| Feed id / name / description | 15 / 24 / 300 characters | `src/feeds/define.ts` |

## Code map

```
feeds/                feeds defined in code, listed in feeds/index.ts
src/instance.ts       wires everything together from environment variables
src/app.ts            feed generator endpoints, preview API, /health
src/manage.ts         dashboard routes: sign-in, editor, import, publishing
src/feeds/define.ts   feed schema (zod) and limits
src/feeds/engine.ts   build, cache, paginate
src/feeds/sources.ts  fetching from the Bluesky API
src/feeds/filters.ts  compiled filters
src/feeds/rank.ts     newest / top / hot
src/feeds/post.ts     post helpers: candidates, engagement, text and media facts
src/feeds/registry.ts code + database feeds
src/feeds/skyfeed.ts  SkyFeed conversion
src/bsky.ts           Bluesky client: public reads, signed-in reads, DID and PDS resolution, profiles
src/auth.ts           OAuth client, scopes, dashboard logins
src/members.ts        who may sign in
src/db.ts             tables, key–value store, locks
src/publish.ts        feed records and publish status
src/backup.ts         backups in feed records, and restoring from them
src/web/              server-rendered HTML; all styles inline, sky palette in layout.ts
api/index.ts          Vercel entry point
src/server.ts         Node entry point
scripts/              publish-feeds, preview, oauth-key, screenshots
test/                 vitest suites
```

## Testing and screenshots

- `npm test` runs the vitest suites, which stub Bluesky and use an in-memory SQLite database. `npm run typecheck` checks
  types. CI runs both, plus the build, on every push.
- `npm run screenshots` regenerates `docs/screenshots/`. It runs the real app against made-up accounts and posts, so
  no Bluesky sign-in is needed and no real person's posts appear, and drives Chromium with Playwright in light and dark
  mode. Playwright isn't a dependency of the app; install it separately to run this.
