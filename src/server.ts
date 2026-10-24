import { serve } from '@hono/node-server'
import { loadDotEnv } from './config.js'

// Long-running Node server for Render, Railway, Fly, a VPS, or local development.
loadDotEnv()
const { createInstance } = await import('./instance.js')
const { app, config, engine } = createInstance()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Serving ${engine.feeds.length} feeds on http://localhost:${info.port}`)
})
