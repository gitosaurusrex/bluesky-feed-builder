/**
 * Prints a new private key for OAUTH_PRIVATE_KEY. With it, Bluesky trusts this
 * deployment as a confidential client and keeps your sign-in alive far longer.
 *
 *   npm run oauth-key
 */
import { generateOAuthKey } from '../src/auth.js'

console.log(`OAUTH_PRIVATE_KEY=${await generateOAuthKey()}`)
console.error('\nAdd this as an environment variable on your deployment. Keep it secret: anyone with it can pose as your Feed Builder.')
