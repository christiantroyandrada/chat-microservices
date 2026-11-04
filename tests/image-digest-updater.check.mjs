import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

for (const scenario of ['valid', 'lookup-fails', 'malformed']) test(`digest refresh preserves tags and fails before mutation: ${scenario}`, () => {
	const directory = mkdtempSync(join(import.meta.dirname, '.digest-check-'));
	const context = process.env.DIGEST_TEST_DOCKER_CONTEXT ?? 'default';
	try {
		const script = join(directory, 'backend/scripts/cron/update-image-digests.sh');
		mkdirSync(join(directory, 'backend/scripts/cron'), { recursive: true });
		copyFileSync(resolve(import.meta.dirname, '../scripts/cron/update-image-digests.sh'), script);
		const images = ['node:22-trixie-slim', 'gcr.io/distroless/nodejs22-debian13:nonroot'];
		const oldDigest = 'sha256:' + '0'.repeat(64);
		const newDigest = 'sha256:' + '1'.repeat(64);
		for (const service of ['user-service', 'chat-service', 'notification-service']) {
			mkdirSync(join(directory, 'backend', service));
			writeFileSync(join(directory, 'backend', service, 'Dockerfile'), images.map(image => `FROM ${image}@${oldDigest}\n`).join(''));
		}
		mkdirSync(join(directory, 'backend/nginx'));
		const nginx = 'nginxinc/nginx-unprivileged:stable-alpine-slim';
		writeFileSync(join(directory, 'backend/nginx/Dockerfile'), `FROM ${nginx}@${oldDigest}\n`);
		const failure = scenario === 'lookup-fails' ? 'exit 1' : "printf '%s\\n' 'sha256:malformed'; exit 0";
		writeFileSync(join(directory, 'crane'), `#!/bin/sh\n${scenario === 'valid' ? '' : `if [ "$2" = "gcr.io/distroless/nodejs22-debian13:nonroot" ]; then ${failure}; fi\n`}printf '%s\\n' '${newDigest}'\n`);
		chmodSync(join(directory, 'crane'), 0o755);
		writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' \'{"config":{"digest":"sha256:wrong-config"}}\'\n');
		writeFileSync(join(directory, 'jq'), `#!/bin/sh\nprintf '%s\\n' 'sha256:${'2'.repeat(64)}'\n`);
		const result = spawnSync('docker', ['--context', context, 'run', '--rm', '--network', 'none', '--platform', 'linux/amd64', '-v', `${directory}:/fixture`, '--entrypoint', 'bash', 'node:22-trixie-slim@sha256:2117f713a417f3aff682ac8f5bc2ebbdf1beed51f36e67ab1e0fd3866b6d2d8f', '-c', 'install -m 755 /fixture/crane /fixture/docker /fixture/jq /usr/local/bin/; exec bash /fixture/backend/scripts/cron/update-image-digests.sh --apply'], { encoding: 'utf8', timeout: 60000 });
		if (scenario === 'valid') assert.equal(result.status, 0, result.stderr);
		else assert.notEqual(result.status, 0, 'failed lookup must fail the refresh');
		const expected = scenario === 'valid' ? newDigest : oldDigest;
		for (const service of ['user-service', 'chat-service', 'notification-service']) {
			assert.equal(readFileSync(join(directory, 'backend', service, 'Dockerfile'), 'utf8'), images.map(image => `FROM ${image}@${expected}\n`).join(''));
		}
		assert.equal(readFileSync(join(directory, 'backend/nginx/Dockerfile'), 'utf8'), `FROM ${nginx}@${expected}\n`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
