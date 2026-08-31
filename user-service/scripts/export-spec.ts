/**
 * Exports the user-service OpenAPI spec to openapi.json.
 * Run with: npm run gen:spec
 * The generated file is consumed by the frontend's `pnpm gen:api` to produce typed clients.
 */
import spec from '../src/openapi'
import { resolve } from 'node:path'
import { replaceContractFile } from '../../scripts/lib/atomic-contract-file.cjs'

const outPath = resolve(__dirname, '../openapi.json')
replaceContractFile(outPath, JSON.stringify(spec, null, 2))
console.log(`✓ user-service spec exported → ${outPath}`)
