# API Contract Release Blockers Implementation Plan

This historical plan records requirements from 2026-08-30. It does not authorize task execution during documentation conversion.
The checkboxes record the original plan state. Expected results are targets, not observed results or release approval.

**Historical worker requirement:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each task.
Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the remaining defects in the API contract foundation.
Type checks must pass in both repositories. The system must detect changes to contract artifacts.
Deployments must use immutable releases. Each repository must control only its services.

**Architecture:** OpenAPI remains the source for the transport contract.
Generate an operation manifest with the component types.
Endpoint adapters must use the manifest.

Treat contract publication as a transaction.
First, validate the content and prepare a complete snapshot.
Then rename the outputs atomically. Publish the hash manifest last.

Use one lock on the host to protect the shared VPS release target.
Each repository must update only its services.

**Tech Stack:** Node.js 22, pnpm 9.11.0, SvelteKit/TypeScript/Vitest, Express/Jest/TypeORM/PostgreSQL, OpenAPI 3, GitHub Actions, Docker Compose/Colima.

**Spec:** `docs/superpowers/specs/2026-08-28-chat-reliability-architecture-design.md`

## Global Constraints

- Use only the paired isolated worktrees.
  Keep all unrelated changed and untracked files byte-for-byte and unstaged.
- Use test-driven development.
  Before implementation, confirm that each focused test fails for the intended reason.
  After implementation, run the test and record a passing result.
- Do not merge, push, deploy, mutate the VPS, delete volumes, or remove the pre-existing ` 2` duplicate files in this plan.
- OpenAPI JSON, frontend copies, generated component types, and generated operation metadata must remain deterministic committed artifacts.
- Unsupported or malformed contract input fails before any committed artifact is overwritten.
- Frontend and backend deployments must share one host lock. Each deployment must update only its repository's services.
- Dependency upgrades, durable messaging idempotency/outbox, RabbitMQ reliability, transactional prekey consumption, and broader architecture refactors remain separate plans.

---

### Task 1: Repair the final-fix regressions

**Files:**
- Modify: `frontend/src/lib/services/api.ts`
- Modify: `frontend/src/lib/types/index.ts`
- Modify: `frontend/src/lib/services/chat.service.ts`
- Modify: `frontend/src/lib/services/__tests__/api.test.ts`
- Modify: `frontend/src/lib/services/__tests__/chat.service.test.ts`
- Modify: `backend/chat-service/src/openapi.ts`
- Modify: `backend/chat-service/openapi.json`
- Modify: `backend/chat-service/src/controllers/MessageController.ts`
- Modify: `backend/chat-service/src/middleware/validation/messageValidation.ts`
- Modify: `backend/chat-service/tests/unit/openapi.contract.test.ts`
- Modify: `backend/chat-service/tests/unit/messageController.test.ts`
- Modify: `frontend/contracts/chat-service.openapi.json`
- Modify: `frontend/src/lib/generated/api.types.ts`

**Interfaces:**
- Consumes: `ApiClient.getRaw<T>()`, backend `MessageStatus`, `Conversation` OpenAPI schema.
- Produces: The raw response API passes strict type checks.
  `ServerMessage.status: 'NotDelivered' | 'Delivered' | 'Seen'` defines message status.
  Unread counts are numeric. Pagination has limits. Generated artifacts are synchronized.

- [ ] **Step 1: Add failing regression tests**

  Add tests for these requirements:
  - `getRaw<string>()` cannot return `undefined`.
  - All three message statuses normalize correctly.
  - `offset` rejects non-finite/unsafe values.
  - The exported conversation schema requires `id`, `name`, `avatar`, `lastMessage`, `unreadCount`, and `lastMessageTime`.

- [ ] **Step 2: Run focused red checks**

  Run the frontend API and chat tests and the strict TypeScript checks.
  Run the backend chat validation, controller, and contract tests.
  Expected: The tests fail for the `api.ts` return, missing `ServerMessage.status`, unsafe pagination, or stale artifacts.

- [ ] **Step 3: Implement the minimal corrections**

  Make the raw success branch return a defined `T` or throw a contract boundary error.
  Declare the wire status on `ServerMessage`.
  Use one finite safe-integer pagination parser for validation and the controller.
  Retain SQL `COUNT(*)::int`.

  Regenerate the backend JSON.
  Synchronize the frontend contracts.
  Regenerate the frontend types.

- [ ] **Step 4: Run focused and drift checks**

  Run the focused tests and `tsc --noEmit`.
  Generate the backend specifications and do checks of the tracked artifacts.
  Run frontend `check:contracts`.
  Expected: All checks pass. Regeneration produces no diff.

- [ ] **Step 5: Commit separately by repository**

  Commit backend as `fix(chat): repair contract regression artifacts` and frontend as `fix(api): restore strict contract type safety`.

### Task 2: Make response modes and domain boundaries explicit

**Files:**
- Modify: `frontend/src/lib/services/api.ts`
- Modify: `frontend/src/lib/services/api.generated.ts`
- Modify: `frontend/src/lib/services/auth.service.ts`
- Modify: `frontend/src/lib/services/chat.service.ts`
- Modify: `frontend/src/lib/services/__tests__/api.test.ts`
- Modify: `frontend/src/lib/services/__tests__/api.generated.test.ts`
- Modify: `frontend/src/lib/services/__tests__/auth.service.test.ts`
- Modify: `frontend/src/lib/services/__tests__/chat.service.test.ts`

**Interfaces:**
- Consumes: `ResponseMode = 'envelope' | 'raw'` and generated user/chat wire types.
- Produces: endpoint adapters that always choose a response mode and boundary validators that reject missing required data/identities.

- [ ] **Step 1: Add a failing backend-to-client response matrix**

  Cover these response cases:
  - Successful envelopes and status/message-only success.
  - Raw JSON and raw text.
  - Inherited envelope-like keys.
  - Malformed successful JSON and malformed failed JSON.
  - Missing `data` and missing user/conversation identifiers.
  If a fixture is valid, declare it with `satisfies` and the generated wire types.

- [ ] **Step 2: Run the matrix red**

  Expected: The generated helpers omit explicit modes, and the auth and chat normalizers still construct empty domain entities.

- [ ] **Step 3: Add explicit request metadata and boundary validators**

  Require every generated or typed endpoint call to pass its declared response mode.
  Successful envelope endpoints must reject malformed JSON and missing required payloads.
  Raw endpoints must preserve successful JSON and text.
  Replace `Partial<T>` and empty-string repair with narrow assertion functions.
  These functions must throw `ContractBoundaryError` with the endpoint name and missing field.

- [ ] **Step 4: Run focused tests and strict checks**

  Run the response matrix and domain service suites.
  Run the ESLint, TypeScript, and Svelte checks. Expected: All pass.

- [ ] **Step 5: Commit**

  Commit frontend as `refactor(api): enforce explicit response contracts`.

### Task 3: Generate and validate operation metadata

**Files:**
- Modify: `backend/user-service/src/openapi.ts`
- Modify: `backend/chat-service/src/openapi.ts`
- Modify: `backend/user-service/openapi.json`
- Modify: `backend/chat-service/openapi.json`
- Modify: `backend/user-service/tests/unit/openapi.contract.test.ts`
- Modify: `backend/chat-service/tests/unit/openapi.contract.test.ts`
- Modify: `frontend/scripts/lib/openapi-to-types.mjs`
- Modify: `frontend/scripts/gen-api-types.mjs`
- Modify: `frontend/scripts/__tests__/gen-api-types.test.mjs`
- Create: `frontend/src/lib/generated/api.operations.ts`
- Modify: `frontend/src/lib/services/api.generated.ts`
- Modify: `frontend/src/lib/services/__tests__/api.generated.test.ts`

**Interfaces:**
- Consumes: stable unique OpenAPI `operationId` values and local component `$ref` targets.
- Produces: `apiOperations` metadata keyed by operation ID. Each entry has a method, path, request and parameter refs, response ref, and response mode.
  Endpoint helpers must use this metadata instead of repeated transport strings.

- [ ] **Step 1: Add adversarial generator tests**

  Add failing cases for these inputs:
  - Duplicate/missing operation IDs and unresolved local refs.
  - Non-array or unknown `required` members.
  - `oneOf`/`allOf`/`anyOf` and unknown schema types.
  - Unsupported remote refs and component names that start with a digit.
  Assert that failure occurs before output files change.

- [ ] **Step 2: Add failing helper-drift tests**

  Prove a changed OpenAPI verb/path/request/response/response-mode changes `api.operations.ts` and makes `check:contracts` fail until regenerated.

- [ ] **Step 3: Implement fail-closed validation and operation generation**

  Before rendering, validate the OpenAPI version, service identity, components, paths, operations, refs, schema keywords, and required arrays.
  Prefix unsafe TypeScript identifiers deterministically.
  Generate readonly operation metadata.
  Refactor adapters to use method/path/mode from the metadata.

- [ ] **Step 4: Add stable operation IDs and regenerate all artifacts**

  Assign descriptive IDs such as `user.login`, `user.publishPrekey`, `chat.listMessages`, and `chat.listConversations`.
  Update backend tests, JSON, frontend copies, component types, and operation metadata.

- [ ] **Step 5: Run generator, helper, type, and drift suites**

  Expected: Adversarial inputs fail without writes. Valid regeneration is deterministic and has no changes.

- [ ] **Step 6: Commit separately by repository**

  Commit backend as `feat(api): publish stable operation contracts` and frontend as `feat(api): generate operation metadata`.

### Task 4: Publish contract artifacts transactionally

**Files:**
- Create: `frontend/scripts/lib/atomic-contract-files.mjs`
- Modify: `frontend/scripts/sync-api-contracts.mjs`
- Modify: `frontend/scripts/gen-api-types.mjs`
- Modify: `frontend/scripts/__tests__/sync-api-contracts.test.mjs`
- Modify: `frontend/scripts/__tests__/gen-api-types.test.mjs`
- Create: `backend/scripts/verify-contract-artifacts.mjs`
- Modify: `backend/user-service/scripts/export-spec.ts`
- Modify: `backend/chat-service/scripts/export-spec.ts`
- Modify: `backend/user-service/tests/unit/openapi.contract.test.ts`
- Modify: `backend/chat-service/tests/unit/openapi.contract.test.ts`
- Modify: `backend/.github/workflows/ci-main.yml`
- Modify: `backend/.github/workflows/ci-feature.yml`

**Interfaces:**
- Consumes: fully validated rendered strings and exact backend Git blobs or clean tracked files.
- Produces: one lock across processes, temporary files in the same directory, content hashes, and atomic renames.
  The publisher writes the manifest last and cleans up after failure. CI verifies that tracked artifacts exist and remain tracked.

- [ ] **Step 1: Add failure-injection tests**

  Simulate these failures:
  - Validation failure and lock contention.
  - A write failure before rename.
  - A failure between artifact staging and manifest publication.
  Assert that the prior complete snapshot remains byte-identical.
  Assert that no partial manifest is published.
  Assert that only their owner removes temporary files/locks.

- [ ] **Step 2: Add provenance and deleted-artifact CI tests**

  Prove that dirty working-tree contracts are rejected or exact `git show HEAD:path` blobs are used.
  Prove that manifest hashes match bytes.
  Prove that regeneration into an untracked file cannot hide deletion of a tracked OpenAPI JSON file.

- [ ] **Step 3: Implement the atomic publisher**

  Acquire a lock with exclusive creation.
  Render/validate all content in memory.
  Write/fsync temporary files in the same directory.
  Rename artifacts.
  Rename the hash/provenance manifest last.
  Never overwrite the prior snapshot before all staging succeeds.

- [ ] **Step 4: Wire backend exporters and CI**

  Make exporters use atomic replacement.
  Add `git ls-files --error-unmatch`, existence checks, generator execution, `git status --porcelain --untracked-files=all -- <artifacts>`, and hash verification.
  Only if both callers keep identical permissions/toolchain inputs, extract a reusable workflow.

- [ ] **Step 5: Run failure tests and both repository drift gates**

  Expected: all injected failures preserve the previous snapshot and valid generation is a no-op on Git state.

- [ ] **Step 6: Commit separately by repository**

  Commit backend as `ci(api): verify transactional contract artifacts` and frontend as `build(api): publish contract snapshots atomically`.

### Task 5: Coordinate immutable VPS releases

**Files:**
- Modify: `frontend/.github/workflows/ci-main.yml`
- Create: `frontend/scripts/__tests__/deployment-workflow.test.mjs`
- Modify: `backend/.github/workflows/deploy.yml`
- Create: `backend/scripts/verify-deployment-workflow.mjs`
- Create: `backend/tests/deployment-workflow.test.mjs`
- Modify: `backend/docker-compose.yml` if service-specific image variables are not already supported.

**Interfaces:**
- Consumes: immutable `ghcr.io/<owner>/chat-frontend:<git-sha>` and backend service SHA tags. The VPS path is `/opt/chat-app`.
- Produces: one host lock path shared by both repositories and separate service lists for each repository.
  An atomic release-state file records current and previous immutable image references for rollback.

- [ ] **Step 1: Add static failing workflow tests**

  Parse the workflow YAML and embedded deploy scripts.
  Assert these requirements:
  - No production deployment uses `latest`.
  - Backend commands cannot pull/create/restart `frontend`.
  - Frontend commands cannot alter backend services.
  - Both acquire the same `flock` target.
  - Before service replacement, release state records current/previous immutable refs.

- [ ] **Step 2: Publish immutable frontend identity**

  Build/push the commit-SHA tag.
  Resolve its digest.
  Record the digest.
  Pass that immutable reference to deployment.
  A convenience `latest` tag may exist for people. It must never be a deployment input or rollback source.

- [ ] **Step 3: Add shared locking, ownership, and rollback state**

  Before you read or write Compose or release state, acquire one lock on the host.
  Backend deploys only `user`, `chat`, `notification`, migrations, and owned dependencies explicitly approved by the workflow.
  Frontend deploys only `frontend`.
  Write the new release-state file through a temporary file and a rename.
  Before health checks, retain the previous immutable refs.

- [ ] **Step 4: Exercise deployment scripts locally without a VPS mutation**

  Run YAML parsing/static tests.
  Run a fake `docker compose`/filesystem harness.
  Prove service ownership and lock contention.
  Prove a successful state transition and rollback to the exact previous immutable reference.

- [ ] **Step 5: Commit separately by repository**

  Commit backend as `fix(deploy): serialize owned immutable releases` and frontend as `fix(deploy): release immutable frontend images`.

### Task 6: Prove runtime contract conformance and verify the foundation

This historical recovery checkpoint records the state on 2026-09-03:

> **Recovery checkpoint (2026-09-03):** Backend `c4219c3` and frontend `d4edada`
> contain the first runtime-contract test slice. They are not yet accepted: the
> pagination harness has an unrelated receiver-ID false-positive, the frontend
> snapshot still identifies backend `cc47bef`, the required report is absent,
> and Node 22/pnpm 9.11.0, audit, and Colima gates remain. Execute
> `docs/superpowers/plans/2026-09-03-task-6-runtime-contract-finalization.md`
> before continuing with the steps below.

**Files:**
- Modify: `backend/user-service/tests/unit/openapi.contract.test.ts`
- Modify: `backend/chat-service/tests/unit/openapi.contract.test.ts`
- Create: `backend/user-service/tests/unit/runtime-contract.test.ts`
- Create: `backend/chat-service/tests/unit/runtime-contract.test.ts`
- Modify: `frontend/src/lib/services/__tests__/api.generated.test.ts`
- Modify: `frontend/src/lib/services/__tests__/api.test.ts`
- Create: `backend/.superpowers/sdd/2026-08-30-api-contract-release-blockers/task-6-report.md`

**Interfaces:**
- Consumes: exported OpenAPI schemas, representative controller responses, generated operation metadata, explicit response modes, and immutable deployment workflow tests.
- Produces: evidence that representative runtime responses conform to status and body schemas.
  The complete foundation must pass in the supported toolchain.

- [ ] **Step 1: Add representative runtime conformance tests**

  Exercise the signal-backup 404 response and successful prekey publication.
  Exercise conversations with numeric unread counts, bounded pagination failures, status and message-only responses, and message status values.
  Use a focused existing validator or a small test-only resolver.
  Validate HTTP status and response bodies against the exported operation/schema contract.

- [ ] **Step 2: Run backend and frontend full verification**

  Run all backend unit suites and TypeScript checks.
  Regenerate contracts.
  Verify contracts.
  Under Node 22/pnpm 9.11.0, run the full frontend Vitest suite.
  Run strict TypeScript and Svelte checks, lint, `check:contracts`, and the production build.

- [ ] **Step 3: Run security and Git integrity checks**

  Run production audits.
  Record exact remaining advisories without expansion of this plan.
  Run `git diff --check` and committed-range checks.
  Prove that only preserved unrelated files remain unstaged.

- [ ] **Step 4: Rebuild and smoke-test with Colima**

  Rebuild all four immutable images.
  Serve the frontend on loopback.
  Run bounded backend startup/environment validation.
  Run any available safe local integration topology without production secrets or remote changes.

- [ ] **Step 5: Dispatch three adversarial critics and one scoped correction review**

  Review correctness, failure modes, and structure independently against this plan and the complete paired diff.
  Consolidate findings into one correction cycle.
  Then do one scoped review of the corrections.

- [ ] **Step 6: Record the release verdict**

  Update the SDD ledger/report with commands, outputs, immutable image IDs, audit counts, and limitations.
  State whether the foundation is eligible to proceed to the dependency/idempotency phases.
  Do not merge or push in this task.
