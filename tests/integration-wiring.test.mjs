import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('all gateway configurations retire Socket.IO and preserve the private session boundary', () => {
  for (const path of ['nginx/nginx.conf', 'nginx/conf/nginx.dev.conf', 'nginx/conf/nginx.prod.conf', 'nginx/ssl/nginx-ssl.conf']) {
    const config = read(path);
    assert.match(config, /location ~\* \^\/chat\/socket\\\.io\(\/\|\$\) \{ return 404; \}/, path);
    assert.match(config, /location = \/ws\/v1 \{[\s\S]*?proxy_pass \$relay_backend;/, path);
    assert.ok(config.includes('location ~* ^/(api/)?user/internal(/|$) { return 404; }'), path);
  }
});

test('the dashboard contains valid panels without the retired Socket.IO gauge', () => {
  const dashboard = JSON.parse(read('observability/grafana/provisioning/dashboards/chat-app.json'));
  assert.ok(dashboard.panels.length > 0);
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) assert.ok(!target.expr?.includes('socket_connections_active'));
  }
});

test('integration CI runs the Go relay through the gateway with disposable separate keys', () => {
  const workflow = read('.github/workflows/integration-tests.yml');
  assert.match(workflow, /docker compose build user chat notification nginx go-websocket/);
  assert.match(workflow, /docker compose up -d --wait --wait-timeout 300 user chat notification go-websocket nginx/);
  assert.match(workflow, /GO_WS_SESSION_KEY=.*openssl rand/);
  assert.match(workflow, /GO_WS_BRIDGE_TOKEN=.*openssl rand/);
  assert.match(workflow, /node tests\/frontend-simulation-test.js/);
  assert.match(workflow, /node tests\/websocket-simulation-test.js/);
  assert.ok(!read('tests/package.json').includes('socket.io'));
  assert.ok(!read('tests/package-lock.json').includes('socket.io'));
  const compose = read('docker-compose.yml');
  assert.match(compose, /go-websocket:\n    build: \.\/websocket-service/);
  assert.match(compose, /GO_WS_SESSION_URL: http:\/\/user:8081\/internal\/ws\/session/);
  assert.match(compose, /GO_WS_BRIDGE_URL: http:\/\/go-websocket:8090\/internal\/messages/);
  assert.ok(!compose.includes('redis:'));
  assert.ok(!compose.includes('REDIS_URL'));
});
