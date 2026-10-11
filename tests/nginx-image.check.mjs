import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

const image = process.env.NGINX_TEST_IMAGE;
assert.ok(image, 'Set NGINX_TEST_IMAGE to the locally built gateway image');
const context = process.env.NGINX_TEST_DOCKER_CONTEXT ?? 'default';

function docker(...args) {
	const result = spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 30000 });
	if (result.status !== 0 && args[0] === 'exec') {
		const state = spawnSync('docker', ['--context', context, 'inspect', args[1], '--format', '{{json .State}}'], { encoding: 'utf8' });
		const logs = spawnSync('docker', ['--context', context, 'logs', args[1]], { encoding: 'utf8' });
		assert.fail(`${result.stderr} state=${state.stdout} logs=${logs.stdout} ${logs.stderr}`);
	}
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

test('gateway remains non-root with development, production TLS and read-only shared override configs', async () => {
	// Colima mounts the worktree, not macOS's private temporary directories.
	const directory = mkdtempSync(join(import.meta.dirname, '.nginx-check-'));
	const containers = [];
	try {
		chmodSync(directory, 0o755);
		const certificates = join(directory, 'certificates');
		for (const domain of ['chat.ctaprojects.xyz-0001', 'n8n.ctaprojects.xyz']) {
			const target = join(certificates, 'live', domain);
			mkdirSync(target, { recursive: true });
			const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chat.ctaprojects.xyz', '-keyout', join(target, 'privkey.pem'), '-out', join(target, 'fullchain.pem')], { encoding: 'utf8', timeout: 30000 });
			assert.equal(cert.status, 0, cert.stderr);
			// Only this disposable self-signed fixture is readable by the container UID.
			chmodSync(join(target, 'privkey.pem'), 0o644);
		}
		const override = join(directory, 'shared.conf');
		writeFileSync(override, 'events {}\nhttp { server { listen 8080; location /health { return 200 "shared-override"; } } }\n');
		const cases = [
			{ name: 'development', mounts: [], command: [], expected: 'nginx-gateway' },
			{ name: 'production', mounts: ['-v', `${certificates}:/etc/letsencrypt:ro`], command: ['-c', '/opt/bitnami/nginx/conf/nginx.prod.conf', '-g', 'daemon off; pid /tmp/nginx.pid;'], expected: 'nginx-gateway' },
			{ name: 'override', mounts: ['-v', `${override}:/opt/bitnami/nginx/conf/nginx.conf:ro`], command: [], expected: 'shared-override' }
		];
		for (const fixture of cases) {
			const id = docker('run', '-d', '--platform', 'linux/amd64', '-p', '127.0.0.1::8080', '-p', '127.0.0.1::8443', ...['user', 'chat', 'notification', 'frontend', 'n8n'].flatMap(host => ['--add-host', `${host}:127.0.0.1`]), ...fixture.mounts, image, ...fixture.command);
			containers.push(id);
			assert.equal(docker('exec', id, 'id', '-u'), '1001');
			if (fixture.name === 'development') {
				docker('exec', id, 'nc', '-z', '-w', '2', '127.0.0.1', '8080');
			}
			let published;
			for (let attempt = 0; attempt < 100; attempt++) {
				published = spawnSync('docker', ['--context', context, 'port', id, '8080/tcp'], { encoding: 'utf8', timeout: 30000 });
				if (published.status === 0 && published.stdout.trim()) break;
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			if (published.status !== 0 || !published.stdout.trim()) {
				const logs = spawnSync('docker', ['--context', context, 'logs', id], { encoding: 'utf8', timeout: 30000 });
				assert.fail(`${fixture.name}: ${published.stderr} ${logs.stdout} ${logs.stderr}`);
			}
			const port = published.stdout.trim().split(':').at(-1);
			let response;
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					response = await new Promise((resolve, reject) => {
						const request = httpGet(`http://127.0.0.1:${port}/health`, { headers: { Host: 'chat.ctaprojects.xyz' } }, res => {
							let body = '';
							res.on('data', chunk => { body += chunk; });
							res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
						});
						request.setTimeout(2000, () => request.destroy(new Error('HTTP probe timeout')));
						request.on('error', reject);
					});
					break;
				} catch (error) {
					if (attempt === 99) {
						const logs = spawnSync('docker', ['--context', context, 'logs', id], { encoding: 'utf8', timeout: 30000 });
						throw new Error(`${fixture.name}: port ${port}, ${error.cause}, logs=${logs.stdout} ${logs.stderr}`, { cause: error });
					}
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			}
			if (fixture.name === 'production') {
				assert.equal(response.status, 301);
				assert.equal(response.headers.location, 'https://chat.ctaprojects.xyz/health');
				const tlsPort = docker('port', id, '8443/tcp').split(':').at(-1);
				const tls = await new Promise((resolve, reject) => {
					const request = get(`https://127.0.0.1:${tlsPort}/health`, { rejectUnauthorized: false, headers: { Host: 'chat.ctaprojects.xyz' } }, res => {
						let body = '';
						res.on('data', chunk => { body += chunk; });
						res.on('end', () => resolve({ status: res.statusCode, body }));
					});
					request.setTimeout(3000, () => request.destroy(new Error('TLS probe timeout')));
					request.on('error', reject);
				});
				assert.equal(tls.status, 200);
				assert.match(tls.body, /"ssl":"enabled"/);
			} else {
				assert.equal(response.status, 200);
				assert.ok(response.body.includes(fixture.expected));
			}
		}
	} finally {
		for (const id of containers) docker('rm', '-f', id);
		rmSync(directory, { recursive: true, force: true });
	}
});
