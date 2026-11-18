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
	assert.deepEqual(compose.services.nginx.healthcheck.test, ['CMD-SHELL', "if command -v nc >/dev/null 2>&1; then nc -z -w 2 127.0.0.1 8080; else timeout 2 bash -c '</dev/tcp/127.0.0.1/8080'; fi"]);
});

test('image publication waits for integration tests and the security audit', () => {
	const ci = workflow('ci-main.yml');
	const dependencies = ci.jobs['docker-build'].needs;

	assert.ok(Array.isArray(dependencies));
	assert.ok(dependencies.includes('integration-tests'));
	assert.ok(dependencies.includes('security-audit'));
	assert.ok(dependencies.includes('relay-tests'));
	const relayTests = ci.jobs['relay-tests'];
	assert.match(step(relayTests, 'Use Go 1.27.4').uses, /^actions\/setup-go@[a-f0-9]{40}$/);
	assert.equal(step(relayTests, 'Verify Go relay')['working-directory'], 'websocket-service');
	assert.match(step(relayTests, 'Verify Go relay').run, /go test -race \.\/\.\.\./);
	assert.match(step(relayTests, 'Verify Go relay').run, /go vet \.\/\.\.\./);
});

test('every published backend image is built once and scanned before any registry push', () => {
	const job = workflow('ci-main.yml').jobs['docker-build'];
	const publications = [];
	const scans = [];
	for (const [service, variable, id, label = service, tag = `chat-${service}:scan`, condition] of [
		['user-service', 'IMAGE_USER', 'build-user'],
		['chat-service', 'IMAGE_CHAT', 'build-chat'],
		['notification-service', 'IMAGE_NOTIFICATION', 'build-notification'],
		['nginx', 'IMAGE_NGINX', 'build-nginx'],
		['websocket-service', 'IMAGE_RELAY', 'publish-relay', 'Go relay', 'chat-websocket:scan', "vars.GO_WS_PILOT == 'true'"]
	]) {
		const build = step(job, `Build ${label} for security scan`);
		assert.match(build.uses, /^docker\/build-push-action@[a-f0-9]{40}$/);
		assert.equal(build.with.context, `./${service}`);
		assert.equal(build.with.push, false);
		assert.equal(build.with.load, true);
		assert.equal(build.with.tags, tag);
		assert.equal(build.if, condition);
		const scan = step(job, `Scan ${label} release image`);
		assert.match(scan.uses, /^aquasecurity\/trivy-action@[a-f0-9]{40}$/);
		assert.equal(scan.with['image-ref'], tag);
		assert.equal(scan.with['exit-code'], '1');
		assert.equal(scan.with.severity, 'CRITICAL,HIGH');
		assert.equal(scan['continue-on-error'], undefined);
		assert.equal(scan.if, condition);
		assert.ok(job.steps.indexOf(build) < job.steps.indexOf(scan));
		scans.push(job.steps.indexOf(scan));
		const publish = step(job, `Publish ${label}`);
		assert.equal(publish.id, id);
		assert.equal(publish.uses, undefined);
		assert.equal(publish.if, condition);
		assert.doesNotMatch(publish.run, /docker (?:build|buildx)|\|\| true/);
		assert.equal(publish.env.SCAN_IMAGE, tag);
		assert.equal(publish.env.RELEASE_IMAGE, '${{ env.' + variable + ' }}');
		assert.ok(publish.run.includes('docker tag "$SCAN_IMAGE" "$RELEASE_IMAGE:$GITHUB_SHA"'));
		assert.ok(publish.run.includes('docker push "$RELEASE_IMAGE:$GITHUB_SHA"'));
		assert.doesNotMatch(publish.run, /RepoDigests|docker image inspect/);
		assert.ok(publish.run.includes('awk -v tag="$GITHUB_SHA:"'));
		assert.ok(publish.run.includes('<<< "$push_output"'));
		assert.ok(publish.run.includes('^sha256:[a-f0-9]{64}$'));
		assert.ok(publish.run.includes('echo "digest=$digest" >> "$GITHUB_OUTPUT"'));
		publications.push(job.steps.indexOf(publish));
	}
	assert.ok(Math.max(...scans) < Math.min(...publications));
	const builds = job.steps.filter(candidate => candidate.uses?.startsWith('docker/build-push-action@'));
	assert.equal(builds.length, publications.length);
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
