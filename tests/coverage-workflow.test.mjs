import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const services = ['chat-service', 'notification-service', 'user-service'];

function fixture(t) {
	const root = mkdtempSync(path.join(tmpdir(), 'chat-lcov-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const service of services) {
		mkdirSync(path.join(root, service, 'src'), { recursive: true });
		writeFileSync(path.join(root, service, 'src', 'index.ts'), 'export const value = 1;\n');
		mkdirSync(path.join(root, 'artifacts', `lcov-${service}`), { recursive: true });
		writeFileSync(path.join(root, 'artifacts', `lcov-${service}`, 'lcov.info'), 'TN:\nSF:src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n');
	}
	return root;
}

function normalize(root) {
	return spawnSync('bash', [path.join(repo, 'scripts', 'normalize-lcov.sh'), './artifacts', 'coverage/combined-lcov.info'], {
		cwd: root, encoding: 'utf8', timeout: 10_000,
	});
}

test('keeps same-named LCOV artifacts from all three services with resolvable source paths', t => {
	const root = fixture(t);
	const result = normalize(root);
	assert.equal(result.status, 0, result.stderr);
	const combined = readFileSync(path.join(root, 'coverage', 'combined-lcov.info'), 'utf8');
	assert.deepEqual(combined.match(/^SF:.*$/gm), services.map(service => `SF:${service}/src/index.ts`));
	assert.equal(combined.match(/^DA:1,1$/gm).length, 3);
	assert.equal(combined.match(/^LH:1$/gm).length, 3);
	for (const entry of combined.matchAll(/^SF:(.*)$/gm)) assert.ok(existsSync(path.join(root, entry[1])));
});

test('missing or empty coverage fails without replacing the last combined report', t => {
	const root = fixture(t);
	mkdirSync(path.join(root, 'coverage'));
	const output = path.join(root, 'coverage', 'combined-lcov.info');
	writeFileSync(output, 'previous report\n');
	for (const empty of [false, true]) {
		const missing = path.join(root, 'artifacts', 'lcov-user-service', 'lcov.info');
		if (empty) writeFileSync(missing, ''); else rmSync(missing);
		const result = normalize(root);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.equal(readFileSync(output, 'utf8'), 'previous report\n');
	}
});

test('rejects unresolved, cross-service and escaping source paths instead of publishing false coverage', t => {
	const root = fixture(t);
	for (const source of ['src/missing.ts', 'user-service/src/index.ts', 'src/../../user-service/src/index.ts']) {
		writeFileSync(path.join(root, 'artifacts', 'lcov-chat-service', 'lcov.info'), `SF:${source}\nDA:1,1\nend_of_record\n`);
		const result = normalize(root);
		assert.notEqual(result.status, 0, `${source}: ${result.stdout}${result.stderr}`);
		assert.ok(!existsSync(path.join(root, 'coverage', 'combined-lcov.info')));
	}
});

test('normalizes every supported producer path including covered test helpers', t => {
	const root = fixture(t);
	mkdirSync(path.join(root, 'chat-service', 'tests', 'utils'), { recursive: true });
	writeFileSync(path.join(root, 'chat-service', 'tests', 'utils', 'helper.ts'), 'export const value = 1;\n');
	const input = ['src/index.ts', './src/index.ts', 'build/src/index.ts', 'chat-service/src/index.ts', 'tests/utils/helper.ts'];
	writeFileSync(path.join(root, 'artifacts', 'lcov-chat-service', 'lcov.info'), input.map(source => `SF:${source}\nDA:1,1\nend_of_record\n`).join(''));
	const result = normalize(root);
	assert.equal(result.status, 0, result.stderr);
	const combined = readFileSync(path.join(root, 'coverage', 'combined-lcov.info'), 'utf8');
	assert.deepEqual(combined.match(/^SF:chat-service\/.*$/gm), [
		...Array(4).fill('SF:chat-service/src/index.ts'), 'SF:chat-service/tests/utils/helper.ts',
	]);
});
