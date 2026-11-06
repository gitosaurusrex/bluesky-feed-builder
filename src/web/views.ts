import { html, raw } from 'hono/html'
import type { FeedDefinition, FeedSource } from '../feeds/define.js'
import type { PreviewResult } from '../feeds/engine.js'
import type { Candidate, PostView } from '../feeds/post.js'
import { type PublishStatus, feedUrl } from '../publish.js'
import { type Html, MARK, SITE_NAME, type Viewer, layout, notice } from './layout.js'

export interface DashboardFeed {
  def: FeedDefinition
  origin: 'code' | 'editor'
  /** Known when the owner is signed in, or from the public AppView otherwise. */
  status?: PublishStatus
  /** The published feed's avatar image, when it has one. */
  avatar?: string
}

export interface DashboardModel {
  viewer: Viewer
  feeds: DashboardFeed[]
  serviceDid?: string
  publisherDid?: string
  /** Problems with the setup, shown at the top. */
  warnings: string[]
  /** Results of the last action, e.g. "Published Cat Pics", and errors loading the page. */
  messages: { text: string; kind: 'ok' | 'error' }[]
  /** Saved feeds that no longer validate. */
  broken: { id: string; error: string }[]
  /** Records pointing at this service with no feed behind them. */
  orphans: { id: string; displayName: string }[]
  /** The editor is available (a database is configured). */
  editable: boolean
  /** The owner's feeds served by other services, such as SkyFeed, that could be imported. */
  external: { id: string; displayName: string; service: string; importable: boolean }[]
  /** Where the database lives, shown to the signed-in owner only. */
  database?: { host: string; since?: string }
}

const DASHBOARD_CSS = `
.hero { position: relative; overflow: hidden; display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 20px; padding: 28px 24px; }
.hero > * { position: relative; }
.hero-text { display: grid; gap: 8px; min-width: 0; }
/* Feed rows receding into the sky: the one decorative flourish. */
.hero::before {
  content: ""; position: absolute; inset: 0 0 0 38%;
  background: repeating-linear-gradient(to bottom, var(--blue-wash) 0 9px, transparent 9px 21px);
  -webkit-mask: linear-gradient(to right, transparent, #000 55%), linear-gradient(to bottom, #000, transparent 92%);
  -webkit-mask-composite: source-in; mask: linear-gradient(to right, transparent, #000 55%) intersect, linear-gradient(to bottom, #000, transparent 92%);
}
.summary { display: flex; flex-wrap: wrap; gap: 8px; }
.feed-list { list-style: none; margin: 0; padding: 0; }
.feed { display: grid; grid-template-columns: 52px 1fr; gap: 16px; padding: 18px 20px; border-top: 1px solid var(--line); }
.feed:first-child { border-top: 0; }
.feed-main { display: grid; gap: 8px; min-width: 0; }
.feed-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.feed-title h3 { font-size: 1.08rem; }
.feed-desc { color: var(--ink-soft); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 68ch; }
.feed .actions { margin-top: 4px; }
.tile { width: 52px; height: 52px; border-radius: 13px; display: grid; place-items: center; overflow: hidden; flex: none;
  background: var(--blue-wash); color: var(--blue-strong); font: 750 1.25rem/1 var(--font-display); }
.tile img { width: 100%; height: 100%; object-fit: cover; }
.side-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; border-top: 1px solid var(--line); }
.side-row:first-child { border-top: 0; }
.section { display: grid; gap: 10px; }
.section > p { max-width: 68ch; }
.service { display: grid; gap: 4px; font-size: .84rem; color: var(--ink-soft); }
@media (max-width: 520px) {
  .hero { padding: 22px 18px; } .hero::before { inset: 0 0 0 55%; }
  .feed { grid-template-columns: 40px 1fr; gap: 12px; padding: 16px; } .tile { width: 40px; height: 40px; border-radius: 10px; font-size: 1rem; }
  .side-row { padding: 14px 16px; }
}
`

/** did:plc:igajsmjz7s5tmridacg5jz4i reads as did:plc:igaj…z4i; handles stay as they are. */
const shortActor = (actor: string) => (/^did:plc:[a-z0-9]{20,}$/.test(actor) ? `${actor.slice(0, 12)}…${actor.slice(-3)}` : actor)

function describeSource(source: FeedSource): string {
  switch (source.type) {
    case 'search':
      return `Search “${source.query}”`
    case 'author':
      return source.actors.length === 1 ? `Posts by ${shortActor(source.actors[0]!)}` : `Posts by ${source.actors.length} accounts`
    case 'list':
      return 'List members'
    case 'feed':
      return 'Another feed'
    case 'likes':
      return 'Your likes'
    case 'posts':
      return `${source.posts.length} hand-picked posts`
  }
}

const SORT_LABELS: Record<FeedDefinition['sort'], string> = { newest: 'Newest first', hot: 'Hot', top: 'Top' }

const STATUS_PILLS: Record<PublishStatus, Html> = {
  published: html`<span class="pill live">Live in Bluesky</span>`,
  outdated: html`<span class="pill warn">Name or description changed</span>`,
  elsewhere: html`<span class="pill warn">Hosted by another service</span>`,
  unpublished: html`<span class="pill">Not published</span>`,
}

const postButton = (action: string, label: string, kind = 'secondary', confirm?: string) =>
  html`<form method="post" action="${action}" ${confirm ? raw(`onsubmit="return confirm(${escapeAttrJson(confirm)})"`) : ''}>
    <button class="${kind}" type="submit">${label}</button>
  </form>`

/** JSON-encodes a string for use inside a double-quoted HTML attribute. */
function escapeAttrJson(value: string): string {
  return JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** A feed's avatar, or its initial on a tinted tile. */
function tile(name: string, avatar?: string, className = 'tile'): Html {
  return avatar
    ? html`<span class="${className}"><img src="${avatar}" alt="" loading="lazy" /></span>`
    : html`<span class="${className}" aria-hidden="true">${[...name.trim()][0]?.toUpperCase() ?? '?'}</span>`
}

/** A friendlier name for well-known feed services. */
export function serviceName(did: string): string {
  if (did === 'did:web:skyfeed.me') return 'SkyFeed'
  return did.replace(/^did:web:/, '')
}

function feedRow(feed: DashboardFeed, model: DashboardModel): Html {
  const { def, origin, status } = feed
  const signedIn = model.viewer.signedIn
  const live = status === 'published' || status === 'outdated'
  const publishLabel =
    status === 'published'
      ? 'Publish settings'
      : status === 'outdated'
        ? 'Update in Bluesky'
        : status === 'elsewhere'
          ? `Move to ${SITE_NAME}`
          : 'Publish'
  return html`<li class="feed">
    ${tile(def.displayName, feed.avatar)}
    <div class="feed-main">
      <div class="feed-title"><h3>${def.displayName}</h3>${status ? STATUS_PILLS[status] : ''}</div>
      ${def.description ? html`<p class="feed-desc">${def.description}</p>` : ''}
      <div class="chips">
        <span class="chip mono" title="Feed id">${def.id}</span>
        <span class="chip">${SORT_LABELS[def.sort]}</span>
        ${def.sources.map((s) => html`<span class="chip">${describeSource(s)}</span>`)}
        ${def.remember ? html`<span class="chip">Remembers posts</span>` : ''}
        ${def.filter ? html`<span class="chip">Custom filter</span>` : ''}
        ${origin === 'code' && model.editable ? html`<span class="chip">Defined in code</span>` : ''}
      </div>
      <div class="actions">
        ${signedIn ? html`<a class="button${status === 'published' ? ' secondary' : ''}" href="/feeds/${def.id}/publish">${publishLabel}</a>` : ''}
        ${signedIn && origin === 'editor' ? html`<a class="button secondary" href="/feeds/${def.id}/edit">Edit</a>` : ''}
        <a class="button secondary" href="/feeds/${def.id}">Preview</a>
        ${model.publisherDid && live ? html`<a href="${feedUrl(model.publisherDid, def.id)}">Open in Bluesky ↗</a>` : ''}
      </div>
    </div>
  </li>`
}

/** "2 live · 1 not published", from the statuses that are known. */
function summaryPills(feeds: DashboardFeed[]): Html {
  const count = (pred: (f: DashboardFeed) => boolean) => feeds.filter(pred).length
  const live = count((f) => f.status === 'published' || f.status === 'outdated')
  const unpublished = count((f) => f.status === 'unpublished')
  const elsewhere = count((f) => f.status === 'elsewhere')
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return html`<div class="summary">
    <span class="chip">${plural(feeds.length, 'feed')}</span>
    ${live ? html`<span class="pill live">${live} live</span>` : ''}
    ${unpublished ? html`<span class="pill">${unpublished} not published</span>` : ''}
    ${elsewhere ? html`<span class="pill warn">${elsewhere} on another service</span>` : ''}
  </div>`
}

export function dashboardPage(model: DashboardModel): Html {
  const { viewer, feeds } = model
  return layout(
    SITE_NAME,
    html`<style>${raw(DASHBOARD_CSS)}</style>
      <section class="panel hero">
        <div class="hero-text">
          <p class="eyebrow">Your Bluesky feeds</p>
          <h1>Feeds</h1>
          ${summaryPills(feeds)}
        </div>
        ${viewer.signedIn
          ? html`<div class="actions">
              <a class="button secondary" href="/feeds/import">Import</a>
              <a class="button" href="/feeds/new">New feed</a>
            </div>`
          : viewer.canSignIn
            ? html`<a class="button" href="/login">Sign in to manage feeds</a>`
            : ''}
      </section>
      ${model.messages.map((m) => notice(m.text, m.kind))}
      ${model.warnings.map((w) => notice(w))}

      ${feeds.length
        ? html`<ul class="panel feed-list">${feeds.map((f) => feedRow(f, model))}</ul>`
        : html`<div class="panel empty">
            <h2>No feeds yet</h2>
            <p class="muted">${viewer.signedIn ? 'Create one with New feed, or import one from SkyFeed.' : 'Sign in to create your first feed.'}</p>
          </div>`}

      ${model.external.length && viewer.signedIn
        ? html`<section class="section">
            <h2>On other services</h2>
            <p class="muted small">
              Import one to rebuild it here. Publishing it afterwards moves the feed itself, so anyone who pinned or liked it
              keeps it.
            </p>
            <div class="panel">
              ${model.external.map(
                (f) => html`<div class="side-row">
                  <div class="feed-title"><h3>${f.displayName}</h3><span class="chip">${serviceName(f.service)}</span></div>
                  ${f.importable
                    ? html`<a class="button secondary" href="/feeds/import?from=${encodeURIComponent(f.id)}">Import</a>`
                    : html`<span class="muted small">Settings not readable; recreate it with New feed</span>`}
                </div>`,
              )}
            </div>
          </section>`
        : ''}

      ${model.broken.length && viewer.signedIn
        ? html`<section class="section">
            <h2>Need fixing</h2>
            <div class="panel">
              ${model.broken.map(
                (b) => html`<div class="side-row" style="display:grid">
                  <h3 class="mono">${b.id}</h3>
                  ${notice(b.error, 'error')}
                  <div class="actions">
                    <a class="button secondary" href="/feeds/${b.id}/edit">Edit</a>
                    ${postButton(`/feeds/${b.id}/delete`, 'Delete', 'danger', `Delete ${b.id}?`)}
                  </div>
                </div>`,
              )}
            </div>
          </section>`
        : ''}

      ${model.orphans.length && viewer.signedIn
        ? html`<section class="section">
            <h2>Published but missing</h2>
            <p class="muted small">
              These feeds are in Bluesky and point here, but ${SITE_NAME} has no settings for them, so Bluesky shows an error.
              Recreate one to bring it back at the same link. If you didn't delete them, ${SITE_NAME} may be connected to a
              different database than before.
            </p>
            <div class="panel">
              ${model.orphans.map(
                (o) => html`<div class="side-row">
                  <div class="feed-title"><h3>${o.displayName || o.id}</h3><code>${o.id}</code></div>
                  <div class="actions">
                    <a class="button" href="/feeds/import?from=${encodeURIComponent(o.id)}">Recreate</a>
                    ${postButton(
                      `/feeds/${o.id}/unpublish`,
                      'Unpublish',
                      'danger',
                      `Remove ${o.displayName || o.id} from Bluesky? Anyone who pinned or liked it loses it.`,
                    )}
                  </div>
                </div>`,
              )}
            </div>
          </section>`
        : ''}

      <footer class="service">
        ${model.editable
          ? ''
          : html`<p>
              Feeds are defined in <code>feeds/</code>. After adding or renaming one, run <code>npm run publish-feeds</code>.
              Set up a database to create and publish feeds from this page instead.
            </p>`}
        <p>Service <code>${model.serviceDid ?? 'unknown'}</code></p>
        ${model.publisherDid ? html`<p>Publisher <code>${model.publisherDid}</code></p>` : ''}
        ${viewer.signedIn && model.database
          ? html`<p>Database <code>${model.database.host}</code>${model.database.since ? html`, first used ${model.database.since}` : ''}</p>`
          : ''}
      </footer>`,
    viewer,
    { current: 'feeds' },
  )
}

const postLink = (post: PostView) => `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`

function timeAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 60 / 24)}d`
}

function thumbsOf(post: PostView): string[] {
  const embed = post.embed as { $type?: string; images?: { thumb: string }[]; thumbnail?: string; media?: unknown } | undefined
  const media = (embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.media : embed) as typeof embed
  if (media?.$type === 'app.bsky.embed.images#view') return (media.images ?? []).slice(0, 4).map((i) => i.thumb)
  if (media?.$type === 'app.bsky.embed.video#view' && media.thumbnail) return [media.thumbnail]
  return []
}

const count = (n: number | undefined) => (n ?? 0).toLocaleString('en-US')

function postRow(post: PostView, now: number, note?: string): Html {
  const record = post.record as { text?: string }
  const thumbs = thumbsOf(post)
  return html`<article class="post">
    ${post.author.avatar ? html`<img class="avatar" src="${post.author.avatar}" alt="" loading="lazy" />` : html`<span class="avatar"></span>`}
    <div class="body">
      ${note ? html`<div class="note">${note}</div>` : ''}
      <div class="who">
        <strong>${post.author.displayName || post.author.handle}</strong>
        <span class="handle">@${post.author.handle}</span>
        <a class="time" href="${postLink(post)}">${timeAgo(post.indexedAt, now)}</a>
      </div>
      ${record.text ? html`<p class="text">${record.text}</p>` : ''}
      ${thumbs.length ? html`<div class="thumbs">${thumbs.map((t) => html`<img src="${t}" alt="" loading="lazy" />`)}</div>` : ''}
      <div class="stats" aria-label="Engagement">
        <span title="Replies">↩ ${count(post.replyCount)}</span>
        <span title="Reposts">⟲ ${count(post.repostCount)}</span>
        <span title="Likes">♥ ${count(post.likeCount)}</span>
      </div>
    </div>
  </article>`
}

const repostNote = (c: Candidate) => (c.repost ? `Reposted by ${c.repost.by.displayName || c.repost.by.handle}` : undefined)

/** The rendered list of posts, shared by the preview page, the editor and the playground. */
export function previewFragment(result: PreviewResult, now = Date.now()): Html {
  const empty = !result.items.length && !result.pinned.length
  return html`${result.errors.length ? notice(result.errors.join('\n'), 'error') : ''}
    <div class="timeline">
      ${result.pinned.map((p) => postRow(p, now, 'Pinned'))}
      ${result.items.map((c) => postRow(c.post, now, repostNote(c)))}
      ${empty ? html`<p class="empty">No posts matched. Try loosening the filters.</p>` : ''}
    </div>`
}

function fetchedAgo(builtAt: number): string {
  const ago = timeAgo(new Date(builtAt).toISOString(), Date.now())
  return ago === 'now' ? 'just now' : `${ago} ago`
}

export function previewPage(feed: FeedDefinition, result: PreviewResult, viewer: Viewer): Html {
  return layout(
    `${feed.displayName} · ${SITE_NAME}`,
    html`<style>${raw(DASHBOARD_CSS)}</style>
      <div class="page-head">
        <div style="grid-template-columns:auto 1fr;align-items:center;column-gap:14px">
          ${tile(feed.displayName)}
          <div style="display:grid;gap:4px;min-width:0">
            <h1>${feed.displayName}</h1>
            <p class="muted small">
              <span class="mono">${feed.id}</span> · first ${result.items.length} posts · fetched ${fetchedAgo(result.builtAt)}
            </p>
          </div>
        </div>
        ${viewer.signedIn ? html`<a class="button secondary" href="/feeds/${feed.id}/publish">Publish settings</a>` : ''}
      </div>
      ${feed.description ? html`<p class="lede">${feed.description}</p>` : ''}
      ${previewFragment(result)}`,
    viewer,
    { current: 'feeds' },
  )
}

export function errorPage(title: string, message: string, viewer?: Viewer): Html {
  return layout(
    `${title} · ${SITE_NAME}`,
    html`<div class="page-head"><h1>${title}</h1></div>
      ${notice(message, 'error')}
      <p><a class="button secondary" href="/">Back to feeds</a></p>`,
    viewer,
  )
}

const WELCOME_CSS = `
/* Welcome: a bright sky behind everything, with clouds, sparkles and little feed cards drifting past. */
body.welcome {
  --sky-top: #cfe1ff; --sky-mid: #eaf2ff; --sky-low: #fff4ea;
  --cloud: #ffffff; --cloud-opacity: .85; --spark: #ffb020; --spark-2: #5c9dff;
  --coral: #ff7a59; --mint: #20b486; --sun: #ffb020; --violet: #8b5cf6;
  background: var(--sky-mid);
}
@media (prefers-color-scheme: dark) {
  body.welcome {
    --sky-top: #070d1a; --sky-mid: #0d1830; --sky-low: #1b1733;
    --cloud: #9db8e8; --cloud-opacity: .07; --spark: #ffe7a8; --spark-2: #cfe0ff;
  }
}
body.welcome .topbar { background: transparent; border-bottom-color: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; position: static; }
body.welcome main { padding-block: 12px 56px; overflow-x: clip; }

.sky { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none;
  background: linear-gradient(180deg, var(--sky-top) 0%, var(--sky-mid) 42%, var(--sky-low) 100%); }
.glow { position: absolute; border-radius: 50%; animation: drift 26s ease-in-out infinite alternate; }
.glow.g1 { width: 46vmax; height: 46vmax; left: -14vmax; top: -18vmax; background: radial-gradient(circle, color-mix(in srgb, var(--blue) 28%, transparent), transparent 68%); }
.glow.g2 { width: 40vmax; height: 40vmax; right: -12vmax; top: 22vh; background: radial-gradient(circle, color-mix(in srgb, var(--coral) 20%, transparent), transparent 68%); animation-duration: 32s; }
.glow.g3 { width: 38vmax; height: 38vmax; left: 18vw; bottom: -24vmax; background: radial-gradient(circle, color-mix(in srgb, var(--mint) 18%, transparent), transparent 68%); animation-duration: 38s; }
@keyframes drift { to { transform: translate(4vw, 3vh) scale(1.08); } }

.cloud { position: absolute; fill: var(--cloud); opacity: var(--cloud-opacity); animation: sail linear infinite; }
.cloud.c1 { width: 230px; top: 12vh; left: -260px; animation-duration: 95s; }
.cloud.c2 { width: 150px; top: 58vh; left: -200px; animation-duration: 120s; animation-delay: -60s; }
.cloud.c3 { width: 300px; top: 78vh; left: -320px; animation-duration: 140s; animation-delay: -100s; }
.cloud.c4 { width: 120px; top: 30vh; left: -160px; animation-duration: 80s; animation-delay: -30s; }
@keyframes sail { to { transform: translateX(calc(100vw + 360px)); } }

.spark { position: absolute; width: 14px; height: 14px; background: var(--spark);
  clip-path: polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%); animation: twinkle 3.2s ease-in-out infinite; }
.spark:nth-child(even) { background: var(--spark-2); width: 10px; height: 10px; }
@keyframes twinkle { 0%, 100% { transform: scale(.55) rotate(0); opacity: .45; } 50% { transform: scale(1.15) rotate(20deg); opacity: 1; } }

.flier { position: absolute; width: 168px; padding: 10px 12px; display: grid; grid-template-columns: 26px 1fr; gap: 4px 9px; align-items: center;
  background: color-mix(in srgb, var(--surface) 88%, transparent); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 14px; box-shadow: 0 10px 30px rgb(14 26 43 / 10%); animation: bob 7s ease-in-out infinite alternate; opacity: .85; }
.flier i { width: 26px; height: 26px; border-radius: 50%; grid-row: span 2; background: var(--c, var(--blue)); }
.flier b { height: 7px; border-radius: 4px; background: var(--sunken); }
.flier b + b { width: 64%; }
.flier small { grid-column: 2; font: 600 .7rem/1 var(--font-body); color: var(--c, var(--blue)); }
@keyframes bob { from { translate: 0 0; } to { translate: 0 -16px; } }
.flier.f1 { bottom: 5vh; left: 4vw; rotate: -7deg; --c: var(--coral); }
.flier.f2 { top: 8vh; left: 36vw; rotate: 5deg; --c: var(--mint); animation-duration: 8.5s; }
.flier.f3 { top: 9vh; right: 5vw; rotate: 6deg; --c: var(--violet); animation-duration: 6.5s; }
.flier.f4 { bottom: 9vh; right: 9vw; rotate: -4deg; --c: var(--sun); animation-duration: 9s; }
.flier.f5 { top: 64vh; left: 48vw; rotate: 3deg; --c: var(--blue); animation-duration: 7.5s; opacity: .6; }
.trail { position: absolute; top: 4vh; right: 14vw; width: 300px; color: color-mix(in srgb, var(--blue) 45%, transparent); }
/* Narrower screens keep only the fliers that sit clear of the text. */
@media (max-width: 1200px) { .flier.f1, .flier.f2, .flier.f5 { display: none; } }
@media (max-width: 880px) { .flier { opacity: .5; } .flier.f4, .trail { display: none; } .flier.f3 { top: 2vh; right: -50px; } }

.welcome-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); grid-template-areas: "intro card" "perks card";
  column-gap: clamp(32px, 6vw, 80px); row-gap: 28px; align-items: center; align-content: center; min-height: calc(100vh - 150px); }
.intro { grid-area: intro; display: grid; gap: 18px; align-self: end; }
.perks { grid-area: perks; align-self: start; }
.login { grid-area: card; }
@media (max-width: 880px) {
  .welcome-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "intro" "card" "perks"; min-height: 0; }
}
.hello { justify-self: start; display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px 6px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 80%, transparent); border: 1px solid var(--line); font-size: .86rem; font-weight: 600; color: var(--ink-soft); }
.hello .wave { display: inline-block; font-size: 1.05rem; transform-origin: 70% 70%; animation: wave 2.6s ease-in-out infinite; }
@keyframes wave { 0%, 60%, 100% { transform: rotate(0); } 10%, 30% { transform: rotate(16deg); } 20%, 40% { transform: rotate(-8deg); } }
.intro h1 { font-size: clamp(2.4rem, 6vw, 4rem); font-weight: 800; letter-spacing: -0.03em; line-height: 1.02; }
.intro h1 em { font-style: normal; position: relative; white-space: nowrap;
  background: linear-gradient(100deg, var(--blue) 10%, var(--violet) 55%, var(--coral) 95%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.intro h1 em svg { position: absolute; left: 0; right: 0; bottom: -.16em; width: 100%; height: .3em; color: var(--sun); overflow: visible; }
.intro .lede { font-size: 1.12rem; max-width: 46ch; }

.perks { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.perks li { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; align-items: center; }
.perks .ico { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: color-mix(in srgb, var(--c) 16%, var(--surface)); color: var(--c); }
.perks .ico svg { width: 20px; height: 20px; }
.perks strong { display: block; font-weight: 700; }
.perks span { color: var(--ink-soft); font-size: .93rem; }

.login { width: 100%; max-width: 440px; justify-self: center; position: relative; }
.login::before { content: ""; position: absolute; inset: -10px; z-index: -1; border-radius: calc(var(--radius) + 10px); transform: rotate(-2.5deg);
  background: linear-gradient(135deg, color-mix(in srgb, var(--blue) 30%, transparent), color-mix(in srgb, var(--coral) 26%, transparent)); }
.login .panel-body { padding: 30px; gap: 18px; }
.login .mark { display: block; width: 46px; height: 46px; color: var(--blue); }
.login .mark svg { width: 100%; height: 100%; display: block; }
.login h2 { font-size: 1.6rem; }
.login button { width: 100%; min-height: 48px; font-size: 1rem; white-space: normal; text-align: center; line-height: 1.3; padding-block: 10px; }
.login details { font-size: .9rem; border-top: 1px solid var(--line); padding-top: 14px; }
.login summary { cursor: pointer; font-weight: 600; color: var(--ink-soft); }
.login summary:hover { color: var(--ink); }
.perms { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.perms li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.perms .yes::before { content: "✓"; color: var(--live); font-weight: 700; }
.perms .no::before { content: "×"; color: var(--ink-soft); font-weight: 700; }
@media (max-width: 520px) { .login .panel-body { padding: 22px; } .login::before { inset: -6px; } }
`

const CLOUD = '<svg class="cloud CLASS" viewBox="0 0 200 90"><circle cx="58" cy="56" r="30"/><circle cx="100" cy="40" r="38"/><circle cx="146" cy="56" r="28"/><rect x="38" y="54" width="128" height="32" rx="16"/></svg>'

/** The drifting scenery behind the welcome page. Purely decorative. */
const SKY = `<div class="sky" aria-hidden="true">
  <span class="glow g1"></span><span class="glow g2"></span><span class="glow g3"></span>
  ${['c1', 'c2', 'c3', 'c4'].map((c) => CLOUD.replace('CLASS', c)).join('')}
  <svg class="trail" viewBox="0 0 300 120" fill="none"><path d="M4 110 C 70 100, 90 30, 160 46 S 250 70, 270 22" stroke="currentColor" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/><path d="M262 14 l28 -8 -10 27 -6 -11 z" fill="currentColor"/></svg>
  ${[
    [8, 30],
    [14, 72],
    [22, 48],
    [6, 88],
    [34, 92],
    [48, 6],
    [70, 14],
    [82, 40],
    [90, 70],
    [62, 84],
    [40, 38],
    [76, 60],
  ]
    .map(([top, left], i) => `<span class="spark" style="top:${top}vh;left:${left}vw;animation-delay:${(i * 0.37) % 3}s"></span>`)
    .join('')}
  <div class="flier f1"><i></i><b></b><b></b><small>♥ 128</small></div>
  <div class="flier f2"><i></i><b></b><b></b><small>↻ 42</small></div>
  <div class="flier f3"><i></i><b></b><b></b><small>♥ 1.2k</small></div>
  <div class="flier f4"><i></i><b></b><b></b><small>★ new</small></div>
  <div class="flier f5"><i></i><b></b><b></b><small>♥ 9</small></div>
</div>`

const ICONS = {
  mix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  shape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  publish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/></svg>',
}

const SQUIGGLE = '<svg viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true"><path d="M2 14 C 30 2, 50 2, 70 12 S 120 20, 140 9 S 180 2, 198 10" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/></svg>'

/** The page signed-out visitors see: what Blue Feeds is, and the sign-in form. No feeds are shown until they sign in. */
export function loginPage(viewer: Viewer, opts: { handle?: string; error?: string; setupProblem?: string; message?: string }): Html {
  return layout(
    `Welcome · ${SITE_NAME}`,
    html`<style>${raw(WELCOME_CSS)}</style>
      ${raw(SKY)}
      <div class="welcome-grid">
        <div class="intro">
          <span class="hello"><span class="wave" aria-hidden="true">👋</span> Hi there, welcome to ${SITE_NAME}</span>
          <h1>Bluesky feeds that feel like <em>yours${raw(SQUIGGLE)}</em></h1>
          <p class="lede">
            Gather posts by keyword, people, lists or likes. Filter out the noise, watch your feed come together live, and
            share it from your own profile.
          </p>
        </div>
        <ul class="perks">
          <li style="--c: var(--blue)">
            <span class="ico">${raw(ICONS.mix)}</span>
            <div><strong>Mix any sources</strong><span>Searches, accounts, lists, likes and other feeds.</span></div>
          </li>
          <li style="--c: var(--violet)">
            <span class="ico">${raw(ICONS.shape)}</span>
            <div><strong>Shape it your way</strong><span>Skip replies, mute words, sort by newest, top or hot.</span></div>
          </li>
          <li style="--c: var(--coral)">
            <span class="ico">${raw(ICONS.publish)}</span>
            <div><strong>Publish in a click</strong><span>It shows up on your profile for anyone to follow.</span></div>
          </li>
        </ul>
        <section class="login panel" aria-labelledby="signin-title">
          <div class="panel-body">
            <span class="mark">${raw(MARK)}</span>
            <div style="display: grid; gap: 6px">
              <h2 id="signin-title">Sign in with Bluesky</h2>
              <p class="muted">Use your own Bluesky handle. You approve access on Bluesky's page, so ${SITE_NAME} never sees your password.</p>
            </div>
            ${opts.message ? notice(opts.message, 'ok') : ''}
            ${opts.error ? notice(opts.error, 'error') : ''}
            ${opts.setupProblem
              ? notice(opts.setupProblem, 'error')
              : html`<form method="post" action="/login" class="fields">
                    <div class="field">
                      <label for="handle">Your Bluesky handle</label>
                      <input id="handle" name="handle" value="${opts.handle ?? ''}" placeholder="you.bsky.social" required
                        autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" />
                    </div>
                    <button type="submit">Continue with Bluesky</button>
                  </form>
                  <p class="hint">${SITE_NAME} is invite-only. If you're turned away, ask the person who runs it to add your handle.</p>
                  <details>
                    <summary>What ${SITE_NAME} can and can't do</summary>
                    <ul class="perms">
                      <li class="yes"><span>Create, update and remove your feeds</span></li>
                      <li class="yes"><span>Upload feed avatars</span></li>
                      <li class="yes"><span>Run searches and read your likes, for feeds built from them</span></li>
                      <li class="no"><span>Can't post, follow, change your profile or read messages</span></li>
                    </ul>
                  </details>`}
          </div>
        </section>
      </div>`,
    viewer,
    { welcome: true },
  )
}

const PUBLISH_CSS = `
.avatar-picker { display: flex; gap: 18px; align-items: flex-start; }
.avatar-picker > div { display: grid; gap: 10px; min-width: 0; flex: 1; }
.avatar-preview { flex: none; width: 104px; height: 104px; border-radius: 22px; overflow: hidden; background: var(--sunken);
  border: 1px solid var(--line); display: grid; place-items: center; color: var(--ink-soft); font-size: .78rem; text-align: center;
  transition: opacity .15s; }
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
.avatar-preview.removed { opacity: .3; }
.confirm { padding: 14px; border-radius: var(--radius-sm); background: var(--warn-wash); color: var(--warn); font-weight: 600; }
.danger-zone { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
@media (max-width: 460px) { .avatar-picker { flex-direction: column; } }
`

/** Shows a chosen image before it's uploaded, and catches the size and type limits early. */
const AVATAR_JS = `
(() => {
  const input = document.getElementById('avatar'), preview = document.getElementById('avatar-preview');
  const status = document.getElementById('avatar-status'), remove = document.getElementById('remove-avatar');
  const original = preview.innerHTML, originalStatus = status.textContent;
  let objectUrl;
  const reset = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    preview.innerHTML = original;
    status.textContent = originalStatus;
  };
  input.addEventListener('change', () => {
    const file = input.files[0];
    reset();
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      input.value = '';
      status.textContent = "That file isn't a PNG or JPEG.";
      return;
    }
    if (file.size > 1000000) {
      input.value = '';
      status.textContent = 'That image is ' + (file.size / 1e6).toFixed(1) + ' MB. It has to be under 1 MB.';
      return;
    }
    objectUrl = URL.createObjectURL(file);
    preview.innerHTML = '';
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = 'New avatar';
    preview.append(img);
    preview.classList.remove('removed');
    status.textContent = 'New avatar. It replaces the current one when you publish.';
    if (remove) remove.checked = false;
  });
  if (remove) remove.addEventListener('change', () => {
    if (remove.checked) {
      input.value = '';
      reset();
      status.textContent = 'The avatar will be removed when you publish.';
    } else {
      reset();
    }
    preview.classList.toggle('removed', remove.checked);
  });
})();
`

export function publishPage(
  feed: FeedDefinition,
  opts: {
    viewer: Viewer
    status: PublishStatus
    hasAvatar: boolean
    /** The current avatar's image address, for the preview. */
    avatarUrl?: string
    feedLink?: string
    error?: string
    blocked?: string
    /** The service currently serving this feed id, when it isn't this one. */
    currentService?: string
  },
): Html {
  const moving = opts.status === 'elsewhere'
  const live = opts.status === 'published' || opts.status === 'outdated'
  const from = serviceName(opts.currentService ?? 'another service')
  const title = moving ? `Move ${feed.displayName}` : live ? `Update ${feed.displayName}` : `Publish ${feed.displayName}`
  return layout(
    `${title} · ${SITE_NAME}`,
    html`<style>${raw(PUBLISH_CSS)}</style>
      <div class="page-head">
        <div>
          <p class="eyebrow">${moving ? `From ${from} to ${SITE_NAME}` : live ? 'Published feed' : 'Publish to Bluesky'}</p>
          <h1>${title}</h1>
        </div>
        ${opts.feedLink && live ? html`<a href="${opts.feedLink}">Open in Bluesky ↗</a>` : ''}
      </div>
      <p class="lede">
        ${moving
          ? html`Your Bluesky feed with the id <code>${feed.id}</code> is currently served by ${from}. Moving it here keeps its
              link, likes and pins, and switches what it shows to this feed's sources and filters. ${from}'s settings stay in
              the feed, so republishing it there moves it back.`
          : html`Publishing adds this feed to your Bluesky profile, where anyone can find, pin and share it. Changes to
              sources and filters apply straight away; publish again only after changing the name, description or avatar.`}
      </p>
      ${opts.error ? notice(opts.error, 'error') : ''}
      ${opts.blocked ? notice(opts.blocked, 'error') : ''}
      <form class="panel" method="post" action="/feeds/${feed.id}/publish" enctype="multipart/form-data">
        <div class="panel-body" style="gap:22px">
          <div style="display:grid;gap:6px">
            <div class="feed-title"><h2>${feed.displayName}</h2>${STATUS_PILLS[opts.status]}</div>
            ${feed.description ? html`<p class="muted">${feed.description}</p>` : ''}
          </div>
          <div class="field">
            <label for="avatar">Avatar</label>
            <div class="avatar-picker">
              <div class="avatar-preview" id="avatar-preview">
                ${opts.avatarUrl
                  ? html`<img src="${opts.avatarUrl}" alt="Current avatar" />`
                  : html`<span>${opts.hasAvatar ? 'Current avatar' : 'No avatar'}</span>`}
              </div>
              <div>
                <p class="small muted" id="avatar-status">
                  ${opts.hasAvatar ? 'Current avatar. It stays unless you choose a new one.' : 'No avatar yet.'}
                </p>
                <input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg" />
                <p class="hint" style="margin:0">Square PNG or JPEG, under 1 MB.</p>
                ${opts.hasAvatar
                  ? html`<label class="check"><input type="checkbox" id="remove-avatar" name="removeAvatar" />Remove the current avatar</label>`
                  : ''}
              </div>
            </div>
          </div>
          ${moving
            ? html`<label class="check confirm"><input type="checkbox" name="takeover" required />Move this feed from ${from} to
                ${SITE_NAME}</label>`
            : ''}
          <div class="actions">
            <button type="submit" ${opts.blocked ? 'disabled' : ''}>
              ${moving ? `Move to ${SITE_NAME}` : live ? 'Update in Bluesky' : 'Publish to Bluesky'}
            </button>
            <a class="button secondary" href="/">Cancel</a>
          </div>
        </div>
      </form>
      <script>${raw(AVATAR_JS)}</script>
      ${live
        ? html`<section class="panel"><div class="panel-body danger-zone">
            <div style="display:grid;gap:4px"><h3>Unpublish</h3>
              <p class="muted small">Removes the feed from Bluesky. Anyone who pinned or saved it loses it.</p></div>
            ${postButton(`/feeds/${feed.id}/unpublish`, 'Unpublish', 'danger', `Remove ${feed.displayName} from Bluesky?`)}
          </div></section>`
        : ''}`,
    opts.viewer,
    { current: 'feeds' },
  )
}

export function importPage(viewer: Viewer, opts: { text?: string; error?: string } = {}): Html {
  return layout(
    `Import · ${SITE_NAME}`,
    html`<div class="page-head"><div><p class="eyebrow">Import</p><h1>Bring a feed over</h1></div></div>
      <p class="lede">
        Paste a SkyFeed feed's settings (the JSON from its export or record), a ${SITE_NAME} definition, or the feed's
        bsky.app link. You'll review everything in the editor before anything is saved.
      </p>
      ${opts.error ? notice(opts.error, 'error') : ''}
      <form class="panel" method="post" action="/feeds/import">
        <div class="panel-body">
          <div class="field">
            <label for="text">Feed link or JSON</label>
            <textarea class="code" id="text" name="text" spellcheck="false" style="min-height:200px"
              placeholder="https://bsky.app/profile/you.bsky.social/feed/…">${opts.text ?? ''}</textarea>
          </div>
          <div class="actions">
            <button type="submit">Continue</button>
            <a class="button secondary" href="/">Cancel</a>
          </div>
        </div>
      </form>`,
    viewer,
    { current: 'feeds' },
  )
}

const PLAYGROUND_EXAMPLE = JSON.stringify(
  {
    id: 'playground',
    displayName: 'Playground',
    sources: [{ type: 'author', actors: ['bsky.app'] }],
    filters: { excludeReplies: true, maxAgeHours: 720 },
    sort: 'newest',
  },
  null,
  2,
)

export function playgroundPage(viewer: Viewer, opts: { tokenEnabled: boolean }): Html {
  const needsToken = !viewer.signedIn
  if (needsToken && !opts.tokenEnabled) {
    return layout(
      `Playground · ${SITE_NAME}`,
      html`<div class="page-head"><h1>Playground</h1></div>
        ${notice(
          viewer.canSignIn
            ? html`<a href="/login">Sign in</a> to use the playground.`
            : 'Set ADMIN_TOKEN to enable the playground. It keeps strangers from running searches with your account.',
        )}`,
      viewer,
      { current: 'playground' },
    )
  }
  return layout(
    `Playground · ${SITE_NAME}`,
    html`<div class="page-head"><div><p class="eyebrow">For tinkering</p><h1>Playground</h1></div></div>
      <p class="lede">
        Try a feed definition as JSON, in the same format as the files in <code>feeds/</code>. Nothing is saved. Custom
        <code>filter</code> functions only work in feed files.
      </p>
      <form class="panel" id="form">
        <div class="panel-body">
          <div class="field">
            <label for="definition">Feed definition</label>
            <textarea class="code" id="definition" spellcheck="false">${PLAYGROUND_EXAMPLE}</textarea>
          </div>
          ${needsToken
            ? html`<div class="field"><label for="token">Admin token</label><input id="token" type="password" autocomplete="current-password" /></div>`
            : ''}
          <div class="actions"><button id="run" type="submit">Preview</button></div>
        </div>
      </form>
      <div id="results"></div>
      <script>
        ${raw(`
        const form = document.getElementById('form'), run = document.getElementById('run');
        const token = document.getElementById('token'), definition = document.getElementById('definition');
        const results = document.getElementById('results');
        try { if (token) token.value = localStorage.getItem('adminToken') || ''; definition.value = localStorage.getItem('definition') || definition.value; } catch {}
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try { if (token) localStorage.setItem('adminToken', token.value); localStorage.setItem('definition', definition.value); } catch {}
          run.disabled = true; run.textContent = 'Loading…';
          const headers = { 'content-type': 'application/json' };
          if (token) headers.authorization = 'Bearer ' + token.value;
          try {
            const res = await fetch('/api/preview?format=html', { method: 'POST', headers, body: definition.value });
            results.innerHTML = await res.text();
          } catch (err) {
            results.textContent = String(err);
          } finally {
            run.disabled = false; run.textContent = 'Preview';
          }
        });
        `)}
      </script>`,
    viewer,
    { current: 'playground' },
  )
}
