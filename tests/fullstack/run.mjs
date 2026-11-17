import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (['--check', '--start-fixture', '--go-websocket', '--rehearse-rollback', '--check-relay-capacity'].includes(argument)) options.set(argument, true);
  else {
    assert.equal(argument, '--frontend-dir', 'Unknown fixture argument');
    options.set(argument, process.argv[++index]);
  }
}
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use Node 22');
assert.ok(options.has('--check') !== options.has('--start-fixture'), 'Select --check or --start-fixture');
assert.ok(options.get('--frontend-dir'), '--frontend-dir is required');
const frontend = realpathSync(resolve(options.get('--frontend-dir')));
const macOS = process.platform === 'darwin';
const docker = macOS ? '/opt/homebrew/bin/docker' : 'docker';
const compose = macOS ? '/opt/homebrew/bin/docker-compose' : docker;
const context = macOS ? 'colima' : 'default';
const composePrefix = macOS ? [] : ['--context', context, 'compose'];
const runId = `fullstack-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const project = runId;
const databaseName = `fullstack_${runId.slice(10)}`;
const goWebSocket = options.has('--go-websocket');
const rehearseRollback = options.has('--rehearse-rollback');
const checkRelayCapacity = options.has('--check-relay-capacity');
assert.ok(!rehearseRollback || (goWebSocket && options.has('--start-fixture')), '--rehearse-rollback requires --start-fixture and --go-websocket');
assert.ok(!checkRelayCapacity || (goWebSocket && options.has('--start-fixture')), '--check-relay-capacity requires --start-fixture and --go-websocket');
const services = new Set(['postgres', 'rabbitmq', 'user', 'chat', 'notification', 'frontend', 'gateway']);
if (goWebSocket) services.add('go-websocket');
const cleanEnvironment = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
cleanEnvironment.DOCKER_CONTEXT = context;
const require = createRequire(join(root, 'user-service/package.json'));
const { Client } = require('pg');

function output(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: cleanEnvironment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function ownedContainer(container, owner) {
  assert.equal(container.Config.Labels['chat.fullstack.run'], owner.runId, 'Container run label differs');
  assert.equal(container.Config.Labels['chat.fullstack.project'], owner.project, 'Container owner differs');
  assert.equal(container.Config.Labels['com.docker.compose.project'], owner.project, 'Compose project differs');
  assert.ok(services.has(container.Config.Labels['com.docker.compose.service']), 'Unexpected service');
  const service = container.Config.Labels['com.docker.compose.service'];
  if (service === 'postgres' || service === 'rabbitmq') {
    const target = service === 'postgres' ? '/var/lib/postgresql/data' : '/var/lib/rabbitmq';
    assert.ok(container.HostConfig.Tmpfs?.[target], 'Fixture data must use tmpfs');
  }
  for (const mount of container.Mounts) {
    assert.notEqual(mount.Type, 'volume', 'Named and anonymous volumes are forbidden');
    if (mount.Type === 'bind') {
      assert.ok(realpathSync(mount.Source).startsWith(owner.runtime + sep), 'Mount escapes this fixture');
      assert.equal(mount.RW, false, 'Fixture bind mounts must be read-only');
    } else assert.equal(mount.Type, 'tmpfs', 'Unexpected mount type');
  }
  for (const bindings of Object.values(container.HostConfig.PortBindings ?? {})) {
    for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1', 'Public binding is forbidden');
  }
}

function runCommand(title, executable, args, options) {
  return new Promise((done, fail) => {
    console.log(`Start: ${title}`);
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, detached: true });
    let stdout = '';
    let outputError;
    let expired = false;
    let closed = false;
    let killed = false;
    let finished = false;
    let grace;
    let final;
    const append = chunk => { try { if (options.log) appendFileSync(options.log, chunk); } catch (error) { outputError ??= error; } };
    const signalGroup = signal => {
      if (!child.pid) return;
      assert.ok(child.pid > 1 && child.pid !== process.pid, 'Only the spawned process group can be signaled');
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') outputError ??= error; }
    };
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearTimeout(final);
      if (expired) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (error) fail(error); else done(stdout.trim());
    };
    const deadlineError = () => new Error(`${title} timed out; its owned process group received SIGKILL`);
    const timeout = setTimeout(() => {
      expired = true;
      signalGroup('SIGTERM');
      grace = setTimeout(() => {
        killed = true;
        signalGroup('SIGKILL');
        if (closed) finish(deadlineError());
        else final = setTimeout(() => finish(deadlineError()), 500);
      }, options.grace ?? 2000);
    }, options.timeout ?? 180_000);
    child.stdout.on('data', chunk => { stdout += chunk; append(chunk); });
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    child.once('error', finish);
    child.once('close', (code, signal) => {
      closed = true;
      console.log(`Exit: ${title}: ${code ?? signal}`);
      if (expired) { if (killed) finish(deadlineError()); }
      else finish(outputError ?? (code !== 0 ? new Error(`${title} failed`) : undefined));
    });
    if (options.input) child.stdin.end(options.input); else child.stdin.end();
  });
}

async function databaseCall(database, operation, label, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { Promise.resolve(database.end()).catch(() => {}); } catch { /* Force-close the owned stream below. */ }
          try { database.connection?.stream?.destroy(); } catch { /* The deadline still rejects. */ }
          reject(new Error(`${label} timed out`));
        }, timeout);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function cleanupFixture(database, { verify, diagnostics, teardown, record }, timeout = 5000) {
  let failure;
  let disconnected = false;
  const disconnect = async () => {
    if (disconnected) return;
    try { await databaseCall(database, () => database.end(), 'Fixture database disconnect', timeout); }
    finally { disconnected = true; }
  };
  const report = (stage, error) => {
    try { record(stage, error); } catch (recordError) { console.error(`Cleanup diagnostic recording failed: ${recordError.message}`); }
  };
  try {
    await verify();
    try { await diagnostics(); } catch (error) { report('logs', error); }
    try { await disconnect(); } catch (error) { failure = error; report('disconnect', error); }
    await teardown();
  } catch (error) { failure ??= error; }
  finally {
    try { await disconnect(); }
    catch (error) { if (failure) report('disconnect', error); else failure = error; }
  }
  if (failure) throw failure;
}

function gatewayBinds(volumes, runtime) {
  const expected = new Map([
    ['/opt/bitnami/nginx/conf/nginx.conf', ['nginx.conf', false]],
    ['/fixture-certificates', ['certificates', true]],
  ]);
  assert.equal(volumes.length, expected.size, 'Unexpected gateway mounts');
  for (const volume of volumes) {
    assert.equal(volume.type, 'bind');
    assert.equal(volume.read_only, true);
    const specification = expected.get(volume.target);
    assert.ok(specification, 'Unexpected gateway mount target');
    const [relative, directory] = specification;
    const path = join(runtime, relative);
    assert.equal(volume.source, path, 'Unexpected gateway bind source');
    assert.equal(realpathSync(path), path, 'Gateway bind source must not be a symlink');
    assert.ok(realpathSync(path).startsWith(runtime + sep), 'Gateway source escapes the fixture');
    assert.ok(directory ? lstatSync(path).isDirectory() : lstatSync(path).isFile());
    expected.delete(volume.target);
  }
  for (const filename of ['privkey.pem', 'fullchain.pem']) {
    assert.ok(lstatSync(join(runtime, 'certificates', filename)).isFile(), 'Certificate fixtures must be regular files');
  }
}

async function checkCleanupPaths() {
  const calls = [];
  const database = { end: async () => { calls.push('end'); }, connection: { stream: { destroy: () => calls.push('destroy') } } };
  const steps = { verify: async () => {}, diagnostics: async () => {}, teardown: async () => { calls.push('remove'); }, record: stage => { calls.push(stage); } };
  await cleanupFixture(database, { ...steps, diagnostics: async () => { throw new Error('Diagnostic capture failed'); } }, 50);
  assert.deepEqual(calls, ['logs', 'end', 'remove']);
  calls.length = 0;
  await assert.rejects(cleanupFixture(database, { ...steps, verify: async () => { throw new Error('Identity unavailable; resources retained'); } }, 50), /Identity unavailable/);
  assert.deepEqual(calls, ['end']);
  calls.length = 0;
  const stuck = { ...database, end: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(cleanupFixture(stuck, { ...steps, verify: async () => { throw new Error('Identity mismatch; resources retained'); } }, 30), /Identity mismatch/);
  assert.ok(calls.includes('destroy') && calls.includes('disconnect'));
  assert.ok(Date.now() - started < 1000, 'Stalled disconnect must be bounded');
  for (const label of ['connect', 'query']) {
    calls.length = 0;
    await assert.rejects(databaseCall(database, () => new Promise(() => {}), label, 30), /timed out/);
    assert.ok(calls.includes('end') && calls.includes('destroy'));
  }
  const directory = realpathSync(mkdtempSync(join(root, 'tests/fullstack/.runtime/mount-check-')));
  try {
    mkdirSync(join(directory, 'certificates'));
    for (const path of ['nginx.conf', 'certificates/privkey.pem', 'certificates/fullchain.pem']) writeFileSync(join(directory, path), 'Synthetic safety fixture');
    const mounts = [{ type: 'bind', read_only: true, source: join(directory, 'nginx.conf'), target: '/opt/bitnami/nginx/conf/nginx.conf' }, { type: 'bind', read_only: true, source: join(directory, 'certificates'), target: '/fixture-certificates' }];
    gatewayBinds(mounts, directory);
    assert.throws(() => gatewayBinds([{ ...mounts[0], source: root }, mounts[1]], directory));
    assert.throws(() => gatewayBinds([{ ...mounts[0], type: 'volume' }, mounts[1]], directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function checkCommandShutdown() {
  const directory = mkdtempSync(join(root, 'tests/fullstack/.runtime/command-check-'));
  const fixture = join(directory, 'ignore-term.mjs');
  const pids = join(directory, 'pids.json');
  writeFileSync(fixture, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
if (process.argv[3] === 'child') writeFileSync(process.argv[2], JSON.stringify({ leader: process.ppid, child: process.pid }));
else spawn(process.execPath, [process.argv[1], process.argv[2], 'child'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
  const pending = runCommand('SIGTERM-ignoring owned child group', process.execPath, [fixture, pids], {
    cwd: directory, env: cleanEnvironment, timeout: 500, grace: 200
  }).then(() => ({ completed: true }), error => ({ error }));
  let group;
  try {
    await poll('Owned child startup', () => existsSync(pids), 1000);
    group = JSON.parse(readFileSync(pids, 'utf8'));
    const result = await Promise.race([pending, delay(1600).then(() => undefined)]);
    assert.ok(result, 'Command deadline did not finish a SIGTERM-ignoring group');
    assert.match(result.error?.message ?? '', /timed out/);
    await poll('Owned process group shutdown', () => {
      try { process.kill(-group.leader, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, 1000);
  } finally {
    if (group?.leader) {
      assert.ok(Number.isSafeInteger(group.leader) && group.leader > 1 && group.leader !== process.pid);
      try { process.kill(-group.leader, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.race([pending, delay(1000)]);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function checkGuards() {
  const owner = { runId: 'fixture-check', project: 'fixture-check', runtime: root };
  const sample = { Config: { Labels: { 'chat.fullstack.run': owner.runId, 'chat.fullstack.project': owner.project, 'com.docker.compose.project': owner.project, 'com.docker.compose.service': 'postgres' } }, Mounts: [{ Type: 'tmpfs' }], HostConfig: { Tmpfs: { '/var/lib/postgresql/data': 'rw' }, PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1' }] } } };
  ownedContainer(sample, owner);
  assert.throws(() => ownedContainer({ ...sample, Config: { Labels: {} } }, owner));
  assert.throws(() => ownedContainer({ ...sample, Mounts: [{ Type: 'volume' }] }, owner));
  assert.throws(() => ownedContainer({ ...sample, HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0' }] } } }, owner));
  const document = readFileSync(join(root, 'tests/fullstack/compose.yml'), 'utf8');
  assert.ok(!/env_file:|\/private\/tmp|ALL TABLES|DEFAULT PRIVILEGES/.test(document));
  assert.match(document, /internal: true/);
  assert.equal((document.match(/127\.0\.0\.1:/g) ?? []).length, 2);
  await checkCommandShutdown();
  await checkCleanupPaths();
  console.log('Fixture ownership guards passed. No Docker mutation ran.');
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  return port;
}

async function poll(name, condition, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await condition(); if (value) return value; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`${name} did not become ready`, { cause: last });
}

async function main() {
  await checkGuards();
  if (options.has('--check')) return;
  assert.equal(output(docker, ['context', 'show']), context, `Use the ${context} Docker context`);
  assert.ok(output(docker, ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).startsWith('unix://'), 'Only a local Unix Docker socket is permitted');
  assert.match(output(docker, ['--context', context, 'info', '--format', '{{.OSType}}/{{.Architecture}}']), /^linux\/(aarch64|arm64)$/);
  const backendCommit = output('/usr/bin/git', ['rev-parse', 'HEAD^{commit}']);
  const frontendCommit = output('/usr/bin/git', ['rev-parse', 'HEAD^{commit}'], frontend);
  const runtime = realpathSync(mkdtempSync(join(root, 'tests/fullstack/.runtime/')));
  const owner = { runId, project, runtime, backendCommit, frontendCommit, databaseName };
  writeFileSync(join(runtime, 'ownership.json'), JSON.stringify(owner, null, 2), { mode: 0o600 });
  chmodSync(runtime, 0o755);
  const log = join(runtime, 'commands.log');
  const evidence = join(runtime, 'evidence');
  mkdirSync(evidence);
  const originalIds = output(docker, ['--context', context, 'ps', '-aq']).split('\n').filter(Boolean);
  const baseline = originalIds.map(id => ({ id, started: output(docker, ['--context', context, 'inspect', id, '--format', '{{.State.StartedAt}}']) }));
  writeFileSync(join(evidence, 'baseline-containers.json'), JSON.stringify(baseline, null, 2));
  const env = { ...cleanEnvironment, FULLSTACK_RUN_ID: runId, FULLSTACK_PROJECT: project, FULLSTACK_RUNTIME: runtime,
    FULLSTACK_SNAPSHOT: join(runtime, 'snapshot'), FULLSTACK_DATABASE: databaseName,
    FULLSTACK_TLS_PORT: String(await freePort()), FULLSTACK_PG_PORT: String(await freePort()) };
  assert.notEqual(env.FULLSTACK_PG_PORT, env.FULLSTACK_TLS_PORT, 'Fixture PostgreSQL and TLS ports must differ');
  env.FULLSTACK_ORIGIN = `https://127.0.0.1:${env.FULLSTACK_TLS_PORT}`;
  env.FULLSTACK_GO_WS = String(goWebSocket);
  if (goWebSocket) {
    env.FULLSTACK_GO_WS_BRIDGE_TOKEN = randomUUID() + randomUUID();
    env.FULLSTACK_GO_WS_BRIDGE_URL = 'http://go-websocket:8090/internal/messages';
  }
  writeFileSync(join(runtime, 'empty.env'), '');
  const composeArgs = ['--env-file', join(runtime, 'empty.env'), '--project-directory', runtime, '-p', project, '-f', join(root, 'tests/fullstack/compose.yml')];
  if (goWebSocket) composeArgs.push('--profile', 'go-websocket');
  const command = (title, executable, args, extra = {}) => runCommand(title, executable, args, { cwd: root, env, log, ...extra });
  const composeCommand = (title, args, extra) => command(title, compose, [...composePrefix, ...composeArgs, ...args], extra);
  const dockerOutput = args => output(docker, ['--context', context, ...args]);
  const databaseUrl = `postgres://fixture_admin:FixtureAdminOnly2026@127.0.0.1:${env.FULLSTACK_PG_PORT}/${databaseName}`;
  const database = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  database.on('error', error => { process.exitCode = 1; console.error(`Fixture database connection failed: ${error.message}`); });
  const query = (...args) => databaseCall(database, () => database.query(...args), 'Fixture database query');
  const waitForHTTPS = path => poll(`HTTPS ${path}`, () => new Promise((done, fail) => {
    const probe = request(env.FULLSTACK_ORIGIN + path, { rejectUnauthorized: false }, response => {
      response.resume();
      done(response.statusCode === 200);
    });
    probe.setTimeout(3000, () => probe.destroy(new Error('Fixture HTTPS timeout')));
    probe.on('error', fail);
    probe.end();
  }));
  let databaseIdentity;
  let primaryFailure;
  try {
    for (const [directory, commit, destination, paths] of [[root, backendCommit, 'backend', ['user-service', 'chat-service', 'notification-service', 'nginx', ...(goWebSocket ? ['websocket-service'] : [])]], [frontend, frontendCommit, 'frontend', []]]) {
      const target = join(env.FULLSTACK_SNAPSHOT, destination);
      mkdirSync(target, { recursive: true });
      const archive = spawnSync('/usr/bin/git', ['archive', '--format=tar', commit, ...paths], { cwd: directory, env: cleanEnvironment, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(archive.status, 0, 'Candidate archive failed');
      await command(`Extract ${destination} committed build context`, '/usr/bin/tar', ['-xf', '-', '-C', target], { input: archive.stdout });
    }
    const certificates = join(runtime, 'certificates');
    mkdirSync(certificates);
    await command('Generate disposable localhost TLS fixture', 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(certificates, 'privkey.pem'), '-out', join(certificates, 'fullchain.pem')]);
    chmodSync(join(certificates, 'privkey.pem'), 0o644);
    const gateway = readFileSync(join(env.FULLSTACK_SNAPSHOT, 'backend/nginx/nginx.conf'), 'utf8');
    assert.equal((gateway.match(/listen 8080;/g) ?? []).length, 1);
    const upgrade = goWebSocket ? `
    location = /ws/v1 {
        proxy_pass http://go-websocket:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection Upgrade;
    }` : '';
    writeFileSync(join(runtime, 'nginx.conf'), gateway.replace('listen 8080;', 'listen 8443 ssl;\n    ssl_certificate /fixture-certificates/fullchain.pem;\n    ssl_certificate_key /fixture-certificates/privkey.pem;' + upgrade));
    for (const image of ['postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24', 'rabbitmq@sha256:6931816af1a943f471c038b278835d36692d55dec769232739296bb91b7de0f5']) {
      const [detail] = JSON.parse(dockerOutput(['image', 'inspect', image]));
      assert.equal(detail.Os, 'linux');
      assert.equal(detail.Architecture, 'arm64');
      appendFileSync(join(evidence, 'images.jsonl'), JSON.stringify({ id: detail.Id, digests: detail.RepoDigests, os: detail.Os, architecture: detail.Architecture }) + '\n');
    }
    await composeCommand('Validate isolated topology', ['config', '--quiet']);
    const topology = JSON.parse(await composeCommand('Resolve gateway bind sources', ['config', '--format', 'json']));
    gatewayBinds(topology.services.gateway.volumes, runtime);
    assert.equal(topology.networks.default.internal, true);
    assert.equal(topology.networks.loopback.internal ?? false, false);
    for (const service of services) {
      const attached = Object.keys(topology.services[service].networks).sort();
      assert.deepEqual(attached, ['postgres', 'gateway'].includes(service) ? ['default', 'loopback'] : ['default']);
    }
    const application = [...services].filter(service => !['postgres', 'rabbitmq', 'gateway'].includes(service));
    for (const service of [...application, 'gateway']) {
      await composeCommand(`Build actual ${service} image`, ['build', service], { timeout: 600_000 });
    }
    await composeCommand('Start owned PostgreSQL and RabbitMQ', ['up', '-d', 'postgres', 'rabbitmq']);
    const containerId = service => dockerOutput(['ps', '-aq', '--filter', `label=chat.fullstack.run=${runId}`, '--filter', `label=com.docker.compose.service=${service}`]);
    for (const service of ['postgres', 'rabbitmq']) await poll(`${service} health`, () => dockerOutput(['inspect', containerId(service), '--format', '{{.State.Health.Status}}']) === 'healthy');
    await databaseCall(database, () => database.connect(), 'Fixture database connect');
    databaseIdentity = (await query('SELECT current_database() AS database, current_user AS role, system_identifier::text AS system FROM pg_control_system()')).rows[0];
    assert.equal(databaseIdentity.database, databaseName);
    assert.equal(databaseIdentity.role, 'fixture_admin');
    writeFileSync(join(evidence, 'database-identity.json'), JSON.stringify(databaseIdentity, null, 2));
    await query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    for (const service of ['user', 'chat', 'notification']) {
      await composeCommand(`Apply actual ${service} migrations`, ['run', '--no-deps', '-T', '--name', `${project}-${service}-migrate`, '-e', `DATABASE_URL=postgres://fixture_admin:FixtureAdminOnly2026@postgres:5432/${databaseName}`, service, 'build/src/migrate.js']);
    }
    await query(`
      REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      CREATE ROLE user_svc LOGIN PASSWORD 'FixtureUserOnly2026';
      CREATE ROLE chat_svc LOGIN PASSWORD 'FixtureChatOnly2026';
      CREATE ROLE notif_svc LOGIN PASSWORD 'FixtureNotificationOnly2026';
      GRANT CONNECT ON DATABASE "${databaseName}" TO user_svc, chat_svc, notif_svc;
      GRANT USAGE ON SCHEMA public TO user_svc, chat_svc, notif_svc;
    `);
    await query(readFileSync(join(root, 'scripts/grant-service-privileges.sql'), 'utf8'));
    const privileges = (await query("SELECT has_table_privilege('notif_svc','notification_inbox','DELETE') AS inbox_delete, has_table_privilege('chat_svc','users','SELECT') AS cross_table, has_table_privilege('user_svc','typeorm_migrations_user','SELECT') AS migration_access")).rows[0];
    assert.deepEqual(privileges, { inbox_delete: false, cross_table: false, migration_access: false });
    writeFileSync(join(evidence, 'restricted-role-check.json'), JSON.stringify(privileges));
    await composeCommand('Start actual application services', ['up', '-d', '--no-deps', ...application]);
    const inspectService = service => {
      const [container] = JSON.parse(dockerOutput(['inspect', containerId(service)]));
      ownedContainer(container, owner);
      return container;
    };
    const relay = goWebSocket ? inspectService('go-websocket') : undefined;
    if (relay) {
      assert.equal(relay.Config.User, '65532:65532', 'The relay must run as an unprivileged user');
      assert.equal(relay.HostConfig.ReadonlyRootfs, true);
      assert.ok(relay.HostConfig.CapDrop?.includes('ALL'));
      assert.ok(relay.HostConfig.SecurityOpt?.some(option => /^no-new-privileges[:=]true$/.test(option)));
      assert.equal(Object.keys(relay.HostConfig.PortBindings ?? {}).length, 0);
      console.log('Verified Go relay container isolation.');
    }
    await composeCommand('Start fixture HTTPS gateway', ['up', '-d', '--no-deps', 'gateway']);
    for (const path of ['/user/health', '/chat/health', '/notifications/health', '/login']) {
      await waitForHTTPS(path);
    }
    const browserFlow = (title, testArgs, evidencePath = evidence) => command(title, process.execPath,
      [join(frontend, 'node_modules/@playwright/test/cli.js'), 'test', ...testArgs, '--config', join(frontend, 'playwright.fullstack.config.ts')],
      { cwd: frontend, timeout: 180_000, env: {
        ...cleanEnvironment, FULLSTACK_ORIGIN: env.FULLSTACK_ORIGIN, FULLSTACK_EVIDENCE: evidencePath,
        FULLSTACK_RUN_ID: runId, FULLSTACK_BACKEND_ROOT: root,
        FULLSTACK_DATABASE_URL: databaseUrl,
        FULLSTACK_DATABASE_ID: databaseIdentity.system
      } });
    if (rehearseRollback) {
      await command('Restart verified Go relay', docker, ['--context', context, 'restart', '--timeout', '8', relay.Id]);
      const restarted = inspectService('go-websocket');
      assert.equal(restarted.Id, relay.Id);
      assert.equal(restarted.State.Running, true);
      assert.notEqual(restarted.State.StartedAt, relay.State.StartedAt);
    }
    await browserFlow('Real two-context browser and database flow', goWebSocket ? ['go-websocket.spec.ts', '--grep', 'Go delivers ciphertext'] : ['chat.spec.ts']);
    if (checkRelayCapacity) {
      await browserFlow('Go relay capacity through NGINX', ['go-websocket-capacity.spec.ts'], join(runtime, 'capacity-evidence'));
    }
    if (rehearseRollback) {
      const stored = (await query('SELECT * FROM messages ORDER BY id')).rows;
      assert.ok(stored.length >= 2 && stored.every(row => row.isEncrypted), 'Expected persisted ciphertext from the Go flow');
      await command('Stop verified Go relay', docker, ['--context', context, 'stop', '--timeout', '8', relay.Id]);
      assert.equal(inspectService('go-websocket').State.Running, false);
      const frontendBefore = inspectService('frontend');
      await composeCommand('Disable Go in the frontend', ['up', '-d', '--no-deps', '--force-recreate', 'frontend'], {
        env: { ...env, FULLSTACK_GO_WS: 'false' }
      });
      const frontendAfter = inspectService('frontend');
      assert.equal(frontendAfter.Image, frontendBefore.Image);
      assert.notEqual(frontendAfter.Id, frontendBefore.Id);
      assert.ok(frontendAfter.Config.Env.includes('PUBLIC_GO_WS_ENABLED=false'));
      await waitForHTTPS('/login');
      console.log('Wait for the 60-second shared prekey rate limit window to expire.');
      await delay(60_000);
      await browserFlow('Socket.IO browser flow after rollback', ['go-websocket.spec.ts', '--grep', 'Socket.IO delivers after Go rollback'], join(runtime, 'rollback-evidence'));
      const afterRollback = (await query('SELECT * FROM messages WHERE id = ANY($1::uuid[]) ORDER BY id', [stored.map(row => row.id)])).rows;
      assert.deepEqual(afterRollback, stored, 'Rollback changed messages from the Go flow');
      console.log(`Verified Socket.IO rollback and preserved ${stored.length} Go message rows.`);
    }
  } catch (error) {
    primaryFailure = error;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    console.log(`Evidence directory: ${runtime}`);
    try {
      let ids = [];
      let networks = [];
      await cleanupFixture(database, {
        verify: async () => {
          assert.equal(output(docker, ['context', 'show']), context);
          ids = dockerOutput(['ps', '-aq', '--filter', `label=chat.fullstack.run=${runId}`]).split('\n').filter(Boolean);
          const containers = ids.length ? JSON.parse(dockerOutput(['inspect', ...ids])) : [];
          for (const container of containers) ownedContainer(container, owner);
          if (containers.some(container => container.Config.Labels['com.docker.compose.service'] === 'postgres')) {
            assert.ok(databaseIdentity, 'Database identity is unavailable. Owned resources are retained for review.');
            const identity = (await query('SELECT current_database() AS database, current_user AS role, system_identifier::text AS system FROM pg_control_system()')).rows[0];
            assert.deepEqual(identity, databaseIdentity, 'Database identity changed. Owned resources are retained for review.');
          }
          networks = dockerOutput(['network', 'ls', '-q', '--filter', `label=chat.fullstack.run=${runId}`]).split('\n').filter(Boolean);
          const expectedNetworks = new Map([['default', true], ['loopback', false]]);
          for (const id of networks) {
            const [network] = JSON.parse(dockerOutput(['network', 'inspect', id]));
            assert.equal(network.Labels['chat.fullstack.project'], project);
            assert.equal(network.Labels['com.docker.compose.project'], project);
            const name = network.Labels['com.docker.compose.network'];
            assert.equal(network.Internal, expectedNetworks.get(name), 'Unexpected fixture network');
            expectedNetworks.delete(name);
            assert.ok(Object.keys(network.Containers ?? {}).every(id => ids.some(owned => id.startsWith(owned))), 'A foreign container joined this network');
          }
          writeFileSync(join(evidence, 'owned-resources.json'), JSON.stringify({ containers: containers.map(container => ({ id: container.Id, image: container.Image, mounts: container.Mounts, labels: container.Config.Labels })), networks }, null, 2));
        },
        diagnostics: async () => {
          if (ids.length) await composeCommand('Collect owned service logs', ['logs', '--no-color'], { timeout: 5000 });
        },
        teardown: async () => {
          if (ids.length) await command('Remove verified owned containers', docker, ['--context', context, 'rm', '-f', ...ids]);
          for (const id of networks) {
            const [network] = JSON.parse(dockerOutput(['network', 'inspect', id]));
            assert.equal(Object.keys(network.Containers ?? {}).length, 0);
            await command('Remove verified empty fixture network', docker, ['--context', context, 'network', 'rm', id]);
          }
          assert.equal(realpathSync(runtime), owner.runtime);
          assert.equal(JSON.parse(readFileSync(join(runtime, 'ownership.json'), 'utf8')).runId, runId);
          rmSync(join(runtime, 'certificates'), { recursive: true, force: true });
          for (const previous of baseline) {
            assert.equal(dockerOutput(['inspect', previous.id, '--format', '{{.State.StartedAt}}']), previous.started, 'An existing container restarted');
          }
          console.log('Verified cleanup complete. Existing containers remain unchanged.');
        },
        record: (stage, error) => {
          console.error(`Cleanup ${stage} failed: ${error.message}`);
          appendFileSync(join(evidence, 'cleanup-diagnostics.jsonl'), JSON.stringify({ stage, message: error.message }) + '\n');
        },
      });
    } catch (error) {
      process.exitCode = 1;
      console.error(`Cleanup stopped: ${error.message}`);
      if (!primaryFailure) primaryFailure = error;
    }
  }
}

mkdirSync(join(root, 'tests/fullstack/.runtime'), { recursive: true });
await main();
