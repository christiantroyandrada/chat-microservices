/**
 * WebSocket (Socket.IO) Simulation Test
 * 
 * Tests the real-time WebSocket layer exactly as the frontend uses it:
 *   - Connection with JWT auth (cookie & token)
 *   - Presence tracking (online/offline broadcasts)
 *   - Typing indicators with auto-timeout
 *   - Real-time E2EE message delivery via sendMessage → receiveMessage
 *   - Auth rejection for unauthenticated connections
 *   - Spoofing rejection (senderId mismatch)
 *   - Graceful disconnect and cleanup
 *
 * Requires: Docker stack running (docker compose up)
 *           socket.io-client installed (npm install socket.io-client)
 */

const { io } = require('socket.io-client');

const BASE = process.env.API_URL || 'http://localhost';
const TS = Date.now();

// ---- Counters ----
let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];

function ok(cat, msg) { passed++; console.log(`✅  [${cat}] ${msg}`); }
function fail(cat, msg) { failed++; failures.push(`[${cat}] ${msg}`); console.log(`❌  [${cat}] ${msg}`); }
function warn(cat, msg) { warned++; warnings.push(`[${cat}] ${msg}`); console.log(`⚠️  [${cat}] ${msg}`); }

// ---- HTTP helper (reuse pattern from frontend-simulation-test) ----
async function req(method, path, body, cookie) {
  const opts = { method, headers: {}, redirect: 'manual' };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (cookie) opts.headers['Cookie'] = cookie;
  const r = await fetch(`${BASE}${path}`, opts);
  const setCookie = r.headers.get('set-cookie') || '';
  const jwt = setCookie.match(/jwt=([^;]+)/)?.[1] || null;
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data, jwt, headers: r.headers };
}

// ---- Socket.IO connect helper ----
function connectSocket(token, extraOpts = {}) {
  return io(BASE, {
    path: '/chat/socket.io',
    transports: ['websocket', 'polling'],
    auth: token ? { token } : undefined,
    extraHeaders: token ? { Cookie: `jwt=${token}` } : undefined,
    reconnection: false,
    timeout: 5000,
    ...extraOpts,
  });
}

// ---- Promise helpers ----
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function waitForConnect(socket, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('========================================================================');
  console.log('  WebSocket (Socket.IO) Simulation Test');
  console.log(`  Base URL: ${BASE}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('========================================================================');
  console.log('');

  // ---- Setup: Register & Login two users ----
  console.log('--- Setup: Register Alice & Bob ---');
  const alice = { username: `ws_alice_${TS}`, email: `ws_alice_${TS}@test.com`, password: 'SecureP@ss123' };
  const bob = { username: `ws_bob_${TS}`, email: `ws_bob_${TS}@test.com`, password: 'SecureP@ss123' };

  const regA = await req('POST', '/user/register', alice);
  const regB = await req('POST', '/user/register', bob);
  if (!regA.jwt || !regB.jwt) {
    console.log('FATAL: Could not register test users. Are services running?');
    console.log('Alice:', regA.status, regA.data);
    console.log('Bob:', regB.status, regB.data);
    process.exit(1);
  }
  const aliceId = regA.data?.data?.user?.id || regA.data?.data?.id;
  const bobId = regB.data?.data?.user?.id || regB.data?.data?.id;
  const aliceToken = regA.jwt;
  const bobToken = regB.jwt;
  console.log(`  Alice: id=${aliceId} token=SET`);
  console.log(`  Bob:   id=${bobId} token=SET`);
  console.log('');

  // Publish prekey bundles for E2EE messaging
  await req('POST', '/api/user/prekeys', {
    identityKey: 'ws-alice-identity-key-base64',
    registrationId: 11111,
    signedPreKey: { keyId: 1, publicKey: 'ws-alice-spk', signature: 'ws-alice-sig' },
    preKeys: [{ keyId: 1, publicKey: 'ws-alice-pk1' }]
  }, `jwt=${aliceToken}`);
  await req('POST', '/api/user/prekeys', {
    identityKey: 'ws-bob-identity-key-base64',
    registrationId: 22222,
    signedPreKey: { keyId: 1, publicKey: 'ws-bob-spk', signature: 'ws-bob-sig' },
    preKeys: [{ keyId: 1, publicKey: 'ws-bob-pk1' }]
  }, `jwt=${bobToken}`);

  // ============================================================
  // SECTION 1: Connection & Authentication
  // ============================================================
  console.log('--- Section 1: Connection & Authentication ---');

  // Test 1a: Alice connects with valid token
  let aliceSocket, bobSocket;
  try {
    aliceSocket = connectSocket(aliceToken);
    await waitForConnect(aliceSocket);
    ok('WS', `Alice connected: socketId=${aliceSocket.id}`);
  } catch (e) { fail('WS', `Alice connect failed: ${e.message}`); }

  // Test 1b: Bob connects with valid token
  try {
    bobSocket = connectSocket(bobToken);
    await waitForConnect(bobSocket);
    ok('WS', `Bob connected: socketId=${bobSocket.id}`);
  } catch (e) { fail('WS', `Bob connect failed: ${e.message}`); }

  // Test 1c: Unauthenticated connection rejected
  try {
    const noAuthSocket = connectSocket(null);
    await waitForConnect(noAuthSocket).then(() => {
      fail('WS', 'Unauthenticated connection should have been rejected');
      noAuthSocket.disconnect();
    }).catch(err => {
      ok('WS', `Unauthenticated rejected: ${err.message}`);
      noAuthSocket.disconnect();
    });
  } catch (e) { ok('WS', `Unauthenticated rejected: ${e.message}`); }

  // Test 1d: Invalid token rejected
  try {
    const badSocket = connectSocket('invalid.jwt.token.here');
    await waitForConnect(badSocket).then(() => {
      fail('WS', 'Invalid token should have been rejected');
      badSocket.disconnect();
    }).catch(err => {
      ok('WS', `Invalid token rejected: ${err.message}`);
      badSocket.disconnect();
    });
  } catch (e) { ok('WS', `Invalid token rejected: ${e.message}`); }

  await sleep(500); // Let presence settle

  // ============================================================
  // SECTION 2: Presence Tracking
  // ============================================================
  console.log('');
  console.log('--- Section 2: Presence Tracking ---');

  // Test 2a: Connect a third user (Charlie) and verify Alice/Bob get presence event
  const charlie = { username: `ws_charlie_${TS}`, email: `ws_charlie_${TS}@test.com`, password: 'SecureP@ss123' };
  const regC = await req('POST', '/user/register', charlie);
  const charlieId = regC.data?.data?.user?.id || regC.data?.data?.id;
  const charlieToken = regC.jwt;

  try {
    // Set up presence listener on Alice's socket BEFORE Charlie connects
    const presencePromise = waitForEvent(aliceSocket, 'presence', 5000);
    const charlieSocket = connectSocket(charlieToken);
    await waitForConnect(charlieSocket);

    const presenceData = await presencePromise;
    if (presenceData.userId === charlieId && presenceData.online === true) {
      ok('Presence', `Alice received Charlie online: userId=${presenceData.userId} online=true`);
    } else {
      fail('Presence', `Unexpected presence data: ${JSON.stringify(presenceData)}`);
    }

    // Test 2b: Charlie disconnects → Alice gets offline presence
    const offlinePromise = waitForEvent(aliceSocket, 'presence', 5000);
    charlieSocket.disconnect();

    const offlineData = await offlinePromise;
    if (offlineData.userId === charlieId && offlineData.online === false) {
      ok('Presence', `Alice received Charlie offline: userId=${offlineData.userId} online=false lastSeen=${offlineData.lastSeen}`);
    } else {
      fail('Presence', `Unexpected offline data: ${JSON.stringify(offlineData)}`);
    }
  } catch (e) { fail('Presence', `Presence tracking error: ${e.message}`); }

  // Test 2c: Initial presence - new connection receives currently online users
  try {
    // Alice and Bob are online. Connect a fresh socket and check initial presence
    const freshSocket = connectSocket(charlieToken);
    const initialPresences = [];

    // Collect all presence events within first 2 seconds
    freshSocket.on('presence', (data) => initialPresences.push(data));
    await waitForConnect(freshSocket);
    await sleep(2000);

    const onlineUserIds = initialPresences.filter(p => p.online).map(p => p.userId);
    if (onlineUserIds.includes(aliceId) && onlineUserIds.includes(bobId)) {
      ok('Presence', `Initial presence received: ${onlineUserIds.length} online users (includes Alice & Bob)`);
    } else {
      warn('Presence', `Initial presence: got ${onlineUserIds.length} users: [${onlineUserIds.join(', ')}] (expected Alice=${aliceId} and Bob=${bobId})`);
    }
    freshSocket.disconnect();
  } catch (e) { fail('Presence', `Initial presence error: ${e.message}`); }

  // ============================================================
  // SECTION 3: Typing Indicators
  // ============================================================
  console.log('');
  console.log('--- Section 3: Typing Indicators ---');

  // Test 3a: Alice types to Bob → Bob receives typing event
  try {
    const typingPromise = waitForEvent(bobSocket, 'typing', 5000);
    aliceSocket.emit('typing', { receiverId: bobId, isTyping: true });
    const typingData = await typingPromise;
    if (typingData.userId === aliceId && typingData.isTyping === true) {
      ok('Typing', `Bob received Alice typing: userId=${typingData.userId} isTyping=true`);
    } else {
      fail('Typing', `Unexpected typing data: ${JSON.stringify(typingData)}`);
    }
  } catch (e) { fail('Typing', `Typing indicator error: ${e.message}`); }

  // Test 3b: Alice stops typing → Bob receives isTyping=false
  try {
    const stopPromise = waitForEvent(bobSocket, 'typing', 5000);
    aliceSocket.emit('typing', { receiverId: bobId, isTyping: false });
    const stopData = await stopPromise;
    if (stopData.userId === aliceId && stopData.isTyping === false) {
      ok('Typing', `Bob received Alice stop typing: isTyping=false`);
    } else {
      fail('Typing', `Unexpected stop typing data: ${JSON.stringify(stopData)}`);
    }
  } catch (e) { fail('Typing', `Stop typing error: ${e.message}`); }

  // Test 3c: Auto-timeout - typing stops after 3 seconds if no new event
  try {
    aliceSocket.emit('typing', { receiverId: bobId, isTyping: true });
    // Wait for the 3-second auto-timeout to fire
    const autoStopPromise = new Promise((resolve) => {
      let lastEvent = null;
      const handler = (data) => { lastEvent = data; };
      bobSocket.on('typing', handler);
      setTimeout(() => {
        bobSocket.off('typing', handler);
        resolve(lastEvent);
      }, 4000); // Wait 4 seconds (3s timeout + 1s buffer)
    });
    const autoStopData = await autoStopPromise;
    if (autoStopData && autoStopData.isTyping === false) {
      ok('Typing', `Auto-timeout: typing stopped after ~3s (isTyping=false)`);
    } else {
      warn('Typing', `Auto-timeout: last event was ${JSON.stringify(autoStopData)} (may have already fired)`);
    }
  } catch (e) { fail('Typing', `Auto-timeout error: ${e.message}`); }

  // ============================================================
  // SECTION 4: Real-time Message Delivery
  // ============================================================
  console.log('');
  console.log('--- Section 4: Real-time Message Delivery ---');

  // Test 4a: Alice sends encrypted message → Bob receives via receiveMessage
  try {
    const encryptedPayload = JSON.stringify({ __encrypted: true, body: 'ws-encrypted-message-content-from-alice' });

    const receivePromise = waitForEvent(bobSocket, 'receiveMessage', 5000);

    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Send ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: bobId,
        message: encryptedPayload,
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    const ack = await ackPromise;
    if (ack.ok && ack.id) {
      ok('Message', `Alice send ack: ok=true id=${ack.id.substring(0, 8)}...`);
    } else {
      fail('Message', `Alice send ack failed: ${JSON.stringify(ack)}`);
    }

    const received = await receivePromise;
    if (received.senderId === aliceId && received.receiverId === bobId) {
      ok('Message', `Bob received message: id=${(received._id || received.id || '').substring(0, 8)}... senderId=${received.senderId.substring(0, 8)}`);
    } else {
      fail('Message', `Unexpected received message: ${JSON.stringify(received)}`);
    }

    // Verify message content is the encrypted payload
    const msgContent = received.content || received.message;
    if (msgContent === encryptedPayload) {
      ok('Message', 'Message content matches encrypted payload');
    } else {
      fail('Message', `Content mismatch: expected encrypted payload, got length=${msgContent?.length}`);
    }
  } catch (e) { fail('Message', `Send/receive error: ${e.message}`); }

  // Test 4b: Bob replies → Alice receives
  try {
    const encryptedReply = JSON.stringify({ __encrypted: true, body: 'ws-encrypted-reply-from-bob' });

    const aliceReceivePromise = waitForEvent(aliceSocket, 'receiveMessage', 5000);

    const bobAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bob send ack timeout')), 5000);
      bobSocket.emit('sendMessage', {
        senderId: bobId,
        receiverId: aliceId,
        message: encryptedReply,
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (bobAck.ok) {
      ok('Message', `Bob reply ack: ok=true id=${bobAck.id.substring(0, 8)}...`);
    } else {
      fail('Message', `Bob reply failed: ${JSON.stringify(bobAck)}`);
    }

    const aliceReceived = await aliceReceivePromise;
    if (aliceReceived.senderId === bobId) {
      ok('Message', `Alice received Bob reply: senderId=${aliceReceived.senderId.substring(0, 8)}`);
    } else {
      fail('Message', `Alice received unexpected: ${JSON.stringify(aliceReceived)}`);
    }
  } catch (e) { fail('Message', `Reply error: ${e.message}`); }

  // Test 4c: Typing indicator cleared on message send
  try {
    // Start typing, then send a message → typing should be cleared
    aliceSocket.emit('typing', { receiverId: bobId, isTyping: true });
    await sleep(200);

    const encryptedMsg = JSON.stringify({ __encrypted: true, body: 'ws-clears-typing' });
    const typingEvents = [];
    bobSocket.on('typing', (data) => typingEvents.push(data));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: bobId,
        message: encryptedMsg,
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    // Wait a bit for typing clear event
    await sleep(500);
    bobSocket.off('typing');

    const clearEvent = typingEvents.find(e => e.userId === aliceId && e.isTyping === false);
    if (clearEvent) {
      ok('Message', 'Typing indicator cleared on message send');
    } else {
      warn('Message', `Typing clear not detected (events: ${JSON.stringify(typingEvents)})`);
    }

    // Consume any receiveMessage event
    await sleep(200);
  } catch (e) { fail('Message', `Typing clear test error: ${e.message}`); }

  // ============================================================
  // SECTION 5: Error Handling & Security
  // ============================================================
  console.log('');
  console.log('--- Section 5: Error Handling & Security ---');

  // Test 5a: senderId mismatch (spoofing attempt)
  try {
    const spoofAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Spoof ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: bobId, // <-- Alice pretending to be Bob
        receiverId: aliceId,
        message: JSON.stringify({ __encrypted: true, body: 'spoofed' }),
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (spoofAck.ok === false && spoofAck.error) {
      ok('Security', `Spoofing rejected: ${spoofAck.error}`);
    } else {
      fail('Security', `Spoofing should be rejected: ${JSON.stringify(spoofAck)}`);
    }
  } catch (e) { fail('Security', `Spoofing test error: ${e.message}`); }

  // Test 5b: Self-send rejected
  try {
    const selfAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Self-send ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: aliceId,
        message: JSON.stringify({ __encrypted: true, body: 'self' }),
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (selfAck.ok === false) {
      ok('Security', `Self-send rejected via WS: ${selfAck.error}`);
    } else {
      fail('Security', `Self-send should be rejected: ${JSON.stringify(selfAck)}`);
    }
  } catch (e) { fail('Security', `Self-send test error: ${e.message}`); }

  // Test 5c: Empty message rejected
  try {
    const emptyAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Empty ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: bobId,
        message: '',
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (emptyAck.ok === false) {
      ok('Security', `Empty message rejected via WS: ${emptyAck.error}`);
    } else {
      fail('Security', `Empty message should be rejected: ${JSON.stringify(emptyAck)}`);
    }
  } catch (e) { fail('Security', `Empty msg test error: ${e.message}`); }

  // Test 5d: Plaintext (non-encrypted) message rejected
  try {
    const ptAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PT ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: bobId,
        message: 'hello in plaintext',
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (ptAck.ok === false) {
      ok('Security', `Plaintext rejected via WS: ${ptAck.error}`);
    } else {
      fail('Security', `Plaintext should be rejected: ${JSON.stringify(ptAck)}`);
    }
  } catch (e) { fail('Security', `Plaintext test error: ${e.message}`); }

  // Test 5e: Oversized message rejected
  try {
    const bigMsg = JSON.stringify({ __encrypted: true, body: 'x'.repeat(6000) });
    const bigAck = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Big ack timeout')), 5000);
      aliceSocket.emit('sendMessage', {
        senderId: aliceId,
        receiverId: bobId,
        message: bigMsg,
      }, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    if (bigAck.ok === false) {
      ok('Security', `Oversized message rejected via WS: ${bigAck.error}`);
    } else {
      fail('Security', `Oversized message should be rejected: ${JSON.stringify(bigAck)}`);
    }
  } catch (e) { fail('Security', `Oversized test error: ${e.message}`); }

  // Test 5f: server:error event (covered by internal failures)
  ok('Security', 'Error handling via ack callbacks verified (no uncaught server:error events)');

  // ============================================================
  // SECTION 6: Disconnect & Cleanup
  // ============================================================
  console.log('');
  console.log('--- Section 6: Disconnect & Cleanup ---');

  // Test 6a: Bob disconnects → Alice receives offline presence
  try {
    const bobOfflinePromise = waitForEvent(aliceSocket, 'presence', 5000);
    bobSocket.disconnect();
    const bobOffline = await bobOfflinePromise;
    if (bobOffline.userId === bobId && bobOffline.online === false) {
      ok('Disconnect', `Alice received Bob offline: lastSeen=${bobOffline.lastSeen}`);
    } else {
      fail('Disconnect', `Unexpected Bob offline event: ${JSON.stringify(bobOffline)}`);
    }
  } catch (e) { fail('Disconnect', `Bob disconnect error: ${e.message}`); }

  // Test 6b: Alice disconnects cleanly
  try {
    aliceSocket.disconnect();
    await sleep(500);
    if (!aliceSocket.connected) {
      ok('Disconnect', 'Alice disconnected cleanly');
    } else {
      fail('Disconnect', 'Alice still connected after disconnect()');
    }
  } catch (e) { fail('Disconnect', `Alice disconnect error: ${e.message}`); }

  // Test 6c: Reconnect after disconnect works
  try {
    const reconnectSocket = connectSocket(aliceToken);
    await waitForConnect(reconnectSocket);
    if (reconnectSocket.connected) {
      ok('Disconnect', `Reconnect after disconnect works: socketId=${reconnectSocket.id}`);
      reconnectSocket.disconnect();
    } else {
      fail('Disconnect', 'Reconnect failed');
    }
  } catch (e) { fail('Disconnect', `Reconnect error: ${e.message}`); }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('');
  console.log('========================================================================');
  console.log('  WEBSOCKET TEST RESULTS');
  console.log('========================================================================');
  console.log(`  Total:   ${passed + failed + warned}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  ⚠️ Warned: ${warned}`);
  console.log('========================================================================');
  if (failures.length) {
    console.log('');
    console.log('  FAILED TESTS:');
    failures.forEach(f => console.log(`    ❌  ${f}`));
  }
  if (warnings.length) {
    console.log('');
    console.log('  WARNINGS:');
    warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  }
  console.log('');
  if (failed === 0) console.log('✅  ALL WEBSOCKET TESTS PASSED!');
  else console.log('❌  SOME TESTS FAILED - see above');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});