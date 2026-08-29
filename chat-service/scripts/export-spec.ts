/**
 * Exports the chat-service OpenAPI spec to openapi.json.
 * Run with: npm run gen:spec
 * The generated file is consumed by the frontend's `pnpm gen:api` to produce typed clients.
 */
import spec from '../src/openapi'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outPath = resolve(__dirname, '../openapi.json')
writeFileSync(outPath, JSON.stringify(spec, null, 2))
console.log(`✓ chat-service spec exported → ${outPath}`)
