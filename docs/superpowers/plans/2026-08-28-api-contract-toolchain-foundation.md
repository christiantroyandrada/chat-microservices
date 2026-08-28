# API Contract and Toolchain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish reproducible frontend tooling and make the generated API layer accurately describe and consume the current backend wire contracts.

**Architecture:** Backend OpenAPI source files define exact response envelopes and request shapes and export deterministic JSON artifacts. The frontend commits versioned copies of those contracts, generates types through a pure deterministic module, and routes existing services through thin generated endpoint helpers while retaining domain normalization in the service layer.

**Tech Stack:** Node.js 22, pnpm 9.11.0, TypeScript 5.9, SvelteKit 2, Vitest 3, Jest 30, OpenAPI 3.0, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-chat-reliability-architecture-design.md`

## Global Constraints

- Preserve all unrelated uncommitted frontend and backend work.
- Make separate commits in the frontend and backend repositories; never combine their Git state.
- DRY: one schema definition per wire concept and one generator implementation.
- SOLID/Clean Architecture: OpenAPI conversion is a pure module; filesystem and CLI behavior remain adapters.
- ACID/PostgreSQL: this foundation changes no database schema or transaction behavior.
- Idempotency: contract generation is deterministic and `--check` performs no writes.
- Debounce: no debounce belongs in this subproject because generation and HTTP contract calls are discrete commands.
- Tao of Node: pin runtime/tool versions, validate inputs, propagate failures, avoid hidden global state, and keep entry points thin.
- Production topology: frontend images must use immutable SHA tags before coordinated contract rollout; the shared Nginx gateway is out of scope for this plan.
- All production code changes follow red-green-refactor TDD. Generated files are produced only after generator tests fail for the intended missing behavior.

---

### Task 1: Frontend toolchain contract and repository hygiene

**Files:**

- Create: `../frontend/tests/unit/toolchain.contract.test.ts`
- Modify: `../frontend/package.json`
- Modify: `../frontend/pnpm-lock.yaml`
- Modify: `../frontend/.gitignore`
- Delete: `../frontend/src/lib/components/ChatList.stories 2.ts`
- Delete: `../frontend/src/lib/features 2.ts`
- Delete: `../frontend/src/lib/services/api.generated 2.ts`
- Delete: `chat-service/openapi 2.json`
- Delete: `user-service/openapi 2.json`

**Interfaces:**

- Produces: frontend runtime contract `packageManager: "pnpm@9.11.0"`, Node engine `>=22 <23`, pnpm engine `9.11.0`, direct `@storybook/svelte` development dependency, ignored `storybook-static/`, and no conflict-copy files.
- Consumes: existing Storybook 10 configuration and the CI Node/pnpm versions.

- [ ] **Step 1: Write the failing toolchain contract test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
	packageManager?: string;
	engines?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

describe('frontend toolchain contract', () => {
	it('pins the same Node and pnpm versions used by CI', () => {
		expect(pkg.packageManager).toBe('pnpm@9.11.0');
		expect(pkg.engines).toEqual({ node: '>=22 <23', pnpm: '9.11.0' });
	});

	it('declares Storybook imports directly and ignores generated output', () => {
		expect(pkg.devDependencies?.['@storybook/svelte']).toMatch(/^\^10\./);
		expect(readFileSync(resolve(root, '.gitignore'), 'utf8')).toContain('storybook-static/');
	});

	it('contains no Finder conflict-copy files', () => {
		const conflictCopies = readdirSync(resolve(root, 'src'), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && / 2\.[^.]+$/.test(entry.name))
			.map((entry) => entry.name);
		expect(conflictCopies).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test and verify the expected failures**

Run from `../frontend`:

```bash
node_modules/.bin/vitest --run tests/unit/toolchain.contract.test.ts
```

Expected: FAIL because `packageManager`, `engines`, `@storybook/svelte`, `.gitignore` coverage, and conflict-copy cleanup are absent.

- [ ] **Step 3: Reconfirm duplicate files before deletion**

Run from the workspace root:

```bash
shasum "chat-app/frontend/src/lib/components/ChatList.stories 2.ts" chat-app/frontend/src/lib/components/ChatList.stories.ts
shasum "chat-app/frontend/src/lib/features 2.ts" chat-app/frontend/src/lib/features.ts
shasum "chat-app/frontend/src/lib/services/api.generated 2.ts" chat-app/frontend/src/lib/services/api.generated.ts
shasum "chat-app/backend/chat-service/openapi 2.json" chat-app/backend/chat-service/openapi.json
shasum "chat-app/backend/user-service/openapi 2.json" chat-app/backend/user-service/openapi.json
```

Expected: each pair has identical SHA-1 output. Stop rather than delete if any pair differs.

- [ ] **Step 4: Apply the minimal toolchain changes**

Add these fields to `../frontend/package.json`:

```json
{
  "packageManager": "pnpm@9.11.0",
  "engines": {
    "node": ">=22 <23",
    "pnpm": "9.11.0"
  },
  "devDependencies": {
    "@storybook/svelte": "^10.0.0"
  }
}
```

Append `storybook-static/` to `.gitignore`, remove the five verified identical conflict copies, and regenerate the lockfile with the CI-pinned manager:

```bash
CI=true npx --yes pnpm@9.11.0 install --lockfile-only
```

- [ ] **Step 5: Verify the focused test and frontend checks**

```bash
node_modules/.bin/vitest --run tests/unit/toolchain.contract.test.ts
node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
```

Expected: PASS with zero Svelte diagnostics.

- [ ] **Step 6: Commit frontend toolchain hygiene**

```bash
git add package.json pnpm-lock.yaml .gitignore tests/unit/toolchain.contract.test.ts
git commit -m "chore: pin frontend toolchain and clean artifacts"
```

The five conflict copies were untracked, so their verified deletion is intentionally not represented as a Git commit.

---

### Task 2: Canonical user-service OpenAPI envelopes and prekey shapes

**Files:**

- Create: `user-service/tests/unit/openapi.contract.test.ts`
- Modify: `user-service/src/openapi.ts`
- Regenerate: `user-service/openapi.json`

**Interfaces:**

- Produces: `RegisterRequest`, `LoginRequest`, `User`, `SearchUser`, `UserResponse`, `UserListResponse`, `StatusResponse`, `SignedPreKey`, `OneTimePreKey`, `PrekeyBundle`, `PublishPrekeyRequest`, `ConsumedPrekey`, `ConsumedPrekeyResponse`, `SignalKeyBackupRequest`, and `SignalKeyBackupResponse` schemas.
- Consumes: current controller responses from `AuthController` and `PrekeyController`; no runtime behavior changes.

- [ ] **Step 1: Write failing user contract tests**

```ts
import spec from '../../src/openapi';

type Method = 'get' | 'post';

function responseRef(path: string, method: Method, status = '200'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method];
  return operation?.responses?.[status]?.content?.['application/json']?.schema?.$ref;
}

describe('user-service OpenAPI contract', () => {
  it('wraps runtime values in the actual API envelope', () => {
    expect(responseRef('/register', 'post')).toBe('#/components/schemas/UserResponse');
    expect(responseRef('/login', 'post')).toBe('#/components/schemas/StatusResponse');
    expect(responseRef('/me', 'get')).toBe('#/components/schemas/UserResponse');
    expect(responseRef('/search', 'get')).toBe('#/components/schemas/UserListResponse');
  });

  it('names authentication request bodies for deterministic generation', () => {
    const paths = spec.paths as Record<string, Record<string, any>>;
    expect(paths['/register'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/RegisterRequest'
    );
    expect(paths['/login'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/LoginRequest'
    );
  });

  it('models publish and consume prekey payloads separately', () => {
    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.PublishPrekeyRequest.required).toEqual(['deviceId', 'bundle']);
    expect(schemas.PrekeyBundle.required).toEqual([
      'registrationId', 'identityKey', 'signedPreKey', 'preKeys'
    ]);
    expect(schemas.PrekeyBundle.properties.preKeys.type).toBe('array');
    expect(responseRef('/prekeys/{userId}', 'get')).toBe(
      '#/components/schemas/ConsumedPrekeyResponse'
    );
  });

  it('requires the distinct runtime user shapes', () => {
    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.User.required).toEqual([
      'id', 'username', 'email'
    ]);
    expect(schemas.SearchUser.required).toEqual(['_id', 'username', 'email']);
    expect(schemas.UserListResponse.required).toEqual(['status', 'data']);
    expect(schemas.UserListResponse.properties.data.items.$ref).toBe(
      '#/components/schemas/SearchUser'
    );
  });
});
```

- [ ] **Step 2: Run the test and verify schema drift is detected**

Run from `user-service`:

```bash
node_modules/.bin/jest tests/unit/openapi.contract.test.ts --runInBand
```

Expected: FAIL on raw `User` responses, singular `preKey`, optional fields, and the missing publish/consume wrappers.

- [ ] **Step 3: Define exact reusable schemas and update path references**

Implement these required shapes in `components.schemas`:

```ts
RegisterRequest: {
  type: 'object' as const,
  required: ['username', 'email', 'password'],
  properties: {
    username: { type: 'string' as const, minLength: 3, maxLength: 30, pattern: '^[a-z0-9_-]+$' },
    email: { type: 'string' as const, format: 'email' },
    password: { type: 'string' as const, minLength: 8 },
  },
},
LoginRequest: {
  type: 'object' as const,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string' as const, format: 'email' },
    password: { type: 'string' as const },
  },
},
StatusResponse: {
  type: 'object' as const,
  required: ['status', 'message'],
  properties: {
    status: { type: 'integer' as const },
    message: { type: 'string' as const },
  },
},
User: {
  type: 'object' as const,
  required: ['id', 'username', 'email'],
  properties: {
    id: { type: 'string' as const, format: 'uuid' },
    username: { type: 'string' as const },
    email: { type: 'string' as const, format: 'email' },
  },
},
UserResponse: {
  type: 'object' as const,
  required: ['status', 'message', 'data'],
  properties: {
    status: { type: 'integer' as const },
    message: { type: 'string' as const },
    data: { $ref: '#/components/schemas/User' },
  },
},
SearchUser: {
  type: 'object' as const,
  required: ['_id', 'username', 'email'],
  properties: {
    _id: { type: 'string' as const, format: 'uuid' },
    username: { type: 'string' as const },
    email: { type: 'string' as const, format: 'email' },
  },
},
UserListResponse: {
  type: 'object' as const,
  required: ['status', 'data'],
  properties: {
    status: { type: 'integer' as const },
    data: { type: 'array' as const, items: { $ref: '#/components/schemas/SearchUser' } },
  },
},
PublishPrekeyRequest: {
  type: 'object' as const,
  required: ['deviceId', 'bundle'],
  properties: {
    deviceId: { type: 'string' as const },
    bundle: { $ref: '#/components/schemas/PrekeyBundle' },
  },
},
ConsumedPrekey: {
  type: 'object' as const,
  required: ['userId', 'deviceId', 'bundle'],
  properties: {
    userId: { type: 'string' as const, format: 'uuid' },
    deviceId: { type: 'string' as const },
    bundle: { $ref: '#/components/schemas/PrekeyBundle' },
  },
},
```

Define `signedPreKey` and `preKeys[]` from `user-service/src/types.ts`, make their fields required, and point every successful path response at the matching envelope schema.

Replace the inline register/login request bodies with `$ref` values to `RegisterRequest` and `LoginRequest`.

- [ ] **Step 4: Regenerate and verify user-service**

```bash
npm run gen:spec
node_modules/.bin/jest tests/unit/openapi.contract.test.ts --runInBand
node_modules/.bin/tsc --noEmit -p tsconfig.json
git diff --check -- src/openapi.ts openapi.json tests/unit/openapi.contract.test.ts
```

Expected: test and TypeScript PASS; `openapi.json` changes deterministically.

- [ ] **Step 5: Commit the user-service contract**

```bash
git add user-service/src/openapi.ts user-service/openapi.json user-service/tests/unit/openapi.contract.test.ts
git commit -m "fix(user): align OpenAPI with runtime envelopes"
```

---

### Task 3: Canonical chat-service response envelopes

**Files:**

- Create: `chat-service/tests/unit/openapi.contract.test.ts`
- Modify: `chat-service/src/openapi.ts`
- Regenerate: `chat-service/openapi.json`

**Interfaces:**

- Produces: `Pagination`, `MessageResponse`, `MessagesPageResponse`, `ConversationListResponse`, and `MarkReadResponse` schemas using runtime status values `NotDelivered | Delivered | Seen`.
- Consumes: current `MessageController` JSON responses; message idempotency fields are deferred to the messaging plan.

- [ ] **Step 1: Write failing chat contract tests**

```ts
import spec from '../../src/openapi';

function responseRef(path: string, method: 'get' | 'post' | 'put'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method];
  return operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
}

describe('chat-service OpenAPI contract', () => {
  it('uses the runtime message status values', () => {
    const message = (spec.components.schemas as Record<string, any>).Message;
    expect(message.properties.status.enum).toEqual(['NotDelivered', 'Delivered', 'Seen']);
    expect(message.required).toEqual([
      'id', 'senderId', 'receiverId', 'message', 'isEncrypted', 'status', 'createdAt', 'updatedAt'
    ]);
  });

  it('models each successful response envelope exactly once', () => {
    expect(responseRef('/send', 'post')).toBe('#/components/schemas/MessageResponse');
    expect(responseRef('/get/{receiverId}', 'get')).toBe(
      '#/components/schemas/MessagesPageResponse'
    );
    expect(responseRef('/conversations', 'get')).toBe(
      '#/components/schemas/ConversationListResponse'
    );
    expect(responseRef('/messages/read/{senderId}', 'put')).toBe(
      '#/components/schemas/MarkReadResponse'
    );
    expect((spec.components.schemas as Record<string, any>).MessagesPageResponse.properties.pagination.$ref).toBe(
      '#/components/schemas/Pagination'
    );
  });
});
```

- [ ] **Step 2: Run the test and verify expected failures**

Run from `chat-service`:

```bash
node_modules/.bin/jest tests/unit/openapi.contract.test.ts --runInBand
```

Expected: FAIL because status currently uses `Not Delivered`, message fields are optional, and responses use raw/inline schemas.

- [ ] **Step 3: Add reusable envelope components**

Use named pagination and message-page components:

```ts
Pagination: {
  type: 'object' as const,
  required: ['total', 'limit', 'offset', 'hasMore'],
  properties: {
    total: { type: 'integer' as const },
    limit: { type: 'integer' as const },
    offset: { type: 'integer' as const },
    hasMore: { type: 'boolean' as const },
  },
},
MessagesPageResponse: {
  type: 'object' as const,
  required: ['status', 'message', 'data', 'pagination'],
  properties: {
    status: { type: 'integer' as const },
    message: { type: 'string' as const },
    data: { type: 'array' as const, items: { $ref: '#/components/schemas/Message' } },
    pagination: { $ref: '#/components/schemas/Pagination' },
  },
},
```

Create equivalent named envelopes for the other three successful responses and replace the inline schemas with `$ref` values.

- [ ] **Step 4: Regenerate and verify chat-service**

```bash
npm run gen:spec
node_modules/.bin/jest tests/unit/openapi.contract.test.ts --runInBand
node_modules/.bin/tsc --noEmit -p tsconfig.json
git diff --check -- src/openapi.ts openapi.json tests/unit/openapi.contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the chat-service contract**

```bash
git add chat-service/src/openapi.ts chat-service/openapi.json chat-service/tests/unit/openapi.contract.test.ts
git commit -m "fix(chat): align OpenAPI with runtime envelopes"
```

---

### Task 4: Deterministic cross-repository contract generation

**Files:**

- Create: `../frontend/contracts/user-service.openapi.json`
- Create: `../frontend/contracts/chat-service.openapi.json`
- Create: `../frontend/contracts/source.json`
- Create: `../frontend/scripts/lib/openapi-to-types.mjs`
- Create: `../frontend/scripts/sync-api-contracts.mjs`
- Create: `../frontend/tests/unit/openapi-generator.test.ts`
- Modify: `../frontend/scripts/gen-api-types.mjs`
- Modify: `../frontend/package.json`
- Regenerate: `../frontend/src/lib/generated/api.types.ts`

**Interfaces:**

- Produces: `generateApiTypes({ userSpec, chatSpec, source }) => string`, CLI `gen-api-types.mjs [--check]`, and sync command `sync-api-contracts.mjs --backend-dir ../backend`.
- Consumes: committed frontend contract JSON, never a sibling repository during CI generation.

- [ ] **Step 1: Write failing pure-generator tests**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateApiTypes } from '../../scripts/lib/openapi-to-types.mjs';

const root = resolve(import.meta.dirname, '../..');
const userSpec = JSON.parse(readFileSync(resolve(root, 'contracts/user-service.openapi.json'), 'utf8'));
const chatSpec = JSON.parse(readFileSync(resolve(root, 'contracts/chat-service.openapi.json'), 'utf8'));
const source = { backendCommit: 'contract-test', generatorVersion: 1 };

describe('OpenAPI type generator', () => {
	it('is deterministic and records its source', () => {
		const first = generateApiTypes({ userSpec, chatSpec, source });
		const second = generateApiTypes({ userSpec, chatSpec, source });
		expect(first).toBe(second);
		expect(first).toContain('backendCommit: contract-test');
	});

	it('generates exact prekey, array, pagination, and status types', () => {
		const output = generateApiTypes({ userSpec, chatSpec, source });
		expect(output).toContain('export interface UserApiPublishPrekeyRequest');
		expect(output).toContain('preKeys: UserApiOneTimePreKey[]');
		expect(output).toContain('export interface UserApiConsumedPrekey');
		expect(output).toContain('bundle: UserApiPrekeyBundle');
		expect(output).toContain('data: UserApiSearchUser[]');
		expect(output).toContain('pagination: ChatApiPagination');
		expect(output).toContain("status: 'NotDelivered' | 'Delivered' | 'Seen'");
	});
});
```

- [ ] **Step 2: Create contract inputs and verify the test fails on the missing module**

Copy the freshly generated backend JSON files into `../frontend/contracts/` and create:

```json
{
  "backendCommit": "a42ef09",
  "generatorVersion": 1
}
```

This initial metadata value identifies the topology-amended design baseline. Step 4 replaces it with the exact post-contract backend commit through `sync-api-contracts.mjs` before generated artifacts are committed.

Run:

```bash
node_modules/.bin/vitest --run tests/unit/openapi-generator.test.ts
```

Expected: FAIL because `scripts/lib/openapi-to-types.mjs` does not exist.

- [ ] **Step 3: Extract the pure generator**

Move `schemaToTs`, `objectSchemaToInterface`, and `componentToTs` into `scripts/lib/openapi-to-types.mjs`. Pass the service namespace through every recursive conversion so local `$ref` values become `UserApiFoo` or `ChatApiFoo`; never emit an unqualified component name. Export:

```js
export function generateApiTypes({ userSpec, chatSpec, source }) {
	const out = [
		'/**',
		' * AUTO-GENERATED from committed OpenAPI contracts.',
		` * backendCommit: ${source.backendCommit}`,
		` * generatorVersion: ${source.generatorVersion}`,
		' */'
	];

	for (const [name, schema] of Object.entries(userSpec.components?.schemas ?? {})) {
		if (name !== 'Error') out.push(componentToTs(`UserApi${name}`, schema, 'UserApi'));
	}
	for (const [name, schema] of Object.entries(chatSpec.components?.schemas ?? {})) {
		if (name !== 'Error') out.push(componentToTs(`ChatApi${name}`, schema, 'ChatApi'));
	}
	return `${out.join('\n\n')}\n`;
}
```

Preserve required-vs-optional fields, `$ref`, arrays, enums, and nullable values.

- [ ] **Step 4: Make generation idempotent and check-only**

Refactor `scripts/gen-api-types.mjs` to read `contracts/*.json` and implement:

```js
const checkOnly = process.argv.includes('--check');
const generated = generateApiTypes({ userSpec, chatSpec, source });
const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';

if (checkOnly) {
	if (current !== generated) {
		console.error('Generated API types are stale. Run: pnpm gen:api');
		process.exitCode = 1;
	}
} else if (current !== generated) {
	writeFileSync(outPath, generated);
}
```

Add scripts:

```json
{
  "sync:contracts": "node scripts/sync-api-contracts.mjs --backend-dir ../backend",
  "gen:api": "node scripts/gen-api-types.mjs",
  "check:contracts": "node scripts/gen-api-types.mjs --check"
}
```

`sync-api-contracts.mjs` validates that both source files exist, copies them into `contracts/`, reads the backend Git commit through `execFileSync('git', ['-C', backendDir, 'rev-parse', 'HEAD'])`, and writes `source.json`. It rejects unknown arguments and never reads backend environment files.

Run the sync adapter once before generation so `source.json` records the post-Task-3 backend commit:

```bash
node scripts/sync-api-contracts.mjs --backend-dir ../backend
```

- [ ] **Step 5: Verify red-to-green and check-only behavior**

```bash
node_modules/.bin/vitest --run tests/unit/openapi-generator.test.ts
node scripts/gen-api-types.mjs
node scripts/gen-api-types.mjs --check
git diff --check -- contracts scripts src/lib/generated/api.types.ts tests/unit/openapi-generator.test.ts package.json
```

Expected: PASS. A second normal generation produces no diff; `--check` exits 0 without writing.

- [ ] **Step 6: Commit deterministic generation in the frontend**

```bash
git add contracts scripts package.json pnpm-lock.yaml src/lib/generated/api.types.ts tests/unit/openapi-generator.test.ts
git commit -m "feat: generate API types from committed contracts"
```

---

### Task 5: Typed endpoint helpers and service adoption

**Files:**

- Create: `../frontend/tests/unit/api.generated.test.ts`
- Modify: `../frontend/src/lib/types/index.ts`
- Modify: `../frontend/src/lib/services/api.ts`
- Modify: `../frontend/src/lib/services/api.generated.ts`
- Modify: `../frontend/src/lib/services/auth.service.ts`
- Modify: `../frontend/src/lib/services/chat.service.ts`
- Modify: `../frontend/tests/unit/api.client.test.ts`
- Modify: `../frontend/tests/unit/auth.service.test.ts`
- Modify: `../frontend/tests/unit/chat.service.test.ts`

**Interfaces:**

- Produces: generated endpoint helpers typed to the unwrapped `ApiClient` result and explicit pagination metadata.
- Consumes: `ApiClient`, generated component types, and existing domain normalization functions.

- [ ] **Step 1: Write failing endpoint-helper tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('$lib/services/api', () => ({ apiClient: { get, post, put } }));

describe('generated API helpers', () => {
	beforeEach(() => vi.clearAllMocks());

	it('publishes and consumes the real prekey shapes', async () => {
		const { userApi } = await import('$lib/services/api.generated');
		const body = {
			deviceId: 'device-1',
			bundle: {
				registrationId: 1,
				identityKey: 'identity',
				signedPreKey: { keyId: 2, publicKey: 'signed', signature: 'sig' },
				preKeys: [{ keyId: 3, publicKey: 'one-time' }]
			}
		};
		post.mockResolvedValue({ success: true });
		get.mockResolvedValue({ success: true, data: { userId: 'u', ...body } });

		await userApi.publishPrekey(body);
		await userApi.getPrekeyBundle('u');

		expect(post).toHaveBeenCalledWith('/user/prekeys', body);
		expect(get).toHaveBeenCalledWith('/user/prekeys/u');
	});

	it('types arrays as arrays and preserves message pagination', async () => {
		const { userApi, chatApi } = await import('$lib/services/api.generated');
		get.mockResolvedValue({ success: true, data: [], pagination: { total: 0, limit: 50, offset: 0, hasMore: false } });
		expect((await userApi.searchUsers('ada')).data).toEqual([]);
		expect((await chatApi.getMessages('u')).pagination.total).toBe(0);
	});
});
```

Also add an `api.client.test.ts` regression using a successful `{ status: 200, message: 'Login successful' }` fetch response. Assert the normalized result keeps `message` but has `data === undefined`; an envelope without a `data` property must not be treated as its own payload.

- [ ] **Step 2: Run the endpoint-helper test and verify it fails**

```bash
node_modules/.bin/vitest --run tests/unit/api.generated.test.ts
```

Expected: FAIL because prekey wrappers, array return types, and typed pagination do not match runtime.

- [ ] **Step 3: Add typed metadata support to ApiClient**

Change the API result shape to:

```ts
export type ApiResponse<T = unknown, TMeta extends object = Record<never, never>> = {
	success: boolean;
	data?: T;
	message?: string;
	error?: string;
} & TMeta;
```

Update `request`, `get`, `post`, `put`, and `delete` with a second generic `TMeta extends object = Record<never, never>`.

Correct the existing envelope fallback at the same boundary: if a JSON object has any envelope key (`status`, `message`, `error`, or `data`), expose only its `data` property as `ApiResponse.data`; preserve the whole object only for a genuinely raw, non-envelope response. This makes cookie-only login/logout responses resolve with `data === undefined` without discarding their message.

- [ ] **Step 4: Correct endpoint-helper types**

Implement these signatures:

```ts
register(body: UserApiRegisterRequest): Promise<ApiResponse<UserApiUser>>;
login(body: UserApiLoginRequest): Promise<ApiResponse<void>>;
getCurrentUser(): Promise<ApiResponse<UserApiUser>>;
searchUsers(q: string): Promise<ApiResponse<UserApiSearchUser[]>>;
publishPrekey(body: UserApiPublishPrekeyRequest): Promise<ApiResponse<void>>;
getPrekeyBundle(userId: string): Promise<ApiResponse<UserApiConsumedPrekey>>;
getMessages(receiverId: string, limit?: number, offset?: number): Promise<
	ApiResponse<ChatApiMessage[], { pagination: ChatApiPagination }>
>;
getConversations(): Promise<ApiResponse<ChatApiConversation[]>>;
markAsRead(senderId: string): Promise<ApiResponse<{ modifiedCount: number }>>;
```

Use URL encoding for every path/query value.

- [ ] **Step 5: Route auth and chat services through generated helpers**

Replace raw user/chat `apiClient` calls with `userApi` and `chatApi`. Keep these responsibilities in the domain-facing services:

- username normalization;
- `{ id } -> { _id }` user normalization;
- server message -> frontend message normalization;
- Signal encryption/decryption;
- IndexedDB storage.

Change `authService.login` to `Promise<void>` and `authService.register` to `Promise<User>`. Normalize the register result `{ id, username, email }` to the frontend `{ _id, username, email }`; search results already use `_id` on the wire. The auth store already ignores the login/register return and fetches `/me`, so no store behavior changes.

- [ ] **Step 6: Update service tests before implementation passes**

Change existing service mocks from `apiClient` to `userApi`/`chatApi`, and assert domain normalization remains unchanged. Add one regression test proving `authService.login()` resolves `undefined` after a successful cookie-only response.

- [ ] **Step 7: Verify focused and full frontend behavior**

```bash
node_modules/.bin/vitest --run tests/unit/api.generated.test.ts tests/unit/api.client.test.ts tests/unit/auth.service.test.ts tests/unit/chat.service.test.ts
node_modules/.bin/vitest --run
node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
```

Expected: focused tests PASS, then 320 existing tests plus new tests PASS, and Svelte check reports zero diagnostics.

- [ ] **Step 8: Commit typed service adoption**

```bash
git add src/lib/types/index.ts src/lib/services/api.ts src/lib/services/api.generated.ts src/lib/services/auth.service.ts src/lib/services/chat.service.ts tests/unit/api.generated.test.ts tests/unit/api.client.test.ts tests/unit/auth.service.test.ts tests/unit/chat.service.test.ts
git commit -m "refactor: consume generated API contracts"
```

---

### Task 6: Contract drift enforcement in both CI pipelines

**Files:**

- Modify: `.github/workflows/ci-main.yml`
- Modify: `.github/workflows/ci-feature.yml`
- Modify: `../frontend/.github/workflows/ci-main.yml`
- Modify: `../frontend/.github/workflows/ci-feature.yml`

**Interfaces:**

- Produces: backend exported-spec drift checks and frontend generated-type drift checks.
- Consumes: committed backend `openapi.json` artifacts and committed frontend `contracts/` inputs.

- [ ] **Step 1: Add a failing local CI-contract verification test**

Run from the backend root before changing workflows:

```bash
npm --prefix user-service run gen:spec
npm --prefix chat-service run gen:spec
git diff --exit-code -- user-service/openapi.json chat-service/openapi.json
```

Run from the frontend root:

```bash
node scripts/gen-api-types.mjs --check
```

Expected before Tasks 2-5: at least one command reports stale artifacts or missing check support. After Tasks 2-5, both commands exit 0.

- [ ] **Step 2: Enforce backend spec drift**

Add this step after TypeScript checks in both backend workflows:

```yaml
- name: Verify committed OpenAPI contracts
  run: |
    npm --prefix user-service run gen:spec
    npm --prefix chat-service run gen:spec
    git diff --exit-code -- user-service/openapi.json chat-service/openapi.json
```

- [ ] **Step 3: Enforce frontend tool and generated drift**

Change frontend installs to:

```yaml
- name: Install dependencies
  run: pnpm install --frozen-lockfile
```

Add before TypeScript/Svelte checks:

```yaml
- name: Verify generated API contracts
  run: pnpm run check:contracts
```

Do not fetch the backend repository in frontend CI. Contract updates enter through `pnpm sync:contracts` in a coordinated cross-repository change.

- [ ] **Step 4: Validate workflow syntax and local commands**

```bash
npm --prefix user-service run gen:spec
npm --prefix chat-service run gen:spec
git diff --exit-code -- user-service/openapi.json chat-service/openapi.json
```

```bash
CI=true npx --yes pnpm@9.11.0 install --frozen-lockfile
npx --yes pnpm@9.11.0 run check:contracts
npx --yes pnpm@9.11.0 run check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit CI enforcement separately**

Backend:

```bash
git add .github/workflows/ci-main.yml .github/workflows/ci-feature.yml
git commit -m "ci: reject stale backend API contracts"
```

Frontend:

```bash
git add .github/workflows/ci-main.yml .github/workflows/ci-feature.yml
git commit -m "ci: reject stale frontend API types"
```

---

### Task 7: Whole-foundation verification and handoff

**Files:**

- Verify only; no production files should change.

**Interfaces:**

- Produces: evidence that the first subproject is ready for adversarial review.
- Consumes: every task above.

- [ ] **Step 1: Verify both Git worktrees contain no unmerged paths**

```bash
git -C ../frontend diff --check
git -C . diff --check
git -C ../frontend status --short
git -C . status --short
```

Expected: no conflict markers or unmerged paths; only known unrelated user changes remain.

- [ ] **Step 2: Run backend verification**

```bash
npm --prefix user-service test
npm --prefix chat-service test
npm --prefix notification-service test
user-service/node_modules/.bin/tsc --noEmit -p user-service/tsconfig.json
chat-service/node_modules/.bin/tsc --noEmit -p chat-service/tsconfig.json
notification-service/node_modules/.bin/tsc --noEmit -p notification-service/tsconfig.json
npm --prefix user-service run gen:spec
npm --prefix chat-service run gen:spec
git diff --exit-code -- user-service/openapi.json chat-service/openapi.json
```

Expected: all 157 existing backend tests plus new contract tests PASS; all TypeScript checks exit 0; generated specs are clean.

- [ ] **Step 3: Run frontend verification**

```bash
npx --yes pnpm@9.11.0 run check:contracts
node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
node_modules/.bin/vitest --run
npx --yes pnpm@9.11.0 run build
```

Expected: all existing 320 frontend tests plus new tests PASS, Svelte check has zero diagnostics, contract check is clean, and the production build exits 0.

- [ ] **Step 4: Run production dependency audits without mutating lockfiles**

```bash
npx --yes pnpm@9.11.0 audit --prod --audit-level high
npm --prefix user-service audit --omit=dev --audit-level=high
npm --prefix chat-service audit --omit=dev --audit-level=high
npm --prefix notification-service audit --omit=dev --audit-level=high
```

Expected for this foundation: record the current findings without applying fixes. Critical/high dependency remediation is the next independently reviewed plan.

- [ ] **Step 5: Dispatch adversarial review**

Use three independent lenses on the complete cross-repository diff:

- correctness: runtime envelopes, generated types, and service normalization;
- failure modes: stale generation, malformed specs, CI isolation, and backward compatibility;
- structure: DRY/SOLID boundary between schemas, pure generator, endpoint helpers, and domain services.

Resolve every blocking/important finding before starting the dependency-hardening plan.
