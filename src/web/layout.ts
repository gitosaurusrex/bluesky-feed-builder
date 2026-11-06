import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

/** Who is looking at the page, which decides the navigation and which actions are offered. */
export interface Viewer {
  signedIn: boolean
  /** Sign-in is available (a database is configured). */
  canSignIn: boolean
  /** The signed-in account's handle and avatar, when Bluesky could tell us. */
  handle?: string
  avatar?: string
}

export const anonymous: Viewer = { signedIn: false, canSignIn: false }

export const SITE_NAME = 'Blue Feeds'

/** The mark: a tile of feed rows, shortening like a timeline fading into the sky. */
export const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><g fill="#fff"><rect x="7" y="8.5" width="18" height="3.4" rx="1.7"/><rect x="7" y="14.3" width="13" height="3.4" rx="1.7" opacity=".8"/><rect x="7" y="20.1" width="8" height="3.4" rx="1.7" opacity=".6"/></g></svg>`

export const FAVICON = MARK.replace('fill="currentColor"', 'fill="#1a6cf0"').replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"')

const FONTS =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap'

const STYLE = `
/* Layout: an app shell. A slim top bar over one 920px column; the editor splits into form + sticky live preview on wide screens. */
:root {
  --ground: #f4f7fb;      /* page: a pale, cool sky */
  --surface: #ffffff;     /* raised panels and timelines */
  --sunken: #edf2f8;      /* inputs, code, quiet fills */
  --ink: #0e1a2b;         /* text: deep navy, never pure black */
  --ink-soft: #4b5b71;    /* secondary text */
  --line: #d9e2ed;        /* hairlines */
  --blue: #1a6cf0;        /* the accent */
  --blue-strong: #0d55cc; /* links, hover */
  --blue-wash: #e5eeff;   /* tinted fills */
  --on-blue: #ffffff;
  --live: #0b7f57; --live-wash: #ddf4ea;
  --warn: #8a5300; --warn-wash: #fdefd3;
  --danger: #b8322a; --danger-wash: #fce6e3;
  --shadow: 0 1px 2px rgb(14 26 43 / 6%), 0 4px 16px rgb(14 26 43 / 5%);
  --font-display: "Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --font-body: "Figtree", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius: 14px;
  --radius-sm: 9px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0a111d; --surface: #111b2b; --sunken: #0d1624; --ink: #e5ecf6; --ink-soft: #95a5bc; --line: #22314a;
    --blue: #5c9dff; --blue-strong: #8dbbff; --blue-wash: #13284c; --on-blue: #04122b;
    --live: #45c690; --live-wash: #0e2d22; --warn: #f1b551; --warn-wash: #33260d; --danger: #ff8075; --danger-wash: #3b1714;
    --shadow: 0 1px 2px rgb(0 0 0 / 30%), 0 6px 20px rgb(0 0 0 / 25%);
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font: 16px/1.55 var(--font-body); -webkit-font-smoothing: antialiased;
}
a { color: var(--blue-strong); text-decoration-thickness: 1px; text-underline-offset: 3px; text-decoration-color: transparent; transition: text-decoration-color .15s; }
a:hover { text-decoration-color: currentColor; }
h1, h2, h3 { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.015em; line-height: 1.15; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(1.75rem, 4vw, 2.25rem); }
h2 { font-size: 1.2rem; }
h3 { font-size: 1.02rem; }
p { margin: 0; }
code, .mono { font-family: var(--font-mono); font-size: .82em; overflow-wrap: anywhere; }
.muted { color: var(--ink-soft); }
.small { font-size: .875rem; }
.eyebrow { font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); }
:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }

/* Shell */
.topbar {
  position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--ground) 88%, transparent);
  backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px);
  border-bottom: 1px solid var(--line);
}
.topbar-inner, main {
  max-width: 920px; margin: 0 auto;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.topbar-inner { display: flex; align-items: center; gap: 20px; min-height: 60px; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); font: 750 1.15rem/1 var(--font-display); letter-spacing: -0.02em; }
.brand:hover { text-decoration: none; }
.brand svg { width: 28px; height: 28px; color: var(--blue); flex: none; }
.nav { display: flex; gap: 4px; }
.nav a { color: var(--ink-soft); font-weight: 600; font-size: .94rem; padding: 6px 10px; border-radius: 8px; }
.nav a:hover { color: var(--ink); background: var(--sunken); text-decoration: none; }
.nav a[aria-current="page"] { color: var(--ink); }
.topbar .spacer { flex: 1; }
.topbar form { margin: 0; }
.account { display: flex; align-items: center; gap: 12px; min-width: 0; }
.whoami { display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 12px 4px 4px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); font-size: .88rem; color: var(--ink-soft); }
.whoami img, .whoami .face { width: 26px; height: 26px; border-radius: 50%; flex: none; object-fit: cover; background: var(--blue-wash); }
.whoami .face { display: grid; place-items: center; color: var(--blue-strong); font-weight: 700; font-size: .8rem; }
.whoami .names { display: flex; gap: 5px; min-width: 0; align-items: baseline; }
.whoami .as { white-space: nowrap; }
.whoami strong { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
a.whoami:hover { text-decoration: none; border-color: var(--blue); color: var(--ink-soft); }
@media (max-width: 720px) { .whoami .as { display: none; } }
/* On phones the account gets its own row, so the whole handle fits. */
@media (max-width: 600px) {
  .topbar-inner { flex-wrap: wrap; row-gap: 0; }
  .account { order: 3; flex-basis: 100%; justify-content: space-between; padding-bottom: 10px; }
  .whoami { border-radius: 14px; padding-block: 5px; }
  .whoami .names { flex-direction: column; gap: 1px; }
  .whoami .as { display: inline; font-size: .72rem; line-height: 1.1; }
  .whoami strong { line-height: 1.2; }
}
main { padding-block: 28px 72px; display: grid; gap: 24px; }
main.wide, .topbar.wide .topbar-inner { max-width: 1240px; }
@media (max-width: 520px) { .nav a { padding: 6px 7px; } .topbar-inner { gap: 10px; } .brand span { display: none; } }

/* Page heading */
.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
.page-head > div { display: grid; gap: 6px; min-width: 0; }
.lede { color: var(--ink-soft); max-width: 62ch; }

/* Buttons */
button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: 999px; background: var(--blue); color: var(--on-blue);
  font: 600 .94rem/1 var(--font-body); cursor: pointer; text-decoration: none; white-space: nowrap;
  transition: background .15s, border-color .15s, transform .1s;
}
button:hover, .button:hover { background: var(--blue-strong); text-decoration: none; }
button:active, .button:active { transform: translateY(1px); }
button.secondary, .button.secondary { background: var(--surface); color: var(--ink); border-color: var(--line); }
button.secondary:hover, .button.secondary:hover { border-color: var(--blue); color: var(--blue-strong); }
button.danger { background: transparent; color: var(--danger); border-color: var(--line); }
button.danger:hover { background: var(--danger-wash); border-color: var(--danger); }
button.link { background: none; border: 0; min-height: 0; padding: 4px 2px; color: var(--ink-soft); }
button.link:hover { color: var(--ink); background: none; }
button:disabled { opacity: .55; cursor: progress; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.actions form { margin: 0; }

/* Panels */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.panel-body { padding: 20px; display: grid; gap: 14px; }
@media (max-width: 520px) { .panel-body { padding: 16px; } }

/* Status pills and chips */
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px 3px 8px; border-radius: 999px; font-size: .8rem; font-weight: 600; white-space: nowrap; background: var(--sunken); color: var(--ink-soft); }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.live { background: var(--live-wash); color: var(--live); }
.pill.live::before { box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 25%, transparent); }
.pill.warn { background: var(--warn-wash); color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: .8rem; padding: 2px 9px; border-radius: 7px; background: var(--sunken); color: var(--ink-soft); }
.chip.mono { font-family: var(--font-mono); font-size: .75rem; }

/* Notices */
.notice { border-radius: var(--radius-sm); padding: 12px 14px; font-size: .94rem; background: var(--warn-wash); color: var(--warn); }
.notice.error { background: var(--danger-wash); color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
.notice.ok { background: var(--live-wash); color: var(--live); }
.notice a { color: inherit; text-decoration-color: currentColor; }
.notice ul { margin: 6px 0 0; padding-left: 20px; }

/* Forms */
label { display: block; font-weight: 600; font-size: .92rem; margin: 0 0 6px; }
label.check { display: flex; align-items: center; gap: 10px; font-weight: 500; margin: 0; cursor: pointer; }
input, select, textarea {
  width: 100%; min-height: 42px; padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--sunken); color: var(--ink); font: 400 .95rem/1.4 var(--font-body); transition: border-color .15s, background .15s;
}
input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--blue) 40%, var(--line)); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--blue); background: var(--surface); box-shadow: 0 0 0 3px var(--blue-wash); }
input[type=checkbox] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--blue); flex: none; }
input[type=file] { padding: 7px; }
input[readonly] { color: var(--ink-soft); background: transparent; }
textarea { min-height: 72px; resize: vertical; }
textarea.code { font: 400 .82rem/1.55 var(--font-mono); min-height: 320px; }
.field { display: grid; gap: 0; min-width: 0; }
.hint { font-size: .84rem; color: var(--ink-soft); font-weight: 400; margin-top: 6px; }
.fields { display: grid; gap: 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; }
.checks { display: flex; flex-wrap: wrap; gap: 10px 24px; }

/* Timeline (post previews) */
.timeline { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.post { display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--line); }
.post:first-child { border-top: 0; }
.post .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--sunken); object-fit: cover; }
.post .body { min-width: 0; display: grid; gap: 4px; }
.post .who { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.post .who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.post .who .handle { color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.post .who .time { margin-left: auto; color: var(--ink-soft); font-size: .88rem; flex: none; }
.post .note { font-size: .8rem; color: var(--ink-soft); font-weight: 600; }
.post .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.post .thumbs { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; margin-top: 4px; }
.post .thumbs img { width: 100%; max-height: 220px; border-radius: 10px; object-fit: cover; border: 1px solid var(--line); }
.stats { display: flex; gap: 18px; font-size: .84rem; color: var(--ink-soft); font-variant-numeric: tabular-nums; margin-top: 2px; }
.empty { padding: 32px 20px; text-align: center; color: var(--ink-soft); }
`

export function layout(
  title: string,
  body: Html,
  viewer: Viewer = anonymous,
  opts: { current?: 'feeds' | 'playground'; wide?: boolean; welcome?: boolean } = {},
): Html {
  const here = (page: 'feeds' | 'playground') => (opts.current === page ? raw('aria-current="page"') : '')
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${FONTS}" />
    <style>${raw(STYLE)}</style>
  </head>
  <body${opts.welcome ? raw(' class="welcome"') : ''}>
    <header class="topbar${opts.wide || opts.welcome ? raw(' wide') : ''}">
      <div class="topbar-inner">
        <a class="brand" href="/">${raw(MARK)}<span>${SITE_NAME}</span></a>
        ${opts.welcome
          ? ''
          : html`<nav class="nav" aria-label="Main">
              <a href="/" ${here('feeds')}>Feeds</a>
              <a href="/playground" ${here('playground')}>Playground</a>
            </nav>`}
        <span class="spacer"></span>
        ${viewer.signedIn
          ? html`<div class="account">
              ${whoami(viewer)}
              <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
            </div>`
          : viewer.canSignIn && !opts.welcome
            ? html`<a class="button secondary" href="/login">Sign in</a>`
            : ''}
      </div>
    </header>
    <main${opts.wide || opts.welcome ? raw(' class="wide"') : ''}>${body}</main>
  </body>
</html>`
}

/** "Signed in as @handle", with the account's avatar, so it's clear which account is in use. */
function whoami(viewer: Viewer): Html {
  if (!viewer.handle) return html`<span class="whoami"><span class="face" aria-hidden="true">✓</span><span>Signed in</span></span>`
  const face = viewer.avatar
    ? html`<img src="${viewer.avatar}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : html`<span class="face" aria-hidden="true">${viewer.handle.slice(0, 1).toUpperCase()}</span>`
  return html`<a class="whoami" href="https://bsky.app/profile/${viewer.handle}" target="_blank" rel="noopener" title="Signed in as @${viewer.handle}">
    ${face}<span class="names"><span class="as">Signed in as</span><strong>@${viewer.handle}</strong></span>
  </a>`
}

export function notice(message: string | Html, kind: '' | 'error' | 'ok' = ''): Html {
  return html`<div class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`
}
