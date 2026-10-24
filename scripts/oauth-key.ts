/**
 * Prints a new private key for OAUTH_PRIVATE_KEY. Optional: without it, the app
 * generates a key on first use and keeps it in the database. Set one yourself
 * to keep the key out of the database, or to share it between databases.
 *
 *   npm run oauth-key
 */
import { generateOAuthKey } from '../src/auth.js'

console.log(`OAUTH_PRIVATE_KEY=${await generateOAuthKey()}`)
console.error('\nAdd this as an environment variable on your deployment. Keep it secret: anyone with it can pose as your Feed Builder.')
