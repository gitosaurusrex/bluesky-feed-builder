import { serve } from '@hono/node-server'
import { loadDotEnv } from './config.js'

// Long-running Node server for Render, Railway, Fly, a VPS, or local development.
loadDotEnv()
const { createInstance } = await import('./instance.js')
const { app, config, engine } = await createInstance()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  void engine.feeds().then((feeds) => console.log(`Serving ${feeds.length} feeds on http://127.0.0.1:${info.port}`))
})
