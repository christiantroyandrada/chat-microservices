# Task 6 Runtime Contract Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Task 6 runtime-contract commits into trustworthy cross-repository evidence under Node 22/pnpm 9.11.0, then produce a release verdict without merging, pushing, or touching production.

**Architecture:** Keep the existing per-service controller-level conformance tests, but repair their test oracle and pagination control so unrelated validation cannot create false positives. Publish the changed backend OpenAPI files into the frontend through the accepted transactional snapshot tool, then verify both repositories in isolated Node 22 containers and the application in a local Colima topology.

**Tech Stack:** Node.js 22, npm, pnpm 9.11.0, Jest/ts-jest, Vitest, SvelteKit/TypeScript, OpenAPI 3, Docker Compose, Colima.

**Spec:** `docs/superpowers/specs/2026-08-28-chat-reliability-architecture-design.md`

## Current checkpoint

- Backend worktree: `/private/tmp/chat-app-api-contract.pbzyiq/backend`
- Frontend worktree: `/private/tmp/chat-app-api-contract.pbzyiq/frontend`
- Backend Task 6 commit: `c4219c30d20c30f9059cfd3f5c74755efece447a` (`test(api): prove runtime contract conformance`)
- Frontend Task 6 commit: `d4edadadbaeff924e49fa1c0d8ea76d63e306f46` (`test(api): verify generated response contracts`)
- Backend focused verification already observed: user-service 46 tests passed; chat runtime/OpenAPI 17 tests passed.
- Frontend focused verification already observed: 27 tests passed.
- Existing frontend `check:contracts` passes only against stale local copies. This is not cross-repository proof: frontend `contracts/source.json` still identifies backend `cc47bef`, while backend OpenAPI changed at `c4219c3`.
- The previous implementor did not create `task-6-report.md` and did not complete the supported-runtime, audit, or Colima gates.

## Global Constraints

- Work only in the two isolated worktrees above. The default checkouts contain user work and must remain untouched.
- Do not rewrite, amend, or squash the two checkpoint commits. Add bounded correction commits.
- Use red-green TDD for every behavior/test-oracle correction. Record the exact command, failure, and success.
- Never merge, push, deploy, contact or mutate the VPS, use Firebase, delete a volume, or modify any path containing the literal suffix ` 2`.
- Do not change dependencies while finalizing Task 6. Audits are evidence for the next dependency-hardening plan.
- Backend OpenAPI JSON, frontend contract copies, generated files, source provenance, and the snapshot manifest are committed deterministic artifacts.
- Do not claim a Linux/Node 22/Colima check unless that exact command ran successfully.
- Keep comments only when they explain a non-obvious invariant or constraint; remove comments that narrate adjacent code.
- Prefer precise `unknown` crossings over new `any` declarations. Do not loosen lint configuration or add disable comments.

---

### Task 1: Repair the runtime-contract test oracle

**Files:**

- Modify: `chat-service/tests/unit/runtime-contract.test.ts`
- Modify only if the same oracle defect exists there: `user-service/tests/unit/runtime-contract.test.ts`

**Interfaces:**

- Consumes: `fetchConversationValidation`, `validateRequest`, `MessageController.fetchConversation`, and OpenAPI `format`, `required`, `enum`, object, array, string, integer, number, and nullable schema fields.
- Produces: pagination tests whose failure reason is the pagination field under test and a schema oracle that cannot silently accept malformed UUID/date-time fixtures.

- [ ] **Step 1: Make the existing false positive fail honestly**

Replace the all-zero IDs used by middleware-facing requests with valid RFC 4122 UUIDs, for example:

```ts
const userIds = {
  sender: '11111111-1111-4111-8111-111111111111',
  recipient: '22222222-2222-4222-8222-222222222222',
  partner: '33333333-3333-4333-8333-333333333333',
}
```

Run:

```bash
cd /private/tmp/chat-app-api-contract.pbzyiq/backend/chat-service
npm run test:unit -- --runInBand tests/unit/runtime-contract.test.ts
```

Expected RED: the row currently labelled `zero limit` actually passes `offset: 0`; once the receiver UUID is valid, validation proceeds instead of returning the unrelated receiver-ID error, so the row no longer returns 400.

- [ ] **Step 2: Replace the ambiguous pagination table with field-specific query cases**

Use query objects rather than passing every value as `offset`:

```ts
it.each([
  ['zero limit', { limit: '0', offset: '0' }],
  ['limit above maximum', { limit: '201', offset: '0' }],
  ['fractional limit', { limit: '1.5', offset: '0' }],
  ['infinite limit', { limit: Infinity, offset: '0' }],
  ['negative offset', { limit: '50', offset: '-1' }],
  ['fractional offset', { limit: '50', offset: '1.5' }],
  ['unsafe offset', { limit: '50', offset: '9007199254740992' }],
  ['NaN offset', { limit: '50', offset: Number.NaN }],
])('rejects %s', async (_label, query) => {
  const result = await invokePaginationValidation(query)
  expect(result.statusCode).toBe(400)
  expect(result.nextCalled).toBe(false)
  assertContractResponse('/get/{receiverId}', 'get', 400, result.body)
})
```

Add a valid control proving `{ limit: '200', offset: '0' }` calls `next` and does not emit a 400 response. Do not assert that a repository was untouched unless the controller is actually invoked by that harness.

- [ ] **Step 3: Enforce schema formats used by the tested responses**

Extend the local `Schema` shape with `format?: string`. In the string branch, validate at least `uuid` and `date-time`:

```ts
case 'string': {
  expect(typeof value).toBe('string')
  if (resolved.format === 'uuid') {
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  }
  if (resolved.format === 'date-time') {
    expect(Number.isNaN(Date.parse(value as string))).toBe(false)
  }
  return
}
```

Use valid v4 UUIDs in every message fixture. Add one small adversarial self-test showing the oracle rejects an invalid UUID fixture; capture RED before adding format handling and GREEN after it.

- [ ] **Step 4: Apply comment/type hygiene**

Remove the opening comments that merely say the file contains runtime contract tests. Keep at most one comment explaining why the JSON round-trip is necessary for Express `res.json`/Date serialization. Replace new `any` values with narrow local shapes or `unknown` plus an explicit cast at the controller/Jest boundary. Do not change production controller code.

- [ ] **Step 5: Verify and commit**

Run both focused runtime/OpenAPI suites and `git diff --check`. Commit only the owned correction files:

```bash
git add chat-service/tests/unit/runtime-contract.test.ts user-service/tests/unit/runtime-contract.test.ts
git commit -m "test(api): close runtime conformance blind spots"
```

If the user-service file needs no correction, do not stage it.

---

### Task 2: Publish the backend contract change to the frontend snapshot

**Files:**

- Modify through the accepted producer only: `contracts/chat-service.openapi.json`
- Modify through the accepted producer only: `contracts/user-service.openapi.json`
- Modify through the accepted producer only: `contracts/source.json`
- Modify through the accepted producer only: `contracts/contract-snapshot.manifest.json`
- Modify only if generated bytes genuinely change: `src/lib/generated/api.operations.ts`
- Modify only if generated bytes genuinely change: `src/lib/generated/api.types.ts`

**Interfaces:**

- Consumes: backend `c4219c3` tracked OpenAPI blobs and the transactional snapshot publisher.
- Produces: one coherent frontend snapshot whose provenance identifies `c4219c3` and whose hashes match the copied bytes.

- [ ] **Step 1: Capture stale-snapshot RED**

Record the SHA-256 hashes of backend `user-service/openapi.json` and `chat-service/openapi.json` and their frontend copies. Assert they differ and record that `contracts/source.json` names backend `cc47bef`, not `c4219c3`.

- [ ] **Step 2: Run the transactional producer**

From the frontend worktree, run:

```bash
pnpm run sync:contracts
pnpm run gen:api
```

Do not copy or edit JSON by hand. The publisher must update the source/manifest last under its existing lock/atomicity rules.

- [ ] **Step 3: Prove coherent GREEN state**

Run:

```bash
pnpm run check:contracts
pnpm run gen:api -- --check
```

Compare backend/frontend OpenAPI hashes again; each pair must match. Verify `contracts/source.json` and `contract-snapshot.manifest.json` identify backend `c4219c30d20c30f9059cfd3f5c74755efece447a`. Run the focused frontend API tests and `git diff --check`.

- [ ] **Step 4: Commit the snapshot correction**

Stage only files changed by the producer and inspect the exact list before committing:

```bash
git commit -m "chore(api): synchronize runtime contract snapshot"
```

---

### Task 3: Run the supported-toolchain and security gates

**Files:**

- Create or update ignored evidence only: `backend/.superpowers/sdd/2026-08-30-api-contract-release-blockers/task-6-report.md`

**Interfaces:**

- Consumes: committed Task 6 backend/frontend ranges.
- Produces: exact Node 22/pnpm 9.11.0 test/build/audit evidence with no source mutation.

- [ ] **Step 1: Use isolated Node 22 containers**

Do not install Linux dependencies into the macOS worktrees. Mount anonymous `node_modules` volumes. Example frontend command:

```bash
docker run --rm \
  -v /private/tmp/chat-app-api-contract.pbzyiq/frontend:/workspace \
  -v /workspace/node_modules \
  -w /workspace node:22-bookworm \
  sh -lc 'corepack enable && corepack prepare pnpm@9.11.0 --activate && pnpm install --frozen-lockfile && pnpm run test:unit -- --run && pnpm run check && pnpm run lint && pnpm run check:contracts && pnpm run gen:api -- --check && pnpm run build'
```

For each backend service, use `node:22-bookworm`, an anonymous service `node_modules` volume, `npm ci`, the complete unit suite, and build/typecheck scripts defined in that service package.

- [ ] **Step 2: Run immutable publication/release gates**

Run backend contract-artifact tests/verifiers and deployment-workflow tests/verifier. Run the frontend contract-publication tests and deployment-workflow `node:test` suite. Record Linux real-`flock` results separately; a skip is not a pass.

- [ ] **Step 3: Record production audits without upgrading**

Run `npm audit --omit=dev --json` for user, chat, and notification services and `pnpm audit --prod --json` for frontend. Record package/advisory/severity/count and exit status. Current baseline includes high findings in user/chat/frontend and a critical transitive `websocket-driver` finding in notification-service; any critical/high finding makes the foundation ineligible for release and becomes input to the dependency-hardening plan.

- [ ] **Step 4: Prove Git integrity**

Run `git diff --check`, inspect every Task 6 commit file list, and prove both isolated worktrees have no unstaged application changes. Do not stage anything from the default checkouts.

---

### Task 4: Rebuild and smoke-test the local Colima topology

**Files:** No tracked source changes expected.

**Interfaces:**

- Consumes: the committed Dockerfiles/Compose topology and local-only test secrets.
- Produces: image IDs, bounded health results, public gateway probes, and container ownership evidence without production access.

- [ ] **Step 1: Confirm local-only context**

Run `colima status`, `docker context show`, and `docker info`. Abort if the active context is remote or points at the VPS. Record the context name in the report.

- [ ] **Step 2: Build the four application images**

Build user, chat, notification, and frontend images from the paired worktrees with local Task 6 tags. Record immutable local image IDs. Do not push.

- [ ] **Step 3: Start a bounded local topology**

Use only local test credentials. Start PostgreSQL/RabbitMQ/Redis and the four application containers on loopback. Do not mount production volumes or secrets. Wait on health conditions rather than fixed sleeps.

- [ ] **Step 4: Probe and tear down safely**

Probe service health and representative user/chat routes through the local gateway. Record status/body. Stop the Task 6 Compose project without deleting unrelated volumes or images.

---

### Task 5: Record the implementor handoff

**Files:**

- Create: `.superpowers/sdd/2026-08-30-api-contract-release-blockers/task-6-report.md` (ignored)

- [ ] Record every RED/GREEN command, exact counts, commits, runtime versions, audits, image IDs, skipped/blocked gates, and dirty-state proof.
- [ ] State `DONE_WITH_CONCERNS` if tests pass but any critical/high production advisory remains.
- [ ] State `BLOCKED` if Node 22, snapshot provenance, or required local topology verification cannot be completed.
- [ ] Stop before adversarial review, merge, push, deployment, VPS access, Firebase access, or dependency upgrades.

Return to the architect only: status, commit hashes, one-line verification summary, and concerns.

## Architect follow-up (not for the implementor)

After Muse stops, the architect will independently inspect the commits, rerun proportional gates, dispatch correctness/failure/structure critics, consolidate one correction wave, and issue the Task 6 release verdict. Critical/high advisories then move into a separate dependency-hardening plan before idempotency/outbox work or final default-branch integration.
