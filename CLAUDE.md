# Blue Feeds

A Bluesky feed generator and dashboard (TypeScript, Hono, Turso/libsql), deployed on Vercel at
https://bluesky-feed-builder.vercel.app. The README covers features, setup and configuration; read it first and keep it
current when behavior changes. This file holds what the README doesn't.

## Working here

- The owner doesn't run Node locally. They deploy and check the live site, so changes must be verified here first.
- Push to `main`. Vercel deploys from it. After a deploy, check `/health` and that published feeds still serve
  (`/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://<did>/app.bsky.feed.generator/<id>`).
- Before every push: `npx tsc --noEmit --noUnusedLocals` and `npx vitest run`. For anything visual, run the server
  (`TURSO_DATABASE_URL=file:<scratch>.db npx tsx src/server.ts`) and screenshot it with Playwright in light and dark, at
  desktop and 390px wide. Pages must not scroll sideways.
- After a visible UI change, run `npm run screenshots` to refresh the README images in `docs/screenshots/` (demo data,
  light and dark). Keep `docs/technical.md` current along with the README.
- `npm run dev` watches files; plain `npx tsx src/server.ts` doesn't, so restart it after edits.

## Things that have bitten us

- **Turso branching:** Vercel's Turso integration must have "Create Database Branch for Deployment" unticked for
  Production, or each deploy gets an empty database. `/health` returns a database fingerprint; it should stay the same
  across deploys.
- **Records can't hold floats.** That's why the backup in a feed record (`blueFeeds.definition`) is a JSON string.
- **Sign-in locally** only works on `127.0.0.1`, not `localhost`, and publishing from a local server is blocked on
  purpose (Bluesky can't reach it).
- **Accounts:** the admin is `BSKY_IDENTIFIER`; invited accounts are in `ALLOWED_ACCOUNTS`. Feeds are keyed by
  (owner DID, id), so ids are unique per account. Code feeds in `feeds/` belong to the admin. Members' search and likes
  run with their own OAuth session; `BSKY_APP_PASSWORD` only ever covers the admin.
- **Privacy:** signed-out visitors see only the welcome page. No route may list or preview feeds without a member
  login. `getFeedSkeleton` serves only members' feeds.
- **Handles change.** Store DIDs, never handles. The account's current handle comes from `bsky.profileOf`.

## UI

- All styles are inline in `src/web/*.ts`. Use the CSS variables in `layout.ts` (the sky palette: blue, violet, coral,
  mint, sun) and define every color for dark mode too.
- The sky backdrop and floating cards are decorative: `aria-hidden`, behind content, and still for anyone set to reduce
  motion. On app pages, floating cards appear only in wide margins and never beside the editor.
- UI text is plain and friendly. Error messages say what happened and what to do next.

## Commits

Describe the change and why in plain words, with a short summary line. One logical change per commit.
