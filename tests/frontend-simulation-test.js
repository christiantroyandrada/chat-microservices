/**
 * Frontend Simulation Integration Test
 * =====================================
 * Tests every backend API endpoint exactly as the SvelteKit frontend calls them.
 * Simulates two users: Alice and Bob in a full chat session lifecycle.
 *
 * Tested endpoints (mapped from frontend services):
 *
 * auth.service.ts:
 *   POST /user/register
 *   POST /user/login
 *   GET  /user/me
 *   POST /user/logout
 *   POST /user/signal-keys
 *   GET  /user/signal-keys?deviceId=...
 *
 * chat.service.ts:
 *   GET  /chat/conversations
 *   GET  /chat/get/:userId?limit=&offset=
 *   POST /chat/send
 *   PUT  /chat/messages/read/:senderId
 *   GET  /user/search?q=...
 *   GET  /api/user/prekeys/:userId
 *   POST /api/user/prekeys
 *
 * notification.service.ts:
 *   GET    /notifications/?limit=&offset=
 *   GET    /notifications/unread/count
 *   PUT    /notifications/:id/read
 *   PUT    /notifications/read-all
 *   DELETE /notifications/:id
 *   POST   /notifications
 *
 * websocket.service.ts:
 *   Socket.IO connect (path: /chat/socket.io)
 *   Event: sendMessage
 *   Event: typing
 *   Event: receiveMessage (listen)
 *   Event: presence (listen)
 *
 * Health checks:
 *   GET /health (nginx)
 *   GET /api/user/health (user-service)
 *   GET /chat/health (chat-service)
 *   GET /notifications/health (notification-service)
 */

const BASE = process.env.API_URL || 'http://localhost';
const PASS_ICON = '\u2705';
const FAIL_ICON = '\u274C';
const WARN_ICON = '\u26A0\uFE0F';
const SKIP_ICON = '\u23ED\uFE0F';

let passed = 0, failed = 0, warned = 0, skipped = 0;
const results = [];

function log(icon, section, detail) {
  const line = `${icon}  [${section}] ${detail}`;
  console.log(line);
  results.push({ icon, line });
}

function ok(section, detail) { passed++; log(PASS_ICON, section, detail); }
function fail(section, detail) { failed++; log(FAIL_ICON, section, detail); }
function warn(section, detail) { warned++; log(WARN_ICON, section, detail); }
function skip(section, detail) { skipped++; log(SKIP_ICON, section, detail); }

// --- HTTP helpers ---
async function req(method, path, body, cookies, extraHeaders) {
  const url = BASE + path;
  const headers = { ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookies) headers['Cookie'] = cookies;

  const opts = { method, headers, redirect: 'manual' };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  let data = null;
  try {
    const text = await resp.text();
    data = text ? JSON.parse(text) : {};
  } catch { data = {}; }

  return { status: resp.status, data, cookies: setCookies, headers: resp.headers };
}

function extractJwtCookie(setCookies) {
  for (const c of setCookies) {
    if (c.startsWith('jwt=')) {
      return c.split(';')[0];
    }
  }
  return null;
}

// --- Test runner ---
async function run() {
  console.log('');
  console.log('='.repeat(72));
  console.log('  Frontend Simulation Integration Test');
  console.log(`  Base URL: ${BASE}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('='.repeat(72));
  console.log('');

  const ts = Date.now();
  const alice = { username: `alice_${ts}`, email: `alice_${ts}@test.com`, password: 'AlicePass123!' };
  const bob   = { username: `bob_${ts}`, email: `bob_${ts}@test.com`, password: 'BobPass123!' };

  let aliceCookie = null;
  let bobCookie = null;
  let aliceId = null;
  let bobId = null;

  // ============================================================
  // SECTION 1: HEALTH CHECKS
  // ============================================================
  console.log('--- Section 1: Health Checks ---');

  try {
    const r = await req('GET', '/health');
    if (r.status === 200 && r.data.status === 'ok') ok('Health', `nginx /health -> ${r.data.service}`);
    else fail('Health', `nginx /health unexpected: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Health', `nginx /health: ${e.message}`); }

  try {
    const r = await req('GET', '/api/user/health');
    if (r.status === 200 && r.data.status === 'ok' && r.data.checks?.database && r.data.checks?.rabbitmq)
      ok('Health', `user-service -> DB:${r.data.checks.database} RMQ:${r.data.checks.rabbitmq}`);
    else fail('Health', `user-service health unexpected: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Health', `user-service: ${e.message}`); }

  try {
    const r = await req('GET', '/chat/health');
    if (r.status === 200 && r.data.status === 'ok' && r.data.checks?.database && r.data.checks?.rabbitmq)
      ok('Health', `chat-service -> DB:${r.data.checks.database} RMQ:${r.data.checks.rabbitmq}`);
    else fail('Health', `chat-service health: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Health', `chat-service: ${e.message}`); }

  try {
    const r = await req('GET', '/notifications/health');
    if (r.status === 200 && r.data.status === 'ok' && r.data.checks?.database && r.data.checks?.rabbitmq)
      ok('Health', `notification-service -> DB:${r.data.checks.database} RMQ:${r.data.checks.rabbitmq}`);
    else fail('Health', `notification-service health: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Health', `notification-service: ${e.message}`); }

  // ============================================================
  // SECTION 2: AUTH (auth.service.ts)
  // ============================================================
  console.log('');
  console.log('--- Section 2: Authentication ---');

  // 2a. Register Alice
  try {
    const r = await req('POST', '/user/register', alice);
    if (r.status === 200 && r.data?.data?.id) {
      aliceId = r.data.data.id;
      aliceCookie = extractJwtCookie(r.cookies);
      if (aliceCookie) ok('Auth', `Register Alice -> id=${aliceId.substring(0,8)}... cookie=SET`);
      else warn('Auth', 'Register Alice OK but no jwt cookie in getSetCookie');
    } else {
      fail('Auth', `Register Alice: status=${r.status} body=${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `Register Alice: ${e.message}`); }

  // 2b. Duplicate registration (should fail)
  try {
    const r = await req('POST', '/user/register', alice);
    if (r.status >= 400) ok('Auth', `Duplicate register rejected: status=${r.status} msg=${r.data?.message || ''}`);
    else fail('Auth', `Duplicate register should fail: ${r.status}`);
  } catch (e) { fail('Auth', `Duplicate register: ${e.message}`); }

  // 2c. Invalid registration (missing fields)
  try {
    const r = await req('POST', '/user/register', { email: 'bad@test.com' });
    if (r.status >= 400) ok('Auth', `Invalid register rejected (missing fields): status=${r.status}`);
    else fail('Auth', `Invalid register should fail: ${r.status}`);
  } catch (e) { fail('Auth', `Invalid register: ${e.message}`); }

  // 2d. Invalid username (spaces, special chars)
  try {
    const r = await req('POST', '/user/register', { username: 'bad user!', email: 'x@x.com', password: 'Pass123!' });
    if (r.status >= 400) ok('Auth', `Bad username rejected: status=${r.status}`);
    else fail('Auth', `Bad username should fail: ${r.status}`);
  } catch (e) { fail('Auth', `Bad username: ${e.message}`); }

  // 2e. Register Bob
  try {
    const r = await req('POST', '/user/register', bob);
    if (r.status === 200 && r.data?.data?.id) {
      bobId = r.data.data.id;
      bobCookie = extractJwtCookie(r.cookies);
      ok('Auth', `Register Bob -> id=${bobId.substring(0,8)}...`);
    } else {
      fail('Auth', `Register Bob: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `Register Bob: ${e.message}`); }

  // 2f. Login Alice
  try {
    const r = await req('POST', '/user/login', { email: alice.email, password: alice.password });
    if (r.status === 200) {
      const cookie = extractJwtCookie(r.cookies);
      if (cookie) aliceCookie = cookie;
      ok('Auth', `Login Alice -> cookie=${aliceCookie ? 'SET' : 'MISSING'}`);
    } else {
      fail('Auth', `Login Alice: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `Login Alice: ${e.message}`); }

  // Login Bob
  try {
    const r = await req('POST', '/user/login', { email: bob.email, password: bob.password });
    if (r.status === 200) {
      const cookie = extractJwtCookie(r.cookies);
      if (cookie) bobCookie = cookie;
      ok('Auth', `Login Bob -> cookie=${bobCookie ? 'SET' : 'MISSING'}`);
    } else {
      fail('Auth', `Login Bob: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `Login Bob: ${e.message}`); }

  // 2g. Login wrong password
  try {
    const r = await req('POST', '/user/login', { email: alice.email, password: 'WrongPass!' });
    if (r.status === 401) ok('Auth', 'Wrong password rejected: 401');
    else fail('Auth', `Wrong password should be 401, got: ${r.status}`);
  } catch (e) { fail('Auth', `Wrong password: ${e.message}`); }

  // 2h. Login non-existent email
  try {
    const r = await req('POST', '/user/login', { email: 'nobody@nowhere.com', password: 'Pass123!' });
    if (r.status === 401) ok('Auth', 'Non-existent user rejected: 401');
    else fail('Auth', `Non-existent user should be 401, got: ${r.status}`);
  } catch (e) { fail('Auth', `Non-existent user: ${e.message}`); }

  // Guard: if no cookies, we cannot continue authenticated tests
  if (!aliceCookie || !bobCookie) {
    fail('Auth', 'CRITICAL: Missing JWT cookies. Cannot continue authenticated tests.');
    printSummary();
    return;
  }

  // 2i. Get current user (auth.service.ts -> getCurrentUser)
  try {
    const r = await req('GET', '/user/me', null, aliceCookie);
    if (r.status === 200 && r.data?.data?.username === alice.username) {
      ok('Auth', `GET /user/me -> username=${r.data.data.username} email=${r.data.data.email}`);
    } else {
      fail('Auth', `GET /user/me: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `/user/me: ${e.message}`); }

  // 2j. /user/me WITHOUT cookie (should 401)
  try {
    const r = await req('GET', '/user/me');
    if (r.status === 401 || r.status === 403) ok('Auth', `GET /user/me unauthenticated: ${r.status}`);
    else fail('Auth', `GET /user/me unauthenticated should be 401/403, got: ${r.status}`);
  } catch (e) { fail('Auth', `/user/me unauth: ${e.message}`); }

  // ============================================================
  // SECTION 3: USER SEARCH (chat.service.ts -> searchUsers)
  // ============================================================
  console.log('');
  console.log('--- Section 3: User Search ---');

  try {
    const r = await req('GET', `/user/search?q=${bob.username}`, null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data)) {
      const found = r.data.data.find(u => u.username === bob.username || u._id === bobId);
      if (found) ok('Search', `Alice found Bob: ${found.username}`);
      else fail('Search', `Bob not in results: ${JSON.stringify(r.data.data)}`);
    } else {
      fail('Search', `Search Bob: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Search', `Search Bob: ${e.message}`); }

  // Search should NOT return self
  try {
    const r = await req('GET', `/user/search?q=${alice.username}`, null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data)) {
      const selfFound = r.data.data.find(u => u._id === aliceId);
      if (!selfFound) ok('Search', 'Self not in search results (correct)');
      else fail('Search', 'Self should not appear in search results');
    }
  } catch (e) { fail('Search', `Self search: ${e.message}`); }

  // Empty search
  try {
    const r = await req('GET', '/user/search?q=', null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data) && r.data.data.length === 0)
      ok('Search', 'Empty query returns empty array');
    else warn('Search', `Empty query: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Search', `Empty search: ${e.message}`); }

  // Search without auth
  try {
    const r = await req('GET', '/user/search?q=bob');
    if (r.status === 401 || r.status === 403) ok('Search', `Unauthenticated search rejected: ${r.status}`);
    else fail('Search', `Unauthenticated search should fail: ${r.status}`);
  } catch (e) { fail('Search', `Unauth search: ${e.message}`); }

  // ============================================================
  // SECTION 4: SIGNAL PROTOCOL KEYS (auth.service.ts)
  // ============================================================
  console.log('');
  console.log('--- Section 4: Signal Protocol Keys ---');

  const alicePrekey = {
    userId: aliceId,
    deviceId: 'device_alice_1',
    bundle: {
      registrationId: 12345,
      identityKey: btoa('alice-identity-key-fake-32bytes!'),
      signedPreKey: {
        keyId: 1,
        publicKey: btoa('alice-signed-prekey-pubkey-data!'),
        signature: btoa('alice-signed-prekey-signature!!!')
      },
      preKeys: [
        { keyId: 1, publicKey: btoa('alice-prekey-1-public-key-data!') },
        { keyId: 2, publicKey: btoa('alice-prekey-2-public-key-data!') }
      ]
    }
  };

  try {
    const r = await req('POST', '/api/user/prekeys', alicePrekey, aliceCookie);
    if (r.status === 200 || r.status === 201) ok('Signal', `Publish Alice prekey bundle: ${r.status}`);
    else fail('Signal', `Publish prekey: status=${r.status} body=${JSON.stringify(r.data)}`);
  } catch (e) { fail('Signal', `Publish prekey: ${e.message}`); }

  const bobPrekey = {
    userId: bobId,
    deviceId: 'device_bob_1',
    bundle: {
      registrationId: 67890,
      identityKey: btoa('bob-identity-key-fake-32-bytes!'),
      signedPreKey: {
        keyId: 1,
        publicKey: btoa('bob-signed-prekey-pubkey-data!!'),
        signature: btoa('bob-signed-prekey-signature!!!!!')
      },
      preKeys: [
        { keyId: 1, publicKey: btoa('bob-prekey-1-public-key-data!!!') }
      ]
    }
  };

  try {
    const r = await req('POST', '/api/user/prekeys', bobPrekey, bobCookie);
    if (r.status === 200 || r.status === 201) ok('Signal', `Publish Bob prekey bundle: ${r.status}`);
    else fail('Signal', `Publish Bob prekey: status=${r.status} body=${JSON.stringify(r.data)}`);
  } catch (e) { fail('Signal', `Publish Bob prekey: ${e.message}`); }

  // Fetch Bob's prekey bundle as Alice
  try {
    const r = await req('GET', `/api/user/prekeys/${bobId}`, null, aliceCookie);
    if (r.status === 200 && r.data?.data?.bundle) {
      ok('Signal', `Fetch Bob prekey bundle: regId=${r.data.data.bundle.registrationId || 'N/A'}`);
    } else {
      fail('Signal', `Fetch Bob prekey: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Signal', `Fetch Bob prekey: ${e.message}`); }

  // Store encrypted Signal keys
  const fakeEncryptedBundle = {
    deviceId: 'device_alice_1',
    encryptedBundle: {
      encrypted: btoa('fake-encrypted-key-data-for-testing-purposes-only'),
      iv: btoa('fake-iv-12bytes!'),
      salt: btoa('fake-salt-16bytes!!!'),
      version: 1,
      deviceId: 'device_alice_1'
    }
  };

  try {
    const r = await req('POST', '/user/signal-keys', fakeEncryptedBundle, aliceCookie);
    if (r.status === 200 || r.status === 201) ok('Signal', `Store encrypted Signal keys: ${r.status}`);
    else fail('Signal', `Store Signal keys: ${r.status} ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Signal', `Store Signal keys: ${e.message}`); }

  // Fetch encrypted Signal keys
  try {
    const r = await req('GET', '/user/signal-keys?deviceId=device_alice_1', null, aliceCookie);
    if (r.status === 200 && r.data?.data?.encryptedBundle) {
      ok('Signal', `Fetch Signal keys: version=${r.data.data.encryptedBundle.version || 'N/A'}`);
    } else if (r.status === 404) {
      warn('Signal', 'Fetch Signal keys: 404 (keys not found)');
    } else {
      fail('Signal', `Fetch Signal keys: ${r.status} ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Signal', `Fetch Signal keys: ${e.message}`); }

  // ============================================================
  // SECTION 5: E2EE MESSAGING (chat.service.ts)
  // ============================================================
  console.log('');
  console.log('--- Section 5: E2EE Messaging ---');

  const encryptedEnvelope = JSON.stringify({
    __encrypted: true,
    type: 3,
    body: btoa('simulated-ciphertext-from-alice-to-bob-encrypted-with-signal-protocol')
  });

  let sentMessageId = null;
  // 5a. Send encrypted message Alice->Bob
  try {
    const r = await req('POST', '/chat/send', { receiverId: bobId, message: encryptedEnvelope }, aliceCookie);
    if (r.status === 200 && r.data?.data?.id) {
      sentMessageId = r.data.data.id;
      ok('Chat', `Send encrypted msg A->B: id=${sentMessageId.substring(0,8)}... isEncrypted=${r.data.data.isEncrypted}`);
    } else {
      fail('Chat', `Send msg: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Chat', `Send msg: ${e.message}`); }

  // 5b. Send plaintext message (should REJECT)
  try {
    const r = await req('POST', '/chat/send', { receiverId: bobId, message: 'hello plaintext' }, aliceCookie);
    if (r.status >= 400) ok('Chat', `Plaintext rejected: ${r.status} ${r.data?.message || ''}`);
    else fail('Chat', `Plaintext should be rejected: ${r.status}`);
  } catch (e) { fail('Chat', `Plaintext rejection: ${e.message}`); }

  // 5c. Send to self (should fail)
  try {
    const r = await req('POST', '/chat/send', { receiverId: aliceId, message: encryptedEnvelope }, aliceCookie);
    if (r.status >= 400) ok('Chat', `Self-send rejected: ${r.status}`);
    else fail('Chat', `Self-send should fail: ${r.status}`);
  } catch (e) { fail('Chat', `Self-send: ${e.message}`); }

  // 5d. Unauth send
  try {
    const r = await req('POST', '/chat/send', { receiverId: bobId, message: encryptedEnvelope });
    if (r.status === 401 || r.status === 403) ok('Chat', `Unauth send rejected: ${r.status}`);
    else fail('Chat', `Unauth send should fail: ${r.status}`);
  } catch (e) { fail('Chat', `Unauth send: ${e.message}`); }

  // 5e. Empty message
  try {
    const r = await req('POST', '/chat/send', { receiverId: bobId, message: '' }, aliceCookie);
    if (r.status >= 400) ok('Chat', `Empty message rejected: ${r.status}`);
    else fail('Chat', `Empty msg should fail: ${r.status}`);
  } catch (e) { fail('Chat', `Empty msg: ${e.message}`); }

  // 5f. Oversized message (>5000 chars)
  try {
    const bigMsg = JSON.stringify({ __encrypted: true, type: 3, body: 'A'.repeat(6000) });
    const r = await req('POST', '/chat/send', { receiverId: bobId, message: bigMsg }, aliceCookie);
    if (r.status >= 400) ok('Chat', `Oversized message rejected: ${r.status}`);
    else fail('Chat', `Oversized should fail: ${r.status}`);
  } catch (e) { fail('Chat', `Oversized msg: ${e.message}`); }

  // 5g. Bob sends reply to Alice
  const bobReply = JSON.stringify({
    __encrypted: true,
    type: 3,
    body: btoa('simulated-ciphertext-from-bob-to-alice-reply-message')
  });

  try {
    const r = await req('POST', '/chat/send', { receiverId: aliceId, message: bobReply }, bobCookie);
    if (r.status === 200) ok('Chat', `Bob reply to Alice: ${r.status}`);
    else fail('Chat', `Bob reply: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Chat', `Bob reply: ${e.message}`); }

  // ============================================================
  // SECTION 6: CONVERSATIONS & MESSAGE FETCH
  // ============================================================
  console.log('');
  console.log('--- Section 6: Conversations & Message Fetch ---');

  // 6a. Alice's conversations
  try {
    const r = await req('GET', '/chat/conversations', null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data)) {
      const convos = r.data.data;
      ok('Chat', `Alice conversations: count=${convos.length}`);
      if (convos.length > 0) {
        const first = convos[0];
        ok('Chat', `  First convo: userId=${first.userId || first.otherUserId} unread=${first.unreadCount ?? 'N/A'}`);
      }
    } else {
      fail('Chat', `Conversations: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Chat', `Conversations: ${e.message}`); }

  // 6b. Fetch conversation messages
  try {
    const r = await req('GET', `/chat/get/${bobId}?limit=50&offset=0`, null, aliceCookie);
    if (r.status === 200) {
      const msgs = r.data?.data || [];
      ok('Chat', `Fetch A<->B msgs: count=${msgs.length} total=${r.data?.pagination?.total || 'N/A'}`);
      if (msgs.length > 0) {
        const m = msgs[0];
        ok('Chat', `  First msg: sender=${m.senderId?.substring(0,8)} encrypted=${m.isEncrypted} len=${(m.message || '').length}`);
      }
    } else {
      fail('Chat', `Fetch msgs: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Chat', `Fetch msgs: ${e.message}`); }

  // 6c. Pagination beyond available
  try {
    const r = await req('GET', `/chat/get/${bobId}?limit=10&offset=9999`, null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data) && r.data.data.length === 0)
      ok('Chat', 'Pagination offset=9999: empty array (correct)');
    else warn('Chat', `Pagination high offset: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Chat', `Pagination: ${e.message}`); }

  // 6d. Unauth fetch messages
  try {
    const r = await req('GET', `/chat/get/${bobId}`);
    if (r.status === 401 || r.status === 403) ok('Chat', `Unauth fetch msgs: ${r.status}`);
    else fail('Chat', `Unauth fetch should fail: ${r.status}`);
  } catch (e) { fail('Chat', `Unauth fetch: ${e.message}`); }

  // 6e. Mark messages as read
  try {
    const r = await req('PUT', `/chat/messages/read/${bobId}`, {}, aliceCookie);
    if (r.status === 200) ok('Chat', `Mark messages read: ${r.status}`);
    else fail('Chat', `Mark read: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Chat', `Mark read: ${e.message}`); }

  // ============================================================
  // SECTION 7: NOTIFICATIONS
  // ============================================================
  console.log('');
  console.log('--- Section 7: Notifications ---');

  // Wait for RabbitMQ events to be processed
  await new Promise(r => setTimeout(r, 2000));

  // 7a. Get notifications
  let notifications = [];
  try {
    const r = await req('GET', '/notifications/?limit=20&offset=0', null, aliceCookie);
    if (r.status === 200) {
      notifications = r.data?.data || [];
      ok('Notif', `GET notifications: count=${notifications.length}`);
    } else {
      fail('Notif', `GET notifications: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Notif', `GET notifications: ${e.message}`); }

  // 7b. Unread count
  try {
    const r = await req('GET', '/notifications/unread/count', null, aliceCookie);
    if (r.status === 200 && r.data?.data?.count !== undefined) {
      ok('Notif', `Unread count: ${r.data.data.count}`);
    } else {
      fail('Notif', `Unread count: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Notif', `Unread count: ${e.message}`); }

  // 7c. Create notification
  let createdNotifId = null;
  try {
    const r = await req('POST', '/notifications/', {
      userId: aliceId, type: 'system', title: 'Test Notification', message: 'Integration test notification'
    }, aliceCookie);
    if (r.status === 201 && r.data?.data?.id) {
      createdNotifId = r.data.data.id;
      ok('Notif', `Create notification: id=${createdNotifId.substring(0,8)}...`);
    } else {
      fail('Notif', `Create notification: ${r.status} ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Notif', `Create notification: ${e.message}`); }

  // 7d. Mark notification as read
  if (createdNotifId) {
    try {
      const r = await req('PUT', `/notifications/${createdNotifId}/read`, {}, aliceCookie);
      if (r.status === 200) ok('Notif', `Mark notification read: ${r.status}`);
      else fail('Notif', `Mark read: ${JSON.stringify(r.data)}`);
    } catch (e) { fail('Notif', `Mark read: ${e.message}`); }
  } else {
    skip('Notif', 'Mark read (no notification created)');
  }

  // 7e. Create second notification + mark all as read
  let secondNotifId = null;
  try {
    const r = await req('POST', '/notifications/', {
      userId: aliceId, type: 'alert', title: 'Second Test', message: 'Another test'
    }, aliceCookie);
    if (r.status === 201) {
      secondNotifId = r.data?.data?.id;
      ok('Notif', `Create second notification: id=${secondNotifId?.substring(0,8) || 'N/A'}`);
    }
  } catch (e) { fail('Notif', `Create second: ${e.message}`); }

  try {
    const r = await req('PUT', '/notifications/read-all', {}, aliceCookie);
    if (r.status === 200) ok('Notif', `Mark all read: modifiedCount=${r.data?.data?.modifiedCount ?? 'N/A'}`);
    else fail('Notif', `Mark all read: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('Notif', `Mark all read: ${e.message}`); }

  // 7f. Delete notification
  if (secondNotifId) {
    try {
      const r = await req('DELETE', `/notifications/${secondNotifId}`, null, aliceCookie);
      if (r.status === 200) ok('Notif', `Delete notification: ${r.status}`);
      else fail('Notif', `Delete: ${JSON.stringify(r.data)}`);
    } catch (e) { fail('Notif', `Delete: ${e.message}`); }
  } else {
    skip('Notif', 'Delete (no notification to delete)');
  }

  // 7g. Unauth notification access
  try {
    const r = await req('GET', '/notifications/?limit=5');
    if (r.status === 401 || r.status === 403) ok('Notif', `Unauth notifications rejected: ${r.status}`);
    else fail('Notif', `Unauth should fail: ${r.status}`);
  } catch (e) { fail('Notif', `Unauth: ${e.message}`); }

  // ============================================================
  // SECTION 8: USER LOOKUP
  // ============================================================
  console.log('');
  console.log('--- Section 8: User Lookup ---');

  try {
    const r = await req('GET', `/user/users/${bobId}`, null, aliceCookie);
    if (r.status === 200 && r.data?.data?.username === bob.username)
      ok('User', `Get user by ID: ${r.data.data.username}`);
    else fail('User', `Get user by ID: ${JSON.stringify(r.data)}`);
  } catch (e) { fail('User', `Get user by ID: ${e.message}`); }

  try {
    const r = await req('GET', '/user/users/00000000-0000-0000-0000-000000000000', null, aliceCookie);
    if (r.status === 404) ok('User', 'Non-existent user: 404');
    else fail('User', `Non-existent user should be 404: ${r.status}`);
  } catch (e) { fail('User', `Non-existent user: ${e.message}`); }

  // ============================================================
  // SECTION 9: EDGE CASES & SECURITY
  // ============================================================
  console.log('');
  console.log('--- Section 9: Edge Cases & Security ---');

  // SQL injection in search
  try {
    const r = await req('GET', `/user/search?q=${encodeURIComponent("' OR 1=1 --")}`, null, aliceCookie);
    if (r.status === 200 && Array.isArray(r.data?.data)) {
      ok('Security', `SQL injection in search safe: count=${r.data.data.length}`);
    } else {
      fail('Security', `SQL injection search: ${r.status}`);
    }
  } catch (e) { fail('Security', `SQL injection: ${e.message}`); }

  // XSS username
  try {
    const r = await req('POST', '/user/register', {
      username: '<script>alert(1)</script>', email: `xss_${ts}@test.com`, password: 'XssPass123!'
    });
    if (r.status >= 400) ok('Security', `XSS username rejected: ${r.status}`);
    else fail('Security', `XSS username should be rejected: ${r.status}`);
  } catch (e) { fail('Security', `XSS username: ${e.message}`); }

  // Very long username (100 chars)
  try {
    const r = await req('POST', '/user/register', {
      username: 'a'.repeat(100), email: `long_${ts}@test.com`, password: 'LongUser123!'
    });
    if (r.status >= 400) ok('Security', `Long username (100 chars) rejected: ${r.status}`);
    else fail('Security', `Long username should be rejected: ${r.status}`);
  } catch (e) { fail('Security', `Long username: ${e.message}`); }

  // Missing receiverId
  try {
    const r = await req('POST', '/chat/send', { message: encryptedEnvelope }, aliceCookie);
    if (r.status >= 400) ok('Security', `Missing receiverId rejected: ${r.status}`);
    else fail('Security', `Missing receiverId should fail: ${r.status}`);
  } catch (e) { fail('Security', `Missing receiverId: ${e.message}`); }

  // Invalid notification type
  try {
    const r = await req('POST', '/notifications/', {
      userId: aliceId, type: 'invalid_type', title: 'Bad Type', message: 'Should reject'
    }, aliceCookie);
    if (r.status >= 400) ok('Security', `Invalid notification type rejected: ${r.status}`);
    else fail('Security', `Invalid notif type should fail: ${r.status}`);
  } catch (e) { fail('Security', `Invalid notif type: ${e.message}`); }

  // Cross-user notification access (Bob -> Alice's notification)
  if (createdNotifId) {
    try {
      const r = await req('PUT', `/notifications/${createdNotifId}/read`, {}, bobCookie);
      if (r.status === 404) ok('Security', 'Cross-user notification denied: 404 (ownership check)');
      else if (r.status >= 400) ok('Security', `Cross-user notification rejected: ${r.status}`);
      else fail('Security', `Cross-user notification should fail: ${r.status}`);
    } catch (e) { fail('Security', `Cross-user notif: ${e.message}`); }
  }

  // Security headers check
  try {
    const r = await req('GET', '/health');
    const xfo = r.headers.get('x-frame-options');
    const xcto = r.headers.get('x-content-type-options');
    const csp = r.headers.get('content-security-policy');
    const rp = r.headers.get('referrer-policy');

    if (xfo) ok('Security', `X-Frame-Options: ${xfo}`);
    else fail('Security', 'Missing X-Frame-Options header');

    if (xcto === 'nosniff') ok('Security', `X-Content-Type-Options: ${xcto}`);
    else fail('Security', `Missing/wrong X-Content-Type-Options: ${xcto}`);

    if (csp) ok('Security', `Content-Security-Policy: present (${csp.substring(0, 50)}...)`);
    else warn('Security', 'Missing Content-Security-Policy header');

    if (rp) ok('Security', `Referrer-Policy: ${rp}`);
    else warn('Security', 'Missing Referrer-Policy header');

    const server = r.headers.get('server');
    if (!server || !server.includes('/')) ok('Security', `Server version hidden: ${server || 'no header'}`);
    else fail('Security', `Server version exposed: ${server}`);
  } catch (e) { fail('Security', `Header check: ${e.message}`); }

  // ============================================================
  // SECTION 10: LOGOUT
  // ============================================================
  console.log('');
  console.log('--- Section 10: Logout ---');

  try {
    const r = await req('POST', '/user/logout', null, aliceCookie);
    if (r.status === 200) {
      ok('Auth', `Logout Alice: ${r.data?.message}`);
      const clearCookie = r.cookies.find(c => c.startsWith('jwt=') && (c.includes('1970') || c.includes('Max-Age=0') || c.includes('jwt=;')));
      if (clearCookie) ok('Auth', 'JWT cookie cleared on logout');
      else warn('Auth', `JWT cookie may not be properly cleared. Cookies: ${JSON.stringify(r.cookies)}`);
    } else {
      fail('Auth', `Logout: ${JSON.stringify(r.data)}`);
    }
  } catch (e) { fail('Auth', `Logout: ${e.message}`); }

  // Post-logout access (stateless JWT still valid until expiry)
  try {
    const r = await req('GET', '/user/me', null, aliceCookie);
    if (r.status === 200) {
      warn('Auth', 'Old JWT still accepted after logout (stateless JWT - expected for this architecture)');
    } else if (r.status === 401) {
      ok('Auth', `Old JWT rejected after logout: ${r.status}`);
    }
  } catch (e) { fail('Auth', `Post-logout access: ${e.message}`); }

  // ============================================================
  // Summary
  // ============================================================
  printSummary();
}

function printSummary() {
  const total = passed + failed + warned + skipped;
  console.log('');
  console.log('='.repeat(72));
  console.log('  RESULTS SUMMARY');
  console.log('='.repeat(72));
  console.log(`  Total:   ${total}`);
  console.log(`  ${PASS_ICON} Passed: ${passed}`);
  console.log(`  ${FAIL_ICON} Failed: ${failed}`);
  console.log(`  ${WARN_ICON} Warned: ${warned}`);
  console.log(`  ${SKIP_ICON} Skipped: ${skipped}`);
  console.log('='.repeat(72));

  if (failed > 0) {
    console.log('');
    console.log('  FAILED TESTS:');
    results.filter(r => r.icon === FAIL_ICON).forEach(r => console.log(`    ${r.line}`));
  }
  if (warned > 0) {
    console.log('');
    console.log('  WARNINGS:');
    results.filter(r => r.icon === WARN_ICON).forEach(r => console.log(`    ${r.line}`));
  }

  console.log('');
  console.log(failed === 0
    ? `${PASS_ICON}  ALL TESTS PASSED!`
    : `${FAIL_ICON}  SOME TESTS FAILED - see above`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});