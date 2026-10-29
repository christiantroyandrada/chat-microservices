# Project instructions

## Specifications and documentation

Use ASD-STE100 Issue 9 for AI-facing specifications, subagent briefs, and technical reports.
Use Humanize for human-facing guides, README files, release notes, and contributor communication.
If a document serves both audiences, identify each section's audience.
Preserve requirements, identifiers, commands, and evidence in both styles.
Read DOCUMENTATION_STYLE.md before you write.

Use these rules for AI-facing content:

- Use the approved dictionary meanings and project technical terms.
- Write one instruction per sentence, with no more than 20 words.
- Use no more than 25 words in each descriptive sentence.
- Put conditions before their actions.
- Name the actor and use the same term for the same item.
- Keep requirements, identifiers, commands, and recorded evidence exact.
- If full vocabulary review is incomplete, state that limit.
- Do not claim certified compliance from a sentence-length check.

## Verification

- Select checks from user outcomes, API contracts, database effects, and failure risks.
- Prefer accessible roles and labels for browser actions. Use explicit test IDs when a stable testing contract requires them.
- Verify persistence and authorization after actions. A success response or toast alone is insufficient.
- Keep targeted transaction, concurrency, cryptographic, deadline, and rollback regression checks.
- Run affected verification gates under the required runtime before completion. Run the complete release gate before release.
- If a check fails, diagnose the application, fixture, runner, and environment before changing code.
- Do not weaken assertions, suppress failures, or delete tests to reach a test-count ratio.
- Record commands, versions, exit codes, mocked boundaries, and unresolved intermittent failures.
- Review external scanners before adoption. Exposure and header scans do not replace authenticated access-control checks.
