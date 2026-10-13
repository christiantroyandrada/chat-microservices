# Task 6 Runtime Contract Finalization Implementation Plan

This historical plan records requirements from 2026-09-03. It does not authorize task execution during documentation conversion.
The checkboxes record the original plan state. Expected results are targets, not observed results or release approval.

**Historical worker requirement:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each task.
Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reliable evidence across both repositories for the existing Task 6 runtime contract commits under Node 22/pnpm 9.11.0.
Then give a release verdict without a merge, push, or production change.

**Architecture:** Keep the existing controller-level conformance tests for each service.
Correct the test oracle and pagination control so unrelated validation cannot produce false positives.
The test oracle determines whether a test result is correct.

Publish the changed backend OpenAPI files to the frontend through the accepted transactional snapshot tool.
Do checks of both repositories in isolated Node 22 containers.
Do a check of the application in a local Colima topology.

**Tech Stack:** Node.js 22, npm, pnpm 9.11.0, Jest/ts-jest, Vitest, SvelteKit/TypeScript, OpenAPI 3, Docker Compose, Colima.

**Spec:** `docs/superpowers/specs/2026-08-28-chat-reliability-architecture-design.md`

<a id="current-checkpoint"></a>
## Historical checkpoint

- Backend worktree: `/private/tmp/chat-app-api-contract.pbzyiq/backend`
- Frontend worktree: `/private/tmp/chat-app-api-contract.pbzyiq/frontend`
- Backend Task 6 commit: `c4219c30d20c30f9059cfd3f5c74755efece447a` (`test(api): prove runtime contract conformance`)
- Frontend Task 6 commit: `d4edadadbaeff924e49fa1c0d8ea76d63e306f46` (`test(api): verify generated response contracts`)
- Backend focused verification recorded these results: user-service 46 tests passed. Chat runtime/OpenAPI 17 tests passed.
- Frontend focused verification recorded this result: 27 tests passed.
- Existing frontend `check:contracts` passes only against stale local copies. This result does not prove cross-repository consistency.
  Frontend `contracts/source.json` still identifies backend `cc47bef`. Backend OpenAPI changed at `c4219c3`.
- The previous implementor did not create `task-6-report.md`. The supported-runtime, audit, and Colima gates remained incomplete.

## Global Constraints

- Work only in the two isolated worktrees above. The default checkouts contain user work. Do not change them.
- Do not rewrite, amend, or squash the two checkpoint commits. Add bounded correction commits.
- Use red-green test-driven development (TDD) for every behavior or test-oracle correction.
  Record the exact command, failure, and success.
- Never merge, push, deploy, contact or mutate the VPS, use Firebase, delete a volume, or modify any path containing the literal suffix ` 2`.
- Do not change dependencies while finalizing Task 6. Audits are evidence for the next dependency-hardening plan.
- Backend OpenAPI JSON, frontend contract copies, generated files, source provenance, and the snapshot manifest must remain deterministic committed artifacts.
- Do not claim a Linux/Node 22/Colima check unless that exact command ran successfully.
- Keep comments only when they explain a non-obvious invariant or constraint.
  Remove comments that describe adjacent code.
- Prefer precise `unknown` crossings over new `any` declarations. Do not loosen lint configuration or add disable comments.

---

### Task 1: Repair the runtime-contract test oracle

**Files:**

- Modify: `chat-service/tests/unit/runtime-contract.test.ts`
- Modify only if the same oracle defect exists there: `user-service/tests/unit/runtime-contract.test.ts`

**Interfaces:**

- Consumes: `fetchConversationValidation`, `validateRequest`, `MessageController.fetchConversation`, and OpenAPI `format`, `required`, `enum`, object, array, string, integer, number, and nullable schema fields.
- Produces: Pagination tests must fail for the pagination field under test.
  The schema oracle must reject malformed UUID and date-time fixtures.

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

Expected RED: The row labelled `zero limit` actually passes `offset: 0`.
If the receiver UUID is valid, validation continues without the unrelated receiver-ID error. The row then does not return 400.

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

Add a valid control for `{ limit: '200', offset: '0' }`.
Prove that it calls `next` and does not emit a 400 response.
If the harness invokes the controller, confirm that a repository remains untouched.

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

Use valid v4 UUIDs in every message fixture.
Add one small adversarial self-test that proves the oracle rejects an invalid UUID fixture.
Before format handling, record RED.
After format handling, record GREEN.

- [ ] **Step 4: Apply comment/type hygiene**

Remove opening comments that only say the file contains runtime contract tests.
Keep at most one comment about the need for the JSON round-trip during Express `res.json`/Date serialization.
Replace new `any` values with narrow local shapes or `unknown`.
With `unknown`, add an explicit cast at the controller/Jest boundary.
Do not change production controller code.

- [ ] **Step 5: Verify and commit**

Run both focused runtime/OpenAPI suites and `git diff --check`.
Commit only the owned correction files:

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
- Produces: One coherent frontend snapshot identifies `c4219c3` as its source. Its hashes must match the copied bytes.

- [ ] **Step 1: Capture stale-snapshot RED**

Record the SHA-256 hashes of backend `user-service/openapi.json` and `chat-service/openapi.json` and their frontend copies.
Assert that they differ.
Record that `contracts/source.json` names backend `cc47bef`, not `c4219c3`.

- [ ] **Step 2: Run the transactional producer**

From the frontend worktree, run:

```bash
pnpm run sync:contracts
pnpm run gen:api
```

Do not copy or edit JSON by hand.
The publisher must update the source/manifest last under its existing lock/atomicity rules.

- [ ] **Step 3: Prove coherent GREEN state**

Run:

```bash
pnpm run check:contracts
pnpm run gen:api -- --check
```

Compare the backend and frontend OpenAPI hashes again. Each pair must match.
Make sure that `contracts/source.json` and `contract-snapshot.manifest.json` identify backend `c4219c30d20c30f9059cfd3f5c74755efece447a`.
Run the focused frontend API tests and `git diff --check`.

- [ ] **Step 4: Commit the snapshot correction**

Stage only files changed by the producer.
Before the commit, inspect the exact list:

```bash
git commit -m "chore(api): synchronize runtime contract snapshot"
```

---

### Task 3: Run the supported-toolchain and security gates

**Files:**

- Create or update ignored evidence only: `backend/.superpowers/sdd/2026-08-30-api-contract-release-blockers/task-6-report.md`

**Interfaces:**

- Consumes: committed Task 6 backend/frontend ranges.
- Produces: Exact Node 22/pnpm 9.11.0 test, build, and audit evidence without source changes.

- [ ] **Step 1: Use isolated Node 22 containers**

Do not install Linux dependencies in the macOS worktrees. Mount anonymous `node_modules` volumes. The frontend example follows:

```bash
docker run --rm \
  -v /private/tmp/chat-app-api-contract.pbzyiq/frontend:/workspace \
  -v /workspace/node_modules \
  -w /workspace node:22-bookworm \
  sh -lc 'corepack enable && corepack prepare pnpm@9.11.0 --activate && pnpm install --frozen-lockfile && pnpm run test:unit -- --run && pnpm run check && pnpm run lint && pnpm run check:contracts && pnpm run gen:api -- --check && pnpm run build'
```

For each backend service, use `node:22-bookworm` and an anonymous `node_modules` volume for the service.
Run `npm ci` and the complete unit suite.
Run the build/typecheck scripts defined in that service package.

- [ ] **Step 2: Run immutable publication/release gates**

Run backend contract-artifact tests/verifiers and deployment-workflow tests/verifier.
Run the frontend contract-publication tests and deployment-workflow `node:test` suite.
Record the results from real Linux `flock` separately. A skipped check is not a pass.

- [ ] **Step 3: Record production audits without upgrading**

Run `npm audit --omit=dev --json` for user, chat, and notification services.
Run `pnpm audit --prod --json` for frontend.
Record package/advisory/severity/count and exit status.

The historical baseline includes high findings in the user service, chat service, and frontend.
It also includes a critical transitive `websocket-driver` finding in the notification service.
Any critical/high finding makes the foundation ineligible for release.
These findings become input to the dependency-hardening plan.

- [ ] **Step 4: Prove Git integrity**

Run `git diff --check`.
Inspect every Task 6 commit file list.
Prove that both isolated worktrees have no unstaged application changes.
Do not stage anything from the default checkouts.

---

### Task 4: Rebuild and smoke-test the local Colima topology

**Files:** No tracked source changes expected.

**Interfaces:**

- Consumes: the committed Dockerfiles/Compose topology and local-only test secrets.
- Produces: Image IDs, bounded health results, public gateway probe results, and container ownership evidence without production access.

- [ ] **Step 1: Confirm local-only context**

Run `colima status`, `docker context show`, and `docker info`.
If the active context is remote or points to the VPS, stop.
Record the context name in the report.

- [ ] **Step 2: Build the four application images**

Build user, chat, notification, and frontend images from the paired worktrees with local Task 6 tags.
Record immutable local image IDs.
Do not push.

- [ ] **Step 3: Start a bounded local topology**

Use only local test credentials.
Start PostgreSQL, RabbitMQ, Redis, and the four application containers on loopback.
Do not mount production volumes or secrets.
Wait for health conditions instead of fixed delays.

- [ ] **Step 4: Probe and tear down safely**

Probe service health and representative user/chat routes through the local gateway.
Record status/body.
Stop the Task 6 Compose project. Do not delete unrelated volumes or images.

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

After Muse stops, the architect independently inspects the commits and reruns proportional gates.
The architect dispatches critics for correctness, failure modes, and structure. The architect then consolidates one correction cycle.
The architect then issues the Task 6 release verdict.
Critical/high advisories move into a separate dependency-hardening plan before idempotency/outbox work or final default-branch integration.
