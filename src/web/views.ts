import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { FeedDefinition, FeedSource } from '../feeds/define.js'
import type { PreviewResult } from '../feeds/engine.js'
import type { Candidate, PostView } from '../feeds/post.js'

type Html = HtmlEscapedString | Promise<HtmlEscapedString>

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#16181c; --muted:#5b6470; --border:#e2e5ea; --accent:#1083fe; --warn-bg:#fff6e0; --warn:#7a5200; --err-bg:#fdecec; --err:#9b1c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1318; --card:#171c23; --text:#e8ebef; --muted:#97a1ad; --border:#2a313b; --accent:#4aa3ff; --warn-bg:#3a2e10; --warn:#f2cf7a; --err-bg:#3d1717; --err:#f5a3a3; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:760px; margin:0 auto; padding:24px 16px 64px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 12px; }
.muted { color:var(--muted); } .small { font-size:13px; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
nav { display:flex; gap:16px; margin-bottom:24px; font-weight:600; }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:12px; }
.row { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
.tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.tag { font-size:12px; border:1px solid var(--border); border-radius:99px; padding:1px 8px; color:var(--muted); }
.notice { border-radius:10px; padding:10px 14px; margin-bottom:10px; font-size:14px; background:var(--warn-bg); color:var(--warn); }
.notice.error { background:var(--err-bg); color:var(--err); white-space:pre-wrap; }
.post { display:grid; grid-template-columns:40px 1fr; gap:10px; }
.post .avatar { width:40px; height:40px; border-radius:50%; background:var(--border); }
.post .text { white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; }
.post .thumbs { display:flex; gap:6px; margin:6px 0; }
.post .thumbs img { max-width:100%; max-height:180px; border-radius:8px; object-fit:cover; }
.stats { display:flex; gap:14px; font-size:13px; color:var(--muted); }
textarea { width:100%; min-height:340px; font:13px ui-monospace,Menlo,monospace; padding:12px; border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text); }
input { width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font:inherit; }
button { padding:9px 18px; border:0; border-radius:99px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
button:disabled { opacity:.6; cursor:progress; }
label { display:block; font-weight:600; margin:14px 0 6px; }
`

function layout(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <main>
      <nav><a href="/">Feeds</a><a href="/playground">Playground</a></nav>
      ${body}
    </main>
  </body>
</html>`
}

export interface Status {
  hostname?: string
  serviceDid?: string
  publisherDid?: string
  hasCredentials: boolean
  needsCredentials: boolean
}

export const feedUrl = (publisherDid: string, id: string) => `https://bsky.app/profile/${publisherDid}/feed/${id}`

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

export function dashboardPage(feeds: FeedDefinition[], status: Status): Html {
  const notices: Html[] = []
  if (!status.hostname) {
    notices.push(html`<div class="notice">FEEDGEN_HOSTNAME isn't set, so the hostname is taken from each request. Set it before publishing.</div>`)
  }
  if (!status.publisherDid) {
    notices.push(html`<div class="notice">Can't tell which account publishes these feeds. Set FEEDGEN_PUBLISHER_DID, or set BSKY_IDENTIFIER to your handle.</div>`)
  }
  if (status.needsCredentials && !status.hasCredentials) {
    notices.push(html`<div class="notice">Some feeds use search or likes, which need BSKY_IDENTIFIER and BSKY_APP_PASSWORD.</div>`)
  }

  return layout(
    'Feed Builder',
    html`<h1>Feed Builder</h1>
      <p class="muted small">
        Service <code>${status.serviceDid ?? 'unknown'}</code>${status.publisherDid ? html` · publisher <code>${status.publisherDid}</code>` : ''}
      </p>
      ${notices}
      <h2>${feeds.length} ${feeds.length === 1 ? 'feed' : 'feeds'}</h2>
      ${feeds.map(
        (feed) => html`<div class="card">
          <div class="row">
            <strong>${feed.displayName}</strong>
            <span class="small">
              <a href="/feeds/${feed.id}">Preview</a>
              ${status.publisherDid ? html` · <a href="${feedUrl(status.publisherDid, feed.id)}">Open in Bluesky</a>` : ''}
            </span>
          </div>
          ${feed.description ? html`<div class="muted">${feed.description}</div>` : ''}
          <div class="tags">
            <span class="tag">id: ${feed.id}</span>
            <span class="tag">${feed.sort}</span>
            ${feed.sources.map((s) => html`<span class="tag">${describeSource(s)}</span>`)}
            ${feed.filter ? html`<span class="tag">custom filter</span>` : ''}
          </div>
        </div>`,
      )}
      <p class="muted small">
        Feeds are defined in <code>feeds/</code>. After adding or renaming one, run <code>npm run publish-feeds</code> so it
        shows up in Bluesky.
      </p>`,
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

function postCard(post: PostView, now: number, note?: string): Html {
  const record = post.record as { text?: string }
  return html`<div class="card post">
    ${post.author.avatar ? html`<img class="avatar" src="${post.author.avatar}" alt="" loading="lazy" />` : html`<div class="avatar"></div>`}
    <div>
      ${note ? html`<div class="muted small">${note}</div>` : ''}
      <div class="row">
        <span><strong>${post.author.displayName || post.author.handle}</strong> <span class="muted">@${post.author.handle}</span></span>
        <a class="small" href="${postLink(post)}">${timeAgo(post.indexedAt, now)}</a>
      </div>
      ${record.text ? html`<div class="text">${record.text}</div>` : ''}
      ${(() => {
        const thumbs = thumbsOf(post)
        return thumbs.length ? html`<div class="thumbs">${thumbs.map((t) => html`<img src="${t}" alt="" loading="lazy" />`)}</div>` : ''
      })()}
      <div class="stats">
        <span>♥ ${post.likeCount ?? 0}</span><span>⟲ ${post.repostCount ?? 0}</span><span>💬 ${post.replyCount ?? 0}</span>
      </div>
    </div>
  </div>`
}

const repostNote = (c: Candidate) => (c.repost ? `Reposted by ${c.repost.by.displayName || c.repost.by.handle}` : undefined)

/** The rendered list of posts, shared by the preview page and the playground. */
export function previewFragment(result: PreviewResult, now = Date.now()): Html {
  return html`${result.errors.length ? html`<div class="notice error">${result.errors.join('\n')}</div>` : ''}
    ${result.pinned.map((p) => postCard(p, now, 'Pinned'))}
    ${result.items.map((c) => postCard(c.post, now, repostNote(c)))}
    ${result.items.length || result.pinned.length ? '' : html`<p class="muted">No posts matched. Try loosening the filters.</p>`}`
}

function fetchedAgo(builtAt: number): string {
  const ago = timeAgo(new Date(builtAt).toISOString(), Date.now())
  return ago === 'now' ? 'just now' : `${ago} ago`
}

export function previewPage(feed: FeedDefinition, result: PreviewResult): Html {
  return layout(
    `${feed.displayName} · Feed Builder`,
    html`<h1>${feed.displayName}</h1>
      ${feed.description ? html`<p class="muted">${feed.description}</p>` : ''}
      <p class="muted small">Showing the first ${result.items.length} posts · fetched ${fetchedAgo(result.builtAt)}</p>
      ${previewFragment(result)}`,
  )
}

export function errorPage(title: string, message: string): Html {
  return layout(title, html`<h1>${title}</h1><div class="notice error">${message}</div>`)
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

export function playgroundPage(enabled: boolean): Html {
  if (!enabled) {
    return errorPage('Playground', 'Set ADMIN_TOKEN to enable the playground. It keeps strangers from running searches with your account.')
  }
  return layout(
    'Playground · Feed Builder',
    html`<h1>Playground</h1>
      <p class="muted">
        Try a feed definition before adding it to <code>feeds/</code>. Same format as the feed files, as JSON. Custom
        <code>filter</code> functions only work in feed files.
      </p>
      <form id="form">
        <label for="definition">Feed definition</label>
        <textarea id="definition" spellcheck="false">${PLAYGROUND_EXAMPLE}</textarea>
        <label for="token">Admin token</label>
        <input id="token" type="password" autocomplete="current-password" />
        <p><button id="run" type="submit">Preview</button></p>
      </form>
      <div id="results"></div>
      <script>
        ${raw(`
        const form = document.getElementById('form'), run = document.getElementById('run');
        const token = document.getElementById('token'), definition = document.getElementById('definition');
        const results = document.getElementById('results');
        try { token.value = localStorage.getItem('adminToken') || ''; definition.value = localStorage.getItem('definition') || definition.value; } catch {}
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try { localStorage.setItem('adminToken', token.value); localStorage.setItem('definition', definition.value); } catch {}
          run.disabled = true; run.textContent = 'Loading…';
          try {
            const res = await fetch('/api/preview?format=html', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.value }, body: definition.value });
            results.innerHTML = await res.text();
          } catch (err) {
            results.textContent = String(err);
          } finally {
            run.disabled = false; run.textContent = 'Preview';
          }
        });
        `)}
      </script>`,
  )
}
