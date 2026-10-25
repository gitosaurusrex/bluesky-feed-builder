import { html, raw } from 'hono/html'
import type { FeedDefinition, FeedSource } from '../feeds/define.js'
import type { PreviewResult } from '../feeds/engine.js'
import type { Candidate, PostView } from '../feeds/post.js'
import { type PublishStatus, feedUrl } from '../publish.js'
import { type Html, type Viewer, layout, notice } from './layout.js'

export interface DashboardFeed {
  def: FeedDefinition
  origin: 'code' | 'editor'
  /** Only known when the owner is signed in, since it comes from their repo. */
  status?: PublishStatus
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
  orphans: string[]
  /** The editor is available (a database is configured). */
  editable: boolean
  /** The owner's feeds served by other services, such as SkyFeed, that could be imported. */
  external: { id: string; displayName: string; service: string; importable: boolean }[]
}

function describeSource(source: FeedSource): string {
  switch (source.type) {
    case 'search':
      return `search “${source.query}”`
    case 'author':
      return source.actors.length === 1 ? `posts by ${source.actors[0]}` : `posts by ${source.actors.length} accounts`
    case 'list':
      return 'list members'
    case 'feed':
      return 'another feed'
    case 'likes':
      return 'your likes'
    case 'posts':
      return `${source.posts.length} hand-picked posts`
  }
}

const STATUS_BADGES: Record<PublishStatus, Html> = {
  published: html`<span class="badge ok">Live in Bluesky</span>`,
  outdated: html`<span class="badge warn">Name or description changed</span>`,
  elsewhere: html`<span class="badge warn">Hosted by another service</span>`,
  unpublished: html`<span class="badge">Not published</span>`,
}

const postButton = (action: string, label: string, kind = 'secondary', confirm?: string) =>
  html`<form method="post" action="${action}" ${confirm ? raw(`onsubmit="return confirm(${escapeAttrJson(confirm)})"`) : ''}>
    <button class="${kind}" type="submit">${label}</button>
  </form>`

/** JSON-encodes a string for use inside a double-quoted HTML attribute. */
function escapeAttrJson(value: string): string {
  return JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function feedCard(feed: DashboardFeed, model: DashboardModel): Html {
  const { def, origin, status } = feed
  const signedIn = model.viewer.signedIn
  const live = status === 'published' || status === 'outdated'
  return html`<div class="card">
    <div class="row">
      <strong>${def.displayName}</strong>
      ${status ? STATUS_BADGES[status] : ''}
    </div>
    ${def.description ? html`<div class="muted">${def.description}</div>` : ''}
    <div class="tags">
      <span class="tag">id: ${def.id}</span>
      <span class="tag">${def.sort}</span>
      ${def.sources.map((s) => html`<span class="tag">${describeSource(s)}</span>`)}
      ${def.filter ? html`<span class="tag">custom filter</span>` : ''}
      ${def.remember ? html`<span class="tag">remembers posts</span>` : ''}
      ${origin === 'code' && model.editable ? html`<span class="tag">defined in code</span>` : ''}
    </div>
    <div class="actions">
      <a class="button secondary" href="/feeds/${def.id}">Preview</a>
      ${signedIn && origin === 'editor' ? html`<a class="button secondary" href="/feeds/${def.id}/edit">Edit</a>` : ''}
      ${signedIn
        ? html`<a class="button${status === 'published' ? ' secondary' : ''}" href="/feeds/${def.id}/publish">${
            status === 'published'
              ? 'Publish settings'
              : status === 'outdated'
                ? 'Update in Bluesky'
                : status === 'elsewhere'
                  ? 'Move to Feed Builder'
                  : 'Publish'
          }</a>`
        : ''}
      ${model.publisherDid && live ? html`<a href="${feedUrl(model.publisherDid, def.id)}">Open in Bluesky</a>` : ''}
    </div>
  </div>`
}

export function dashboardPage(model: DashboardModel): Html {
  const { viewer, feeds } = model
  return layout(
    'Feed Builder',
    html`<div class="row">
        <h1>Feed Builder</h1>
        ${viewer.signedIn
          ? html`<span class="actions" style="margin:0">
              <a class="button secondary" href="/feeds/import">Import</a><a class="button" href="/feeds/new">New feed</a>
            </span>`
          : ''}
      </div>
      <p class="muted small">
        Service <code>${model.serviceDid ?? 'unknown'}</code>${model.publisherDid ? html` · publisher <code>${model.publisherDid}</code>` : ''}
      </p>
      ${model.messages.map((m) => notice(m.text, m.kind))}
      ${model.warnings.map((w) => notice(w))}
      ${viewer.canSignIn && !viewer.signedIn
        ? notice(html`<a href="/login">Sign in</a> to create, edit and publish feeds.`, 'ok')
        : ''}
      <h2>${feeds.length} ${feeds.length === 1 ? 'feed' : 'feeds'}</h2>
      ${feeds.map((f) => feedCard(f, model))}
      ${model.broken.length && viewer.signedIn
        ? html`<h2>Feeds that need fixing</h2>
            ${model.broken.map(
              (b) => html`<div class="card">
                <strong>${b.id}</strong>
                <div class="notice error">${b.error}</div>
                <div class="actions">
                  <a class="button secondary" href="/feeds/${b.id}/edit">Edit</a>
                  ${postButton(`/feeds/${b.id}/delete`, 'Delete', 'danger', `Delete ${b.id}?`)}
                </div>
              </div>`,
            )}`
        : ''}
      ${model.external.length && viewer.signedIn
        ? html`<h2>Your feeds on other services</h2>
            <p class="muted small">
              Import one to rebuild it here. Publishing it afterwards moves the feed itself, so anyone who pinned or
              liked it keeps it.
            </p>
            ${model.external.map(
              (f) => html`<div class="card row">
                <span><strong>${f.displayName}</strong> <span class="muted small">${serviceName(f.service)}</span></span>
                ${f.importable
                  ? html`<a class="button secondary" href="/feeds/import?from=${encodeURIComponent(f.id)}">Import</a>`
                  : html`<span class="muted small">Settings not readable; recreate it with New feed</span>`}
              </div>`,
            )}`
        : ''}
      ${model.orphans.length && viewer.signedIn
        ? html`<h2>Published but missing</h2>
            <p class="muted small">These feeds are in Bluesky and point here, but aren't defined anymore, so they show an error.</p>
            ${model.orphans.map(
              (id) => html`<div class="card row">
                <code>${id}</code>
                ${postButton(`/feeds/${id}/unpublish`, 'Unpublish', 'danger', `Remove ${id} from Bluesky?`)}
              </div>`,
            )}`
        : ''}
      ${model.editable
        ? ''
        : html`<p class="muted small">
            Feeds are defined in <code>feeds/</code>. After adding or renaming one, run <code>npm run publish-feeds</code>.
            Set up a database to create and publish feeds from this page instead.
          </p>`}`,
    viewer,
  )
}

/** A friendlier name for well-known feed services. */
export function serviceName(did: string): string {
  if (did === 'did:web:skyfeed.me') return 'SkyFeed'
  return did.replace(/^did:web:/, '')
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

function postCard(post: PostView, now: number, note?: string): Html {
  const record = post.record as { text?: string }
  const thumbs = thumbsOf(post)
  return html`<div class="card post">
    ${post.author.avatar ? html`<img class="avatar" src="${post.author.avatar}" alt="" loading="lazy" />` : html`<div class="avatar"></div>`}
    <div>
      ${note ? html`<div class="muted small">${note}</div>` : ''}
      <div class="row">
        <span><strong>${post.author.displayName || post.author.handle}</strong> <span class="muted">@${post.author.handle}</span></span>
        <a class="small" href="${postLink(post)}">${timeAgo(post.indexedAt, now)}</a>
      </div>
      ${record.text ? html`<div class="text">${record.text}</div>` : ''}
      ${thumbs.length ? html`<div class="thumbs">${thumbs.map((t) => html`<img src="${t}" alt="" loading="lazy" />`)}</div>` : ''}
      <div class="stats">
        <span>♥ ${post.likeCount ?? 0}</span><span>⟲ ${post.repostCount ?? 0}</span><span>💬 ${post.replyCount ?? 0}</span>
      </div>
    </div>
  </div>`
}

const repostNote = (c: Candidate) => (c.repost ? `Reposted by ${c.repost.by.displayName || c.repost.by.handle}` : undefined)

/** The rendered list of posts, shared by the preview page, the editor and the playground. */
export function previewFragment(result: PreviewResult, now = Date.now()): Html {
  return html`${result.errors.length ? notice(result.errors.join('\n'), 'error') : ''}
    ${result.pinned.map((p) => postCard(p, now, 'Pinned'))}
    ${result.items.map((c) => postCard(c.post, now, repostNote(c)))}
    ${result.items.length || result.pinned.length ? '' : html`<p class="muted">No posts matched. Try loosening the filters.</p>`}`
}

function fetchedAgo(builtAt: number): string {
  const ago = timeAgo(new Date(builtAt).toISOString(), Date.now())
  return ago === 'now' ? 'just now' : `${ago} ago`
}

export function previewPage(feed: FeedDefinition, result: PreviewResult, viewer: Viewer): Html {
  return layout(
    `${feed.displayName} · Feed Builder`,
    html`<h1>${feed.displayName}</h1>
      ${feed.description ? html`<p class="muted">${feed.description}</p>` : ''}
      <p class="muted small">Showing the first ${result.items.length} posts · fetched ${fetchedAgo(result.builtAt)}</p>
      ${previewFragment(result)}`,
    viewer,
  )
}

export function errorPage(title: string, message: string, viewer?: Viewer): Html {
  return layout(title, html`<h1>${title}</h1>${notice(message, 'error')}`, viewer)
}

export function loginPage(viewer: Viewer, opts: { owner?: string; error?: string; setupProblem?: string }): Html {
  return layout(
    'Sign in · Feed Builder',
    html`<h1>Sign in</h1>
      ${opts.error ? notice(opts.error, 'error') : ''}
      ${opts.setupProblem
        ? notice(opts.setupProblem, 'error')
        : html`<p class="muted">
              You'll approve access on Bluesky's own sign-in page. Feed Builder never sees your password, and can only
              manage your feeds. It can't post, follow or read messages.
            </p>
            <form method="post" action="/login">
              <p><button type="submit">Sign in as ${opts.owner ?? 'owner'} with Bluesky</button></p>
            </form>
            <p class="muted small">Only the owner set in BSKY_IDENTIFIER can sign in.</p>`}`,
    viewer,
  )
}

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
  return layout(
    `Publish ${feed.displayName} · Feed Builder`,
    html`<h1>${live ? 'Update' : 'Publish'} ${feed.displayName}</h1>
      <p class="muted">
        Publishing adds this feed to your Bluesky profile, where anyone can find, pin and share it. Changes to sources
        and filters apply straight away; publish again only after changing the name, description or avatar.
      </p>
      ${opts.error ? notice(opts.error, 'error') : ''}
      ${opts.blocked ? notice(opts.blocked, 'error') : ''}
      ${moving
        ? notice(
            html`Your Bluesky feed with the id <code>${feed.id}</code> is currently served by
              ${serviceName(opts.currentService ?? 'another service')}. Moving it here keeps its link, likes and pins, and
              switches what it shows to this feed's sources and filters. The other service's settings stay in the
              record, so you can move it back by republishing it there.`,
          )
        : ''}
      <form class="card" method="post" action="/feeds/${feed.id}/publish" enctype="multipart/form-data">
        <div class="row"><strong>${feed.displayName}</strong>${STATUS_BADGES[opts.status]}</div>
        ${feed.description ? html`<div class="muted">${feed.description}</div>` : ''}
        <label for="avatar">Avatar</label>
        <div class="avatar-picker">
          <div class="avatar-preview" id="avatar-preview">
            ${opts.avatarUrl
              ? html`<img src="${opts.avatarUrl}" alt="Current avatar" />`
              : html`<span>${opts.hasAvatar ? 'Current avatar' : 'No avatar'}</span>`}
          </div>
          <div>
            <p class="small muted" id="avatar-status" style="margin:0 0 8px">
              ${opts.hasAvatar ? 'Current avatar. It stays unless you choose a new one.' : 'No avatar yet.'}
            </p>
            <input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg" />
            <p class="hint">Square PNG or JPEG, under 1 MB.</p>
            ${opts.hasAvatar
              ? html`<label class="check"><input type="checkbox" id="remove-avatar" name="removeAvatar" />Remove the current avatar</label>`
              : ''}
          </div>
        </div>
        ${moving
          ? html`<label class="check"><input type="checkbox" name="takeover" required />Move this feed from
              ${serviceName(opts.currentService ?? 'the other service')} to Feed Builder</label>`
          : ''}
        <div class="actions">
          <button type="submit" ${opts.blocked ? 'disabled' : ''}>
            ${moving ? 'Move to Feed Builder' : live ? 'Update in Bluesky' : 'Publish to Bluesky'}
          </button>
          <a class="button secondary" href="/">Cancel</a>
          ${opts.feedLink && live ? html`<a href="${opts.feedLink}">Open in Bluesky</a>` : ''}
        </div>
      </form>
      <style>${raw(AVATAR_CSS)}</style>
      <script>${raw(AVATAR_JS)}</script>
      ${live
        ? html`<h2>Unpublish</h2>
            <p class="muted small">Removes the feed from Bluesky. Anyone who pinned or saved it loses it.</p>
            ${postButton(`/feeds/${feed.id}/unpublish`, 'Unpublish', 'danger', `Remove ${feed.displayName} from Bluesky?`)}`
        : ''}`,
    opts.viewer,
  )
}

const AVATAR_CSS = `
.avatar-picker { display:flex; gap:16px; align-items:flex-start; }
.avatar-preview { flex:none; width:96px; height:96px; border-radius:16px; overflow:hidden; background:var(--border);
  display:grid; place-items:center; color:var(--muted); font-size:12px; text-align:center; transition:opacity .15s; }
.avatar-preview img { width:100%; height:100%; object-fit:cover; }
.avatar-preview.removed { opacity:.3; }
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

export function importPage(viewer: Viewer, opts: { text?: string; error?: string } = {}): Html {
  return layout(
    'Import · Feed Builder',
    html`<h1>Import a feed</h1>
      <p class="muted">
        Paste a SkyFeed feed's settings (the JSON from its export or record), a Feed Builder definition, or simply the
        feed's bsky.app link. You'll review everything in the editor before anything is saved.
      </p>
      ${opts.error ? notice(opts.error, 'error') : ''}
      <form method="post" action="/feeds/import">
        <label for="text">Feed link or JSON</label>
        <textarea class="code" id="text" name="text" spellcheck="false" placeholder="https://bsky.app/profile/you.bsky.social/feed/…"
          style="min-height:200px">${opts.text ?? ''}</textarea>
        <div class="actions">
          <button type="submit">Continue</button>
          <a class="button secondary" href="/">Cancel</a>
        </div>
      </form>`,
    viewer,
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
    return errorPage(
      'Playground',
      viewer.canSignIn
        ? 'Sign in to use the playground.'
        : 'Set ADMIN_TOKEN to enable the playground. It keeps strangers from running searches with your account.',
      viewer,
    )
  }
  return layout(
    'Playground · Feed Builder',
    html`<h1>Playground</h1>
      <p class="muted">
        Try a feed definition as JSON, in the same format as the files in <code>feeds/</code>. Custom
        <code>filter</code> functions only work in feed files.
      </p>
      <form id="form">
        <label for="definition">Feed definition</label>
        <textarea class="code" id="definition" spellcheck="false">${PLAYGROUND_EXAMPLE}</textarea>
        ${needsToken
          ? html`<label for="token">Admin token</label><input id="token" type="password" autocomplete="current-password" />`
          : ''}
        <p><button id="run" type="submit">Preview</button></p>
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
  )
}
