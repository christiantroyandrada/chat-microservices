# API Contract Release Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the residual API-contract foundation defects so both repositories typecheck, contract artifacts cannot drift silently, and deployments use immutable, independently owned releases.

**Architecture:** Keep OpenAPI as the transport-contract source, but generate a small operation manifest alongside component types and require endpoint adapters to consume that manifest. Treat contract publication as a transaction: validate first, stage a complete snapshot, atomically rename outputs, and publish the hash manifest last. Treat the VPS as a shared release target protected by one host-side lock while each repository updates only the services it owns.

**Tech Stack:** Node.js 22, pnpm 9.11.0, SvelteKit/TypeScript/Vitest, Express/Jest/TypeORM/PostgreSQL, OpenAPI 3, GitHub Actions, Docker Compose/Colima.

**Spec:** `docs/superpowers/specs/2026-08-28-chat-reliability-architecture-design.md`

## Global Constraints

- Work only in the paired isolated worktrees; preserve all unrelated dirty and untracked files byte-for-byte and unstaged.
- Use test-driven development: observe each focused test fail for the intended reason before implementation, then run it green.
- Do not merge, push, deploy, mutate the VPS, delete volumes, or remove the pre-existing ` 2` duplicate files in this plan.
- OpenAPI JSON, frontend copies, generated component types, and generated operation metadata are committed deterministic artifacts.
- Unsupported or malformed contract input fails before any committed artifact is overwritten.
- Frontend and backend deployments share one host-side lock and update only repository-owned services.
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
- Produces: a strict-typechecking raw response API; `ServerMessage.status: 'NotDelivered' | 'Delivered' | 'Seen'`; numeric unread counts; bounded pagination; synchronized generated artifacts.

- [ ] **Step 1: Add failing regression tests**

  Add tests proving `getRaw<string>()` cannot return `undefined`, all three message statuses normalize correctly, `offset` rejects non-finite/unsafe values, and the exported conversation schema requires `id`, `name`, `avatar`, `lastMessage`, `unreadCount`, and `lastMessageTime`.

- [ ] **Step 2: Run focused red checks**

  Run frontend API/chat tests plus strict TypeScript checking and backend chat validation/controller/contract tests. Expected: failures at the current `api.ts` return, missing `ServerMessage.status`, unsafe pagination, or stale artifact assertions.

- [ ] **Step 3: Implement the minimal corrections**

  Make the raw success branch return a defined `T` or throw a contract-boundary error; declare the wire status on `ServerMessage`; use one finite safe-integer pagination parser shared by validation/controller; retain SQL `COUNT(*)::int`; regenerate backend JSON, sync frontend contracts, and regenerate frontend types.

- [ ] **Step 4: Run focused and drift checks**

  Run the focused tests, `tsc --noEmit`, backend spec generation with tracked-artifact checks, and frontend `check:contracts`. Expected: all pass and regeneration produces no diff.

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

  Cover successful envelopes, status/message-only success, raw JSON, raw text, inherited envelope-like keys, malformed successful JSON, malformed failed JSON, missing `data`, and missing user/conversation identifiers. Use fixtures declared with `satisfies` generated wire types wherever the fixture is valid.

- [ ] **Step 2: Run the matrix red**

  Expected: generated helpers do not pass explicit modes and auth/chat normalizers still construct empty domain entities.

- [ ] **Step 3: Add explicit request metadata and boundary validators**

  Require every generated/typed endpoint call to pass its declared response mode. Successful envelope endpoints must reject malformed JSON or missing required payloads; raw endpoints preserve successful JSON/text. Replace `Partial<T>` plus empty-string repair with narrow assertion functions that throw `ContractBoundaryError` naming the endpoint and missing field.

- [ ] **Step 4: Run focused tests and strict checks**

  Run the response matrix, domain service suites, ESLint/TypeScript/Svelte checks. Expected: all pass.

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
- Produces: `apiOperations` metadata keyed by operation ID with method, path, request/parameter refs, response ref, and response mode; endpoint helpers consume this metadata rather than repeating transport strings.

- [ ] **Step 1: Add adversarial generator tests**

  Add failing cases for duplicate/missing operation IDs, unresolved local refs, non-array or unknown `required` members, `oneOf`/`allOf`/`anyOf`, unknown schema types, unsupported remote refs, and component names beginning with a digit. Assert failure occurs before output files change.

- [ ] **Step 2: Add failing helper-drift tests**

  Prove a changed OpenAPI verb/path/request/response/response-mode changes `api.operations.ts` and makes `check:contracts` fail until regenerated.

- [ ] **Step 3: Implement fail-closed validation and operation generation**

  Validate OpenAPI version, service identity, components, paths, operations, refs, schema keywords, and required arrays before rendering. Prefix unsafe TypeScript identifiers deterministically. Generate readonly operation metadata and refactor adapters to consume method/path/mode from it.

- [ ] **Step 4: Add stable operation IDs and regenerate all artifacts**

  Assign descriptive IDs such as `user.login`, `user.publishPrekey`, `chat.listMessages`, and `chat.listConversations`; update backend tests, JSON, frontend copies, component types, and operation metadata.

- [ ] **Step 5: Run generator, helper, type, and drift suites**

  Expected: adversarial inputs fail without writes; valid regeneration is deterministic and clean.

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
- Produces: one cross-process lock, same-directory temporary files, content hashes, atomic renames, manifest-last publication, cleanup on failure, and CI verification that tracked artifacts exist and remain tracked.

- [ ] **Step 1: Add failure-injection tests**

  Simulate validation failure, lock contention, a write failure before rename, and a failure between artifact staging and manifest publication. Assert the prior complete snapshot remains byte-identical, no partial manifest is published, and temporary files/locks are cleaned only by their owner.

- [ ] **Step 2: Add provenance and deleted-artifact CI tests**

  Prove dirty working-tree contracts are rejected (or exact `git show HEAD:path` blobs are used), manifest hashes match bytes, and deleting a tracked OpenAPI JSON cannot be hidden by regeneration into an untracked file.

- [ ] **Step 3: Implement the atomic publisher**

  Acquire a lock with exclusive creation, render/validate everything in memory, write/fsync same-directory temporary files, rename artifacts, and rename a hash/provenance manifest last. Never overwrite the prior snapshot before all staging succeeds.

- [ ] **Step 4: Wire backend exporters and CI**

  Make exporters use atomic replacement. Add `git ls-files --error-unmatch`, existence checks, generator execution, `git status --porcelain --untracked-files=all -- <artifacts>`, and hash verification. Extract a reusable workflow only if both callers keep identical permissions/toolchain inputs.

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
- Consumes: immutable `ghcr.io/<owner>/chat-frontend:<git-sha>` and backend service SHA tags; VPS path `/opt/chat-app`.
- Produces: one host lock path shared by both repositories, repository-owned service lists, and an atomic release-state file containing current and previous immutable image references for rollback.

- [ ] **Step 1: Add static failing workflow tests**

  Parse the workflow YAML and embedded deploy scripts. Assert no production deployment consumes `latest`; backend commands cannot pull/create/restart `frontend`; frontend commands cannot alter backend services; both acquire the same `flock` target; release state records current/previous immutable refs before service replacement.

- [ ] **Step 2: Publish immutable frontend identity**

  Build/push the commit-SHA tag, resolve and record its digest, and pass that immutable reference to deployment. A convenience `latest` tag may exist for humans but must never be a deployment input or rollback source.

- [ ] **Step 3: Add shared locking, ownership, and rollback state**

  Acquire one host-side lock before reading or writing Compose/release state. Backend deploys only `user`, `chat`, `notification`, migrations, and owned dependencies explicitly approved by the workflow; frontend deploys only `frontend`. Write the new release-state file by temp+rename and retain the previous immutable refs before health checks.

- [ ] **Step 4: Exercise deployment scripts locally without a VPS mutation**

  Run YAML parsing/static tests and a fake `docker compose`/filesystem harness that proves service ownership, lock contention, successful state transition, and rollback to the exact previous immutable reference.

- [ ] **Step 5: Commit separately by repository**

  Commit backend as `fix(deploy): serialize owned immutable releases` and frontend as `fix(deploy): release immutable frontend images`.

### Task 6: Prove runtime contract conformance and verify the foundation

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
- Produces: evidence that representative runtime responses conform to status/body schemas and the complete foundation passes in the supported toolchain.

- [ ] **Step 1: Add representative runtime conformance tests**

  Exercise signal-backup 404, prekey publish success, conversations with numeric unread counts, bounded pagination failures, status/message-only responses, and message status values. Validate HTTP status and response bodies against the exported operation/schema contract using a focused existing validator or a small test-only resolver.

- [ ] **Step 2: Run backend and frontend full verification**

  Run all backend unit suites and TypeScript checks; regenerate and verify contracts; run frontend full Vitest, strict TypeScript/Svelte checks, lint, `check:contracts`, and production build under Node 22/pnpm 9.11.0.

- [ ] **Step 3: Run security and Git integrity checks**

  Run production audits and record exact remaining advisories without broadening this plan; run `git diff --check`, committed-range checks, and prove only preserved unrelated files remain unstaged.

- [ ] **Step 4: Rebuild and smoke-test with Colima**

  Rebuild all four immutable images, serve the frontend on loopback, run bounded backend startup/environment validation, and execute any safe local integration topology available without production secrets or remote mutations.

- [ ] **Step 5: Dispatch three adversarial critics and one scoped correction review**

  Review correctness, failure modes, and structure independently against this plan and the full paired diff. Consolidate findings into one fix wave, then one scoped re-review.

- [ ] **Step 6: Record the release verdict**

  Update the SDD ledger/report with commands, outputs, immutable image IDs, audit counts, limitations, and whether the foundation is eligible to proceed to the dependency/idempotency phases. Do not merge or push in this task.

