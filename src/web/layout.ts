import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

/** Who is looking at the page, which decides the navigation and which actions are offered. */
export interface Viewer {
  signedIn: boolean
  /** Sign-in is available (a database is configured). */
  canSignIn: boolean
}

export const anonymous: Viewer = { signedIn: false, canSignIn: false }

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#16181c; --muted:#5b6470; --border:#e2e5ea; --accent:#1083fe; --accent-text:#fff; --warn-bg:#fff6e0; --warn:#7a5200; --err-bg:#fdecec; --err:#9b1c1c; --ok-bg:#e7f6ec; --ok:#1d6b3a; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1318; --card:#171c23; --text:#e8ebef; --muted:#97a1ad; --border:#2a313b; --accent:#4aa3ff; --accent-text:#06121f; --warn-bg:#3a2e10; --warn:#f2cf7a; --err-bg:#3d1717; --err:#f5a3a3; --ok-bg:#14301f; --ok:#8fd9a8; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:760px; margin:0 auto; padding:24px 16px 64px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 12px; }
.muted { color:var(--muted); } .small { font-size:13px; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
nav { display:flex; gap:16px; margin-bottom:24px; font-weight:600; align-items:center; }
nav .spacer { flex:1; }
nav form { margin:0; }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:12px; }
.row { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
.tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.tag { font-size:12px; border:1px solid var(--border); border-radius:99px; padding:1px 8px; color:var(--muted); }
.badge { font-size:12px; font-weight:600; border-radius:99px; padding:2px 10px; background:var(--border); color:var(--muted); white-space:nowrap; }
.badge.ok { background:var(--ok-bg); color:var(--ok); } .badge.warn { background:var(--warn-bg); color:var(--warn); }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:12px; }
.actions form { margin:0; }
.notice { border-radius:10px; padding:10px 14px; margin-bottom:10px; font-size:14px; background:var(--warn-bg); color:var(--warn); }
.notice.error { background:var(--err-bg); color:var(--err); white-space:pre-wrap; }
.notice.ok { background:var(--ok-bg); color:var(--ok); }
.post { display:grid; grid-template-columns:40px 1fr; gap:10px; }
.post .avatar { width:40px; height:40px; border-radius:50%; background:var(--border); }
.post .text { white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; }
.post .thumbs { display:flex; gap:6px; margin:6px 0; }
.post .thumbs img { max-width:100%; max-height:180px; border-radius:8px; object-fit:cover; }
.stats { display:flex; gap:14px; font-size:13px; color:var(--muted); }
textarea, input, select { width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font:inherit; }
textarea { min-height:64px; resize:vertical; }
textarea.code { min-height:340px; font:13px ui-monospace,Menlo,monospace; padding:12px; }
input[type=checkbox] { width:auto; margin:0 6px 0 0; }
input[readonly] { color:var(--muted); }
button, .button { display:inline-block; padding:8px 16px; border:0; border-radius:99px; background:var(--accent); color:var(--accent-text); font:inherit; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }
.button:hover { text-decoration:none; }
button.secondary, .button.secondary { background:transparent; color:var(--accent); border:1px solid var(--border); }
button.danger { background:transparent; color:var(--err); border:1px solid var(--border); }
button.link { background:none; border:0; padding:0; color:var(--accent); font-weight:600; font-size:15px; }
button:disabled { opacity:.6; cursor:progress; }
label { display:block; font-weight:600; margin:14px 0 6px; }
label.check { display:flex; align-items:center; font-weight:normal; margin:8px 0; }
.hint { font-size:13px; color:var(--muted); font-weight:normal; margin:4px 0 0; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:0 12px; }
fieldset { border:1px solid var(--border); border-radius:12px; padding:4px 16px 16px; margin:0 0 16px; background:var(--card); }
legend { font-weight:700; padding:0 6px; }
`

export function layout(title: string, body: Html, viewer: Viewer = anonymous): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <main>
      <nav>
        <a href="/">Feeds</a><a href="/playground">Playground</a>
        <span class="spacer"></span>
        ${viewer.signedIn
          ? html`<form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>`
          : viewer.canSignIn
            ? html`<a href="/login">Sign in</a>`
            : ''}
      </nav>
      ${body}
    </main>
  </body>
</html>`
}

export function notice(message: string | Html, kind: '' | 'error' | 'ok' = ''): Html {
  return html`<div class="notice ${kind}">${message}</div>`
}
