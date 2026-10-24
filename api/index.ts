import { waitUntil } from '@vercel/functions'
import { createInstance } from '../src/instance.js'

// Vercel entry point. vercel.json rewrites every path here, including /.well-known/did.json.
const { app } = createInstance({ waitUntil })

export const GET = (request: Request) => app.fetch(request)
export const POST = (request: Request) => app.fetch(request)
