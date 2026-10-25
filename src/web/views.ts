import { html, raw } from 'hono/html'
import type { FeedDefinition, FeedSource } from '../feeds/define.js'
import type { PreviewResult } from '../feeds/engine.js'
import type { Candidate, PostView } from '../feeds/post.js'
import { type PublishStatus, feedUrl } from '../publish.js'
import { type Html, SITE_NAME, type Viewer, layout, notice } from './layout.js'

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

const LOGIN_CSS = `
.login { max-width: 460px; width: 100%; margin: 4vh auto 0; }
.login .panel-body { padding: 28px; gap: 18px; }
.login .mark { width: 48px; height: 48px; color: var(--blue); }
.perms { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; font-size: .94rem; }
.perms li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: baseline; }
.perms .yes::before { content: "✓"; color: var(--live); font-weight: 700; }
.perms .no::before { content: "×"; color: var(--ink-soft); font-weight: 700; }
.login button { width: 100%; min-height: 46px; font-size: 1rem; white-space: normal; text-align: center; line-height: 1.3; padding-block: 10px; }
`

export function loginPage(viewer: Viewer, opts: { owner?: string; error?: string; setupProblem?: string }): Html {
  return layout(
    `Sign in · ${SITE_NAME}`,
    html`<style>${raw(LOGIN_CSS)}</style>
      <section class="login panel">
        <div class="panel-body">
          <h1>Sign in to ${SITE_NAME}</h1>
          ${opts.error ? notice(opts.error, 'error') : ''}
          ${opts.setupProblem
            ? notice(opts.setupProblem, 'error')
            : html`<p class="muted">
                  You approve access on Bluesky's own sign-in page. ${SITE_NAME} never sees your password.
                </p>
                <ul class="perms" aria-label="What ${SITE_NAME} can do">
                  <li class="yes"><span>Create, update and remove your feeds</span></li>
                  <li class="yes"><span>Upload feed avatars</span></li>
                  <li class="yes"><span>Run searches and read your likes, for feeds built from them</span></li>
                  <li class="no"><span>Can't post, follow, change your profile or read messages</span></li>
                </ul>
                <form method="post" action="/login">
                  <button type="submit">Continue as ${opts.owner ?? 'the owner'}</button>
                </form>
                <p class="hint">Only the account set in BSKY_IDENTIFIER can sign in.</p>`}
        </div>
      </section>`,
    viewer,
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
