import { html, raw } from 'hono/html'
import { REMEMBER_LIMIT } from '../feeds/define.js'
import { type Html, SITE_NAME, type Viewer, layout, notice } from './layout.js'

/**
 * The editor works on loosely typed definitions, because it has to redisplay
 * whatever was submitted, including invalid values, so they can be fixed.
 */
export type LooseFeed = Record<string, unknown>
type Loose = Record<string, unknown>

type FormLike = { get(name: string): FormDataEntryValue | null; keys(): IterableIterator<string> | Iterable<string> }

const SOURCE_TYPES = ['search', 'author', 'list', 'feed', 'likes', 'posts'] as const

/**
 * A feed id from its name, in kebab-case: "Aural Vibes!" becomes "aural-vibes".
 * Also runs in the browser, so it must stay self-contained.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // accents, which NFKD splits off: "è" becomes "e"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 15)
    .replace(/-+$/, '')
}

// Parsing helpers: empty fields mean "use the default", so they become undefined.
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const list = (v: unknown, separator = /[\n,]+/) => {
  const items = typeof v === 'string' ? v.split(separator).map((s) => s.trim()).filter(Boolean) : []
  return items.length ? items : undefined
}
const words = (v: unknown) => list(v, /[\s,]+/)
const num = (v: unknown) => (typeof v === 'string' && v.trim() ? Number(v.trim()) : undefined)
const checked = (v: unknown) => v === 'on' || v === 'true'
const omitUndefined = <T extends Loose>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function sourceFromForm(get: (field: string) => unknown): Loose {
  const type = text(get('type')) ?? 'search'
  const limit = num(get('limit'))
  switch (type) {
    case 'search':
      return omitUndefined({
        type,
        query: text(get('target')),
        sort: text(get('sort')),
        lang: text(get('lang')),
        author: text(get('author')),
        domain: text(get('domain')),
        tags: words(get('tags'))?.map((t) => t.replace(/^#/, '')),
        limit,
      })
    case 'author':
      return omitUndefined({ type, actors: words(get('target')), filter: text(get('filter')), limit })
    case 'list':
      return omitUndefined({ type, list: text(get('target')), limit })
    case 'feed':
      return omitUndefined({ type, feed: text(get('target')), limit })
    case 'likes':
      return omitUndefined({ type, limit })
    default:
      return omitUndefined({ type, posts: words(get('target')) })
  }
}

/** Turns the editor's form fields into a feed definition, ready for validation. */
export function formToDefinition(form: FormLike): LooseFeed {
  const get = (name: string) => form.get(name) ?? undefined
  const indexes = [...new Set([...form.keys()].flatMap((k) => k.match(/^s\.(\d+)\.type$/)?.[1] ?? []))]
    .map(Number)
    .sort((a, b) => a - b)

  return omitUndefined({
    id: text(get('id')),
    displayName: text(get('displayName')),
    description: text(get('description')),
    sort: text(get('sort')),
    sources: indexes.map((i) => sourceFromForm((field) => get(`s.${i}.${field}`))),
    filters: omitUndefined({
      includeKeywords: list(get('f.includeKeywords')),
      excludeKeywords: list(get('f.excludeKeywords')),
      includeRegex: text(get('f.includeRegex')),
      excludeRegex: text(get('f.excludeRegex')),
      languages: words(get('f.languages')),
      media: text(get('f.media')),
      links: text(get('f.links')),
      excludeReplies: checked(get('f.excludeReplies')) || undefined,
      excludeReposts: checked(get('f.excludeReposts')) || undefined,
      excludeQuotes: checked(get('f.excludeQuotes')) || undefined,
      minLikes: num(get('f.minLikes')),
      minReposts: num(get('f.minReposts')),
      minReplies: num(get('f.minReplies')),
      maxAgeHours: num(get('f.maxAgeHours')),
      includeAuthors: words(get('f.includeAuthors')),
      excludeAuthors: words(get('f.excludeAuthors')),
      excludeLabels: words(get('f.excludeLabels')),
    }),
    pinned: words(get('pinned')),
    maxPosts: num(get('maxPosts')),
    cacheSeconds: num(get('cacheSeconds')),
    remember: checked(get('remember')) || undefined,
  })
}

// Rendering helpers: show whatever is there, valid or not.
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const joined = (v: unknown, separator = '\n') => (Array.isArray(v) ? v.join(separator) : str(v))
const selected = (current: unknown, value: string, fallback?: string) => ((current ?? fallback) === value ? 'selected' : '')

function select(name: string, current: unknown, options: [string, string][], fallback: string, id?: string): Html {
  return html`<select name="${name}" ${id ? raw(`id="${id}"`) : ''}>
    ${options.map(([value, label]) => html`<option value="${value}" ${selected(current, value, fallback)}>${label}</option>`)}
  </select>`
}

const TYPE_LABELS: Record<(typeof SOURCE_TYPES)[number], string> = {
  search: 'Search',
  author: 'Posts by accounts',
  list: 'Posts by list members',
  feed: 'Another feed',
  likes: 'Your likes',
  posts: 'Hand-picked posts',
}

const TARGETS: Record<string, { label: string; placeholder: string }> = {
  search: { label: 'Search for', placeholder: 'cats OR kittens -dog' },
  author: { label: 'Accounts', placeholder: 'alice.bsky.social bob.bsky.social' },
  list: { label: 'List link', placeholder: 'https://bsky.app/profile/you.bsky.social/lists/…' },
  feed: { label: 'Feed link', placeholder: 'https://bsky.app/profile/bsky.app/feed/whats-hot' },
  posts: { label: 'Post links, one per line', placeholder: 'https://bsky.app/profile/…/post/…' },
}

function targetOf(source: Loose): string {
  switch (source.type) {
    case 'author':
      return joined(source.actors)
    case 'list':
      return str(source.list)
    case 'feed':
      return str(source.feed)
    case 'posts':
      return joined(source.posts)
    default:
      return str(source.query)
  }
}

/** One source in the editor. Fields for other source types stay in the markup and are hidden with CSS. */
function sourceRow(source: Loose, i: number | '__i__'): Html {
  const type = str(source.type) || 'search'
  const name = (field: string) => `s.${i}.${field}`
  const id = (field: string) => `s-${i}-${field}`
  return html`<div class="source" data-type="${type}">
    <div class="source-head">
      <span class="source-num" aria-hidden="true"></span>
      <select name="${name('type')}" id="${id('type')}" aria-label="Source type">
        ${SOURCE_TYPES.map((t) => html`<option value="${t}" ${selected(type, t)}>${TYPE_LABELS[t]}</option>`)}
      </select>
      <button type="button" class="link remove-source">Remove</button>
    </div>
    <div class="field opt" data-for="search author list feed posts">
      <label for="${id('target')}">
        ${Object.entries(TARGETS).map(([t, { label }]) => html`<span class="opt" data-for="${t}">${label}</span>`)}
      </label>
      <textarea name="${name('target')}" id="${id('target')}" rows="2" placeholder="${TARGETS[type]?.placeholder ?? ''}">${targetOf(source)}</textarea>
      <p class="hint opt" data-for="search">Quotes match a phrase, a minus sign excludes a word, OR matches either.</p>
      <p class="hint opt" data-for="list feed posts">Paste the link from the Bluesky app's share menu.</p>
    </div>
    <p class="hint opt" data-for="likes" style="margin:0">Posts you've liked, newest like first.</p>
    <div class="grid">
      <div class="field opt" data-for="search">
        <label for="${id('sort')}">Order</label>
        ${select(name('sort'), source.sort, [['latest', 'Latest'], ['top', 'Top']], 'latest', id('sort'))}
      </div>
      <div class="field opt" data-for="search">
        <label for="${id('lang')}">Language</label><input name="${name('lang')}" id="${id('lang')}" value="${str(source.lang)}" placeholder="en" />
      </div>
      <div class="field opt" data-for="search">
        <label for="${id('author')}">Only from account</label><input name="${name('author')}" id="${id('author')}" value="${str(source.author)}" placeholder="alice.bsky.social" />
      </div>
      <div class="field opt" data-for="search">
        <label for="${id('domain')}">Linking to site</label><input name="${name('domain')}" id="${id('domain')}" value="${str(source.domain)}" placeholder="github.com" />
      </div>
      <div class="field opt" data-for="search">
        <label for="${id('tags')}">With all hashtags</label><input name="${name('tags')}" id="${id('tags')}" value="${joined(source.tags, ' ')}" placeholder="caturday" />
      </div>
      <div class="field opt" data-for="author">
        <label for="${id('filter')}">Include</label>
        ${select(
          name('filter'),
          source.filter,
          [
            ['posts_and_author_threads', 'Posts, reposts and self-threads'],
            ['posts_no_replies', 'Posts and reposts'],
            ['posts_with_replies', 'Everything, including replies'],
            ['posts_with_media', 'Only posts with media'],
            ['posts_with_video', 'Only posts with video'],
          ],
          'posts_and_author_threads',
          id('filter'),
        )}
      </div>
      <div class="field opt" data-for="search author list feed likes">
        <label for="${id('limit')}">How many to fetch</label>
        <input name="${name('limit')}" id="${id('limit')}" type="number" min="1" max="1000" value="${str(source.limit)}" placeholder="${type === 'author' ? '50 each' : '100'}" />
      </div>
    </div>
  </div>`
}

const EDITOR_CSS = [
  `
/* Form on the left; on wide screens a sticky preview timeline on the right. */
.editor-layout { display: grid; gap: 24px; align-items: start; }
.editor-form { display: grid; gap: 18px; min-width: 0; }
.section-head { display: grid; gap: 4px; }
.group-title { font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); margin: 6px 0 -4px; }
#sources { display: grid; gap: 12px; counter-reset: source; }
.source { counter-increment: source; display: grid; gap: 14px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--ground); }
.source-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "num type remove"; align-items: center; gap: 10px 12px; }
.source-head .source-num { grid-area: num; } .source-head select { grid-area: type; } .source-head .remove-source { grid-area: remove; }
@media (max-width: 520px) { .source-head { grid-template-areas: "num . remove" "type type type"; } }
.source-num { font: 700 .8rem/1 var(--font-display); color: var(--blue-strong); background: var(--blue-wash); padding: 6px 9px; border-radius: 7px; white-space: nowrap; }
.source-num::before { content: "Source " counter(source); }
.remember { display: grid; gap: 4px; padding: 14px; border-radius: var(--radius-sm); background: var(--sunken); }
details.panel > summary { list-style: none; cursor: pointer; padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; font: 700 1.2rem/1.15 var(--font-display); }
details.panel > summary::-webkit-details-marker { display: none; }
details.panel > summary::after { content: "+"; color: var(--ink-soft); font-size: 1.4rem; font-weight: 400; }
details.panel[open] > summary::after { content: "−"; }
details.panel > .panel-body { padding-top: 0; }
.form-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.form-actions .spacer { flex: 1; }
.preview-pane { display: grid; gap: 12px; min-width: 0; }
.preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.preview-placeholder { padding: 28px 20px; color: var(--ink-soft); text-align: center; }
@media (min-width: 1080px) {
  .editor-layout { grid-template-columns: minmax(0, 1fr) 400px; }
  .preview-pane { position: sticky; top: calc(76px + env(safe-area-inset-top, 0px)); max-height: calc(100vh - 96px); overflow: auto; overscroll-behavior: contain; padding-bottom: 8px; }
}
.source .opt { display: none; }`,
  // Show each element only for the source types listed in its data-for.
  ...SOURCE_TYPES.flatMap((t) => [
    `.source[data-type="${t}"] div.opt[data-for~="${t}"], .source[data-type="${t}"] p.opt[data-for~="${t}"] { display: grid; }`,
    `.source[data-type="${t}"] span.opt[data-for~="${t}"] { display: inline; }`,
  ]),
].join('\n')

const EDITOR_JS = `
const form = document.getElementById('editor');
const sources = document.getElementById('sources');
const template = document.getElementById('source-template');
const placeholders = ${JSON.stringify(Object.fromEntries(Object.entries(TARGETS).map(([t, v]) => [t, v.placeholder])))};
let next = Number(sources.dataset.next);
sources.addEventListener('change', (e) => {
  if (!e.target.matches('select[name$=".type"]')) return;
  const row = e.target.closest('.source');
  row.dataset.type = e.target.value;
  row.querySelector('textarea').placeholder = placeholders[e.target.value] || '';
});
sources.addEventListener('click', (e) => {
  if (e.target.matches('.remove-source')) e.target.closest('.source').remove();
});
document.getElementById('add-source').addEventListener('click', () => {
  sources.insertAdjacentHTML('beforeend', template.innerHTML.replaceAll('__i__', String(next++)));
  sources.lastElementChild.querySelector('select').focus();
});
const slugify = ${slugify.toString()};
const name = form.elements.displayName, id = form.elements.id;
if (!id.readOnly) {
  // The id follows the name until someone edits it by hand.
  let touched = Boolean(id.value);
  if (!touched && name.value) id.value = slugify(name.value);
  id.addEventListener('input', () => { touched = Boolean(id.value); });
  name.addEventListener('input', () => { if (!touched) id.value = slugify(name.value); });
}
const pane = document.getElementById('preview-pane'), results = document.getElementById('results');
for (const button of document.querySelectorAll('[data-preview]')) {
  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Loading…';
    try {
      const res = await fetch('/api/preview?format=html', { method: 'POST', body: new FormData(form) });
      results.innerHTML = await res.text();
      // Side by side, the pane is already in view; stacked, bring it up.
      if (getComputedStyle(pane).position !== 'sticky') pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else pane.scrollTop = 0;
    } catch (err) {
      results.textContent = String(err);
    } finally {
      button.disabled = false; button.textContent = label;
    }
  });
}
`

export const NEW_FEED: LooseFeed = {
  sources: [{ type: 'search' }],
  filters: { excludeReplies: true, maxAgeHours: 72, excludeLabels: ['porn', 'sexual', 'nudity', 'graphic-media'] },
  sort: 'newest',
}

export function editorPage(opts: {
  viewer: Viewer
  mode: 'new' | 'edit'
  feed: LooseFeed
  error?: string
  /** What an import changed or couldn't convert, shown above the form. */
  notes?: string[]
}): Html {
  const feed = opts.feed
  const filters = (feed.filters ?? {}) as Loose
  const sources = (Array.isArray(feed.sources) ? feed.sources : []) as Loose[]
  const action = opts.mode === 'new' ? '/feeds/new' : `/feeds/${str(feed.id)}/edit`
  const title = opts.mode === 'new' ? 'New feed' : str(feed.displayName) || str(feed.id)
  const box = (name: string, label: string) =>
    html`<label class="check"><input type="checkbox" id="f-${name}" name="f.${name}" ${filters[name] ? 'checked' : ''} />${label}</label>`
  const input = (name: string, label: string, value: unknown, attrs = '', hint?: string) =>
    html`<div class="field"><label for="${name.replace('.', '-')}">${label}</label>
      <input id="${name.replace('.', '-')}" name="${name}" value="${str(value)}" ${raw(attrs)} />
      ${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`

  return layout(
    `${opts.mode === 'new' ? 'New feed' : `Edit ${title}`} · ${SITE_NAME}`,
    html`<style>${raw(EDITOR_CSS)}</style>
      <div class="page-head">
        <div><p class="eyebrow">${opts.mode === 'new' ? 'Create' : 'Edit feed'}</p><h1>${title}</h1></div>
      </div>
      ${opts.error ? notice(opts.error, 'error') : ''}
      ${opts.notes?.length
        ? notice(html`<strong>Imported. Review before saving:</strong><ul>${opts.notes.map((n) => html`<li>${n}</li>`)}</ul>`)
        : ''}
      <div class="editor-layout">
        <form id="editor" class="editor-form" method="post" action="${action}">
          <section class="panel"><div class="panel-body fields">
            <div class="section-head"><h2>Basics</h2><p class="muted small">How the feed appears in Bluesky.</p></div>
            <div class="grid">
              <div class="field">
                <label for="displayName">Name</label>
                <input id="displayName" name="displayName" maxlength="24" required value="${str(feed.displayName)}" placeholder="Cat Pics" />
              </div>
              <div class="field">
                <label for="id">Id</label>
                <input id="id" name="id" class="mono" maxlength="15" required pattern="[a-z0-9][a-z0-9\\-]{0,14}" value="${str(feed.id)}"
                  ${opts.mode === 'edit' ? 'readonly' : ''} placeholder="cat-pics" />
              </div>
            </div>
            <p class="hint" style="margin-top:-10px">
              ${opts.mode === 'edit'
                ? "The id is part of the feed's link, so it can't change."
                : "The id is part of the feed's link. It follows the name until you edit it, and can't change once saved."}
            </p>
            <div class="field">
              <label for="description">Description</label>
              <textarea id="description" name="description" maxlength="300" rows="3">${str(feed.description)}</textarea>
            </div>
            <div class="field" style="max-width:320px">
              <label for="sort">Order</label>
              ${select(
                'sort',
                feed.sort,
                [
                  ['newest', 'Newest first'],
                  ['hot', 'Hot: popular and recent'],
                  ['top', 'Top: most likes and reposts'],
                ],
                'newest',
                'sort',
              )}
            </div>
          </div></section>

          <section class="panel"><div class="panel-body fields">
            <div class="section-head">
              <h2>Sources</h2>
              <p class="muted small">Where posts come from. Every source's posts are combined, and duplicates removed.</p>
            </div>
            <div id="sources" data-next="${sources.length}">${sources.map((s, i) => sourceRow(s, i))}</div>
            <div><button type="button" class="secondary" id="add-source">Add source</button></div>
            <template id="source-template">${sourceRow({ type: 'search' }, '__i__')}</template>
            <div class="remember">
              <label class="check"><input type="checkbox" id="remember" name="remember" ${feed.remember ? 'checked' : ''} />Remember posts</label>
              <p class="hint" style="margin:0 0 0 28px">
                Keep every post that matches, even after it's too old for the sources to return (up to
                ${REMEMBER_LIMIT.toLocaleString('en-US')}). Leave it off to let old posts drop off. Turning it off later
                forgets the saved posts.
              </p>
            </div>
          </div></section>

          <section class="panel"><div class="panel-body fields">
            <div class="section-head"><h2>Filters</h2><p class="muted small">Which of those posts make it into the feed.</p></div>
            <p class="group-title">Words</p>
            <div class="field">
              <label for="f-includeKeywords">Must mention one of</label>
              <textarea id="f-includeKeywords" name="f.includeKeywords" rows="2" placeholder="cat*, kitten*, #caturday">${joined(filters.includeKeywords)}</textarea>
              <p class="hint">One per line or comma-separated. Whole words; <code>cat*</code> matches “cats”, <code>#tag</code> matches hashtags.</p>
            </div>
            <div class="field">
              <label for="f-excludeKeywords">Must not mention</label>
              <textarea id="f-excludeKeywords" name="f.excludeKeywords" rows="2" placeholder="catalog, category">${joined(filters.excludeKeywords)}</textarea>
            </div>
            <p class="group-title">Kinds of post</p>
            <div class="grid">
              <div class="field"><label for="f-media">Media</label>${select(
                'f.media',
                filters.media,
                [
                  ['any', 'Any'],
                  ['required', 'Images or video'],
                  ['images', 'Images'],
                  ['video', 'Video'],
                  ['none', 'No media'],
                ],
                'any',
                'f-media',
              )}</div>
              <div class="field"><label for="f-links">Links</label>${select(
                'f.links',
                filters.links,
                [
                  ['any', 'Any'],
                  ['required', 'Must have a link'],
                  ['none', 'No links'],
                ],
                'any',
                'f-links',
              )}</div>
              ${input('f.languages', 'Languages', joined(filters.languages, ', '), 'placeholder="en, es"')}
            </div>
            <div class="checks">
              ${box('excludeReplies', 'Hide replies')} ${box('excludeReposts', 'Hide reposts')} ${box('excludeQuotes', 'Hide quote posts')}
            </div>
            <p class="group-title">Engagement and age</p>
            <div class="grid">
              ${input('f.minLikes', 'Min likes', filters.minLikes, 'type="number" min="0" inputmode="numeric"')}
              ${input('f.minReposts', 'Min reposts', filters.minReposts, 'type="number" min="0" inputmode="numeric"')}
              ${input('f.minReplies', 'Min replies', filters.minReplies, 'type="number" min="0" inputmode="numeric"')}
              ${input('f.maxAgeHours', 'Max age (hours)', filters.maxAgeHours, 'type="number" min="1" step="any" inputmode="decimal"')}
            </div>
            <p class="group-title">Accounts and labels</p>
            ${input('f.includeAuthors', 'Only these accounts', joined(filters.includeAuthors, ' '), 'placeholder="Leave empty for everyone"')}
            ${input('f.excludeAuthors', 'Hide these accounts', joined(filters.excludeAuthors, ' '), 'placeholder="spammer.bsky.social"')}
            ${input('f.excludeLabels', 'Hide posts labeled', joined(filters.excludeLabels, ' '), 'placeholder="porn sexual nudity graphic-media"')}
          </div></section>

          <details class="panel">
            <summary>Advanced</summary>
            <div class="panel-body fields">
              <div class="field">
                <label for="pinned">Pinned posts</label>
                <textarea id="pinned" name="pinned" rows="2" placeholder="https://bsky.app/profile/…/post/…">${joined(feed.pinned)}</textarea>
                <p class="hint">Shown at the top of the feed, up to 10.</p>
              </div>
              ${input('f.includeRegex', 'Must match regular expression', filters.includeRegex, 'class="mono" spellcheck="false"')}
              ${input('f.excludeRegex', 'Must not match regular expression', filters.excludeRegex, 'class="mono" spellcheck="false"')}
              <div class="grid">
                ${input('maxPosts', 'Max posts', feed.maxPosts, 'type="number" min="1" max="2000" placeholder="500"')}
                ${input('cacheSeconds', 'Cache (seconds)', feed.cacheSeconds, 'type="number" min="0" placeholder="60"')}
              </div>
            </div>
          </details>

          <div class="form-actions">
            <button type="submit">${opts.mode === 'new' ? 'Create feed' : 'Save changes'}</button>
            <a class="button secondary" href="/">Cancel</a>
          </div>
        </form>

        <aside class="preview-pane" id="preview-pane" aria-label="Preview">
          <div class="preview-head">
            <h2>Preview</h2>
            <button type="button" class="secondary" id="preview" data-preview>Show posts</button>
          </div>
          <div id="results">
            <div class="timeline preview-placeholder">The posts this feed would show right now appear here.</div>
          </div>
        </aside>
      </div>
      ${opts.mode === 'edit'
        ? html`<form class="panel" method="post" action="/feeds/${str(feed.id)}/delete"
            onsubmit="return confirm('Delete this feed? If it is published, it is removed from Bluesky too.')">
            <div class="panel-body" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px">
              <div style="display:grid;gap:4px"><h3>Delete feed</h3>
                <p class="muted small">Removes it here, and from Bluesky if it's published.</p></div>
              <button class="danger" type="submit">Delete feed</button>
            </div>
          </form>`
        : ''}
      <script>${raw(EDITOR_JS)}</script>`,
    opts.viewer,
    { current: 'feeds', wide: true },
  )
}
