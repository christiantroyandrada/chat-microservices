import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const yaml = createRequire(path.join(repo, 'user-service', 'package.json'))('js-yaml');

function workflow(name) {
	return yaml.load(readFileSync(path.join(repo, '.github', 'workflows', name), 'utf8'));
}

function step(job, name) {
	const found = job.steps.find((candidate) => candidate.name === name);
	assert.ok(found, `missing ${name} step`);
	return found;
}

test('production npm and Trivy scans fail closed while keeping evidence uploads', () => {
	const securityAudit = workflow('security-audit.yml');
	const npmAudit = step(securityAudit.jobs['npm-audit'], 'Run npm audit');
	const trivyScan = step(
		securityAudit.jobs['trivy-scan'],
		'Run Trivy vulnerability scanner (SARIF)'
	);

	assert.equal(npmAudit.run, 'npm audit --omit=dev --audit-level=low');
	assert.equal(npmAudit['continue-on-error'], undefined);
	assert.equal(trivyScan.with['exit-code'], '1');
	assert.equal(trivyScan.with.severity, 'CRITICAL,HIGH');
	assert.equal(trivyScan['continue-on-error'], undefined);
	for (const name of ['Upload audit report', 'Upload Trivy report']) {
		assert.equal(step(
			name.includes('audit')
				? securityAudit.jobs['npm-audit']
				: securityAudit.jobs['trivy-scan'],
			name
		).if, 'always()');
	}
});

test('image publication waits for integration tests and the security audit', () => {
	const ci = workflow('ci-main.yml');
	const dependencies = ci.jobs['docker-build'].needs;

	assert.ok(Array.isArray(dependencies));
	assert.ok(dependencies.includes('integration-tests'));
	assert.ok(dependencies.includes('security-audit'));
});
