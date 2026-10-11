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

test('nginx compatibility is checked after building and before its security scan', () => {
	const job = workflow('security-audit.yml').jobs['trivy-scan'];
	const check = step(job, 'Check nginx runtime compatibility');
	assert.equal(check.if, "matrix.service == 'nginx'");
	assert.equal(check.env.NGINX_TEST_IMAGE, 'nginx:test');
	assert.equal(check.run, 'node --test tests/nginx-image.check.mjs tests/image-digest-updater.check.mjs');
	assert.ok(job.steps.indexOf(check) > job.steps.indexOf(step(job, 'Build Docker image')));
	assert.ok(job.steps.indexOf(check) < job.steps.indexOf(step(job, 'Run Trivy vulnerability scanner (SARIF)')));
});

test('nginx uses the TCP healthcheck verified against its slim image', () => {
	const compose = yaml.load(readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8'));
	assert.deepEqual(compose.services.nginx.healthcheck.test, ['CMD', 'nc', '-z', '-w', '2', '127.0.0.1', '8080']);
});

test('image publication waits for integration tests and the security audit', () => {
	const ci = workflow('ci-main.yml');
	const dependencies = ci.jobs['docker-build'].needs;

	assert.ok(Array.isArray(dependencies));
	assert.ok(dependencies.includes('integration-tests'));
	assert.ok(dependencies.includes('security-audit'));
});

test('release uses the built-in GitHub token without declaring a reserved caller secret', () => {
	const deploy = workflow('deploy.yml');
	const declared = Object.keys(deploy.on.workflow_call.secrets);
	assert.ok(!declared.some(name => name.toUpperCase() === 'GITHUB_TOKEN'), 'GitHub rejects the reserved GITHUB_TOKEN workflow_call secret');
	assert.equal(deploy.permissions.packages, 'read');
	assert.equal(step(deploy.jobs.deploy, 'Deploy owned backend release').env.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
});

test('coverage artifacts cannot overwrite one another or silently omit a failing suite', () => {
	assert.match(step(workflow('ci-main.yml').jobs['verify-openapi-contracts'], 'Verify committed OpenAPI contracts').run,
		/node --test tests\/coverage-workflow\.test\.mjs tests\/security-workflow\.test\.mjs/);
	const unit = workflow('unit-tests.yml');
	const download = step(unit.jobs['merge-and-upload'], 'Download all LCOV artifacts');
	assert.equal(download.with['merge-multiple'], false);
	assert.equal(step(unit.jobs['unit-tests'], 'Upload LCOV (if present)').with['if-no-files-found'], 'error');
	assert.equal(step(unit.jobs['merge-and-upload'], 'Upload combined LCOV').with['if-no-files-found'], 'error');
	const run = step(unit.jobs['unit-tests'], 'Run tests (coverage optional)').run;
	assert.ok(!run.includes('--if-present'));
	assert.ok(!run.includes('if npm run coverage'), 'failed coverage tests must not fall back to a green unit run');
});

test('Sonar fails closed on missing coverage and waits for the server quality gate', () => {
	const job = workflow('sonar.yml').jobs['build-and-sonar'];
	assert.equal(step(job, 'Checkout').with?.['fetch-depth'], 0);
	assert.equal(step(job, 'Download combined LCOV artifact')['continue-on-error'], undefined);
	const scan = step(job, 'SonarCloud Scan');
	assert.equal(scan['continue-on-error'], undefined);
	assert.ok(scan.with.args.includes('-Dsonar.qualitygate.wait=true'));
	assert.equal(step(job, 'Download combined LCOV artifact').with.path, 'coverage');
	const prepare = step(job, 'Validate coverage file');
	assert.match(prepare.run, /test -s coverage\/combined-lcov\.info/);
});
