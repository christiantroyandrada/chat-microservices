// Node 22 native WebSocket integration through NGINX. Ciphertext is a fixture;
// browser tests own Signal encryption and the three-second typing expiry.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');

const BASE = process.env.API_URL || 'http://localhost';
const ORIGIN = new URL(BASE).origin;

async function req(method, path, body, cookie) {
  const response = await fetch(new URL(path, BASE), {
    method,
    headers: { Origin: ORIGIN, ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  const cookieHeader = response.headers.get('set-cookie') || '';
  let data;
  try { data = await response.json(); } catch {}
  return { status: response.status, data, cookie: cookieHeader.match(/jwt=[^;]+/)?.[0] };
}

async function register(label) {
  const name = `go_${label}_${randomUUID().slice(0, 8)}`;
  const response = await req('POST', '/user/register', {
    username: name, email: `${name}@example.test`, password: 'DisposableFixtureOnly2026!',
  });
  assert.equal(response.status, 200, `register ${label}`);
  assert.ok(response.cookie, 'registration must establish a real session');
  assert.ok(response.data?.data?.id);
  return { id: response.data.data.id, cookie: response.cookie };
}

function connection(account, sockets) {
  const url = new URL('/ws/v1', BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('expectedUserId', account.id);
  // Node's WebSocketInit supports headers. No browser cookie jar is available here.
  const socket = new WebSocket(url, { headers: { Origin: ORIGIN, Cookie: account.cookie } });
  sockets.push(socket);
  const frames = [];
  let closed = false;
  socket.addEventListener('message', ({ data }) => frames.push(JSON.parse(data)));
  socket.addEventListener('close', () => { closed = true; });
  socket.addEventListener('error', () => { closed = true; });
  return {
    socket,
    frames,
    send: (command) => socket.send(JSON.stringify(command)),
    async next(type, predicate = () => true) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const index = frames.findIndex((frame) => frame.type === type && predicate(frame.data));
        if (index >= 0) return frames.splice(index, 1)[0].data;
        assert.equal(closed, false, `connection closed before ${type}`);
        await delay(20);
      }
      assert.fail(`missing ${type} frame`);
    },
  };
}

async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), 3000);
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.close();
  });
}

const ciphertext = (text) => JSON.stringify({ __encrypted: true, type: 3, body: Buffer.from(text).toString('base64') });

async function send(sender, receiver, message, clientMessageId = randomUUID()) {
  const command = { expectedSenderId: sender.id, receiverId: receiver.id, clientMessageId, message };
  const result = await req('POST', '/chat/send', command, sender.cookie);
  assert.equal(result.status, 200, 'REST command accepted');
  assert.equal(result.data.data.message, message);
  return { command, message: result.data.data };
}

async function history(owner, peer) {
  const result = await req('GET', `/chat/get/${peer.id}?expectedUserId=${owner.id}&limit=50&offset=0`, undefined, owner.cookie);
  assert.equal(result.status, 200);
  return result.data.data;
}

test('Go relay authenticates, delivers REST messages and receipts, and tracks Go presence through NGINX', { timeout: 60000 }, async () => {
  const sockets = [];
  try {
    for (const path of ['/chat/socket.io', '/chat/socket.io/?EIO=4&transport=polling', '/api/user/internal/ws/session', '/user/internal/ws/session']) {
      assert.equal((await req('GET', path)).status, 404, `${path} must stay private or retired`);
    }
    const alice = await register('alice');
    const bob = await register('bob');
    const eve = await register('eve');
    const relayPath = `/ws/v1?expectedUserId=${alice.id}`;
    assert.equal((await req('GET', relayPath)).status, 401);
    assert.equal((await req('GET', relayPath, undefined, 'jwt=invalid')).status, 401);
    assert.equal((await req('GET', relayPath, undefined, bob.cookie)).status, 403);
    const deniedOrigin = await fetch(new URL(relayPath, BASE), { headers: { Origin: 'https://untrusted.invalid', Cookie: alice.cookie }, signal: AbortSignal.timeout(8000) });
    assert.equal(deniedOrigin.status, 403);

    const a = connection(alice, sockets);
    const b = connection(bob, sockets);
    const e = connection(eve, sockets);
    await Promise.all([a.next('ready'), b.next('ready'), e.next('ready')]);
    a.send({ type: 'watchPresence', userId: bob.id });
    assert.deepEqual(await a.next('presence'), { userId: bob.id, online: null });

    const first = await send(alice, bob, ciphertext('alice to bob'));
    const live = await b.next('message');
    assert.equal(live.id, first.message.id);
    assert.equal(live.senderId, alice.id);
    assert.equal(live.receiverId, bob.id);
    assert.equal(live.clientMessageId, first.command.clientMessageId);
    assert.equal(live.message, first.command.message);
    const replay = await req('POST', '/chat/send', first.command, alice.cookie);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.data.id, live.id);
    assert.equal((await req('POST', '/chat/send', { ...first.command, message: ciphertext('different') }, alice.cookie)).status, 409);
    assert.equal((await history(alice, bob)).filter((row) => row.clientMessageId === first.command.clientMessageId).length, 1);
    assert.equal((await history(eve, bob)).length, 0);

    const deliveryPath = `/chat/messages/${live.id}/delivered`;
    assert.equal((await req('PUT', deliveryPath, undefined, bob.cookie)).status, 400);
    assert.equal((await req('PUT', `${deliveryPath}?expectedUserId=${bob.id}`, undefined, alice.cookie)).status, 403);
    assert.equal((await req('PUT', `${deliveryPath}?expectedUserId=${alice.id}`, undefined, alice.cookie)).status, 404);
    assert.equal((await req('PUT', `${deliveryPath}?expectedUserId=${eve.id}`, undefined, eve.cookie)).status, 404);
    assert.equal((await req('PUT', `${deliveryPath}?expectedUserId=${bob.id}`, undefined, bob.cookie)).status, 200);
    assert.deepEqual(await a.next('receipt'), { type: 'delivered', userId: alice.id, by: bob.id, messageId: live.id });
    assert.equal((await history(alice, bob)).find((row) => row.id === live.id).status, 'Delivered');
    assert.equal((await req('PUT', `/chat/messages/read/${alice.id}?expectedUserId=${bob.id}`, undefined, bob.cookie)).status, 200);
    assert.deepEqual(await a.next('receipt'), { type: 'read', userId: alice.id, by: bob.id });
    assert.equal((await history(alice, bob)).find((row) => row.id === live.id).status, 'Seen');

    const reply = await send(bob, alice, ciphertext('bob to alice'));
    assert.equal((await a.next('message')).id, reply.message.id);
    a.send({ type: 'watchPresence', userId: bob.id });
    assert.deepEqual(await a.next('presence'), { userId: bob.id, online: true });
    e.send({ type: 'watchPresence', userId: bob.id });
    assert.deepEqual(await e.next('presence'), { userId: bob.id, online: null });
    for (const isTyping of [true, false]) {
      a.send({ type: 'typing', receiverId: bob.id, isTyping });
      assert.deepEqual(await b.next('typing'), { userId: alice.id, isTyping });
    }
    a.send({ type: 'typing', receiverId: bob.id, userId: eve.id, isTyping: true });
    const unsupported = randomUUID();
    a.send({ type: 'sendMessage', receiverId: bob.id, clientMessageId: unsupported, message: 'forbidden' });
    await delay(250);
    assert.equal(b.frames.some((frame) => frame.type === 'typing' || frame.type === 'message'), false, 'spoofed typing, duplicate sends, and WebSocket send commands must not reach Bob');
    assert.equal(e.frames.some((frame) => frame.type === 'message' || frame.type === 'receipt' || frame.type === 'typing'), false, 'unrelated account must not receive private events');
    assert.equal((await history(alice, bob)).some((row) => row.clientMessageId === unsupported), false);
    for (const invalid of [
      { expectedSenderId: bob.id }, { receiverId: alice.id }, { message: '' }, { message: 'x'.repeat(5001) },
    ]) {
      const result = await req('POST', '/chat/send', { ...first.command, clientMessageId: randomUUID(), ...invalid }, alice.cookie);
      assert.equal(result.status, invalid.expectedSenderId ? 403 : 400);
    }

    const secondTab = connection(bob, sockets);
    await secondTab.next('ready');
    await close(b.socket);
    a.send({ type: 'watchPresence', userId: bob.id });
    assert.deepEqual(await a.next('presence'), { userId: bob.id, online: true });
    await close(secondTab.socket);
    assert.deepEqual(await a.next('presence'), { userId: bob.id, online: false });
    const missed = await send(alice, bob, ciphertext('sent while bob was offline'));
    const reconnected = connection(bob, sockets);
    await reconnected.next('ready');
    assert.deepEqual(await a.next('presence'), { userId: bob.id, online: true });
    assert.equal((await history(bob, alice)).find((row) => row.id === missed.message.id).message, missed.command.message);
  } finally {
    await Promise.all(sockets.map(close));
  }
});
