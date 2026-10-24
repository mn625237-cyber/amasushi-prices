const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const state = {
  verifyCalls: [],
  sentMessages: [],
  shouldRejectToken: false,
  verifiedAppId: '1:972743740267:web:24eb04cf828b545a41da2e',
  documentExists: true,
  fcmTokens: ['test-fcm-token'],
  legacyToken: null,
  sendResponses: null,
  tokenUpdates: []
};

const fakeAdmin = {
  apps: [],
  credential: { cert: credentials => credentials },
  initializeApp() { this.apps.push({}); },
  firestore() {
    return {
      collection(name) {
        assert.equal(name, 'fcm_tokens');
        return {
          doc() {
            return {
              async get() {
                return {
                  exists: state.documentExists,
                  data: () => ({
                    tokens: state.fcmTokens,
                    ...(state.legacyToken ? { token: state.legacyToken } : {})
                  })
                };
              },
              async update(fields) {
                state.tokenUpdates.push(fields);
              }
            };
          }
        };
      }
    };
  },
  appCheck() {
    return {
      async verifyToken(token) {
        state.verifyCalls.push(token);
        if (state.shouldRejectToken) throw new Error('invalid token');
        return { appId: state.verifiedAppId };
      }
    };
  },
  messaging() {
    return {
      async sendEachForMulticast(message) {
        state.sentMessages.push(message);
        const responses = state.sendResponses || message.tokens.map(() => ({ success: true }));
        return {
          responses,
          successCount: responses.filter(response => response.success).length,
          failureCount: responses.filter(response => !response.success).length
        };
      }
    };
  }
};

fakeAdmin.firestore.FieldValue = {
  arrayRemove(...values) {
    return { operation: 'arrayRemove', values };
  }
};

const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') return fakeAdmin;
  return originalModuleLoad.call(this, request, parent, isMain);
};
process.env.FIREBASE_CREDENTIALS = JSON.stringify({ project_id: 'test-project' });
delete process.env.NOTIFY_SECRET;
const handler = require('../api/notify');
Module._load = originalModuleLoad;

function makeRequest(overrides = {}) {
  return {
    method: 'POST',
    headers: {
      origin: 'https://amasushi-prices.vercel.app',
      'x-timestamp': String(Date.now()),
      'x-firebase-appcheck': 'verified-app-check-token',
      'content-type': 'application/json'
    },
    body: { os: 'Android', browser: 'Chrome', device: 'phone' },
    ...overrides
  };
}

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  };
}

async function invoke(request) {
  const response = makeResponse();
  await handler(request, response);
  return response;
}

test.beforeEach(() => {
  state.verifyCalls.length = 0;
  state.sentMessages.length = 0;
  state.shouldRejectToken = false;
  state.verifiedAppId = '1:972743740267:web:24eb04cf828b545a41da2e';
  state.documentExists = true;
  state.fcmTokens = ['test-fcm-token'];
  state.legacyToken = null;
  state.sendResponses = null;
  state.tokenUpdates.length = 0;
});

test('allows a valid App Check token without NOTIFY_SECRET and sends the notification', async () => {
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true });
  assert.deepEqual(state.verifyCalls, ['verified-app-check-token']);
  assert.equal(state.sentMessages.length, 1);
  assert.deepEqual(state.sentMessages[0].tokens, ['test-fcm-token']);
  assert.match(state.sentMessages[0].data.body, /Android · Chrome · phone/);
  assert.equal(state.sentMessages[0].webpush.headers.Urgency, 'high');
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://amasushi-prices.vercel.app');
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Firebase-AppCheck/);
  assert.doesNotMatch(response.headers['Access-Control-Allow-Headers'], /X-Notify-Secret/);
});

test('sends to all registered device tokens and accepts the legacy token field', async () => {
  state.fcmTokens = ['device-a', 'device-b'];
  state.legacyToken = 'legacy-device';
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.sentMessages[0].tokens, ['legacy-device', 'device-a', 'device-b']);
  assert.equal(state.sentMessages[0].data.title, '🛵 زيارة جديدة — اما سوشي');
});

test('prunes only invalid registration tokens while preserving successful sends', async () => {
  state.fcmTokens = ['good-device', 'stale-device'];
  state.sendResponses = [
    { success: true },
    { success: false, error: { code: 'messaging/registration-token-not-registered' } }
  ];
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.tokenUpdates, [{
    tokens: { operation: 'arrayRemove', values: ['stale-device'] }
  }]);
});

test('returns an error when all multicast sends fail', async () => {
  state.fcmTokens = ['stale-a', 'stale-b'];
  state.sendResponses = [
    { success: false, error: { code: 'messaging/invalid-registration-token' } },
    { success: false, error: { code: 'messaging/registration-token-not-registered' } }
  ];
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 500);
  assert.deepEqual(state.tokenUpdates, [{
    tokens: { operation: 'arrayRemove', values: ['stale-a', 'stale-b'] }
  }]);
});

test('rejects a request without an App Check token', async () => {
  const request = makeRequest();
  delete request.headers['x-firebase-appcheck'];
  const response = await invoke(request);

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'verification_failed' });
  assert.equal(state.sentMessages.length, 0);
});

test('rejects an invalid App Check token', async () => {
  state.shouldRejectToken = true;
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'verification_failed' });
  assert.doesNotMatch(JSON.stringify(response.body), /invalid token|verified-app-check-token/);
  assert.equal(state.sentMessages.length, 0);
});

test('rejects an App Check token for a different App ID', async () => {
  state.verifiedAppId = 'different-app-id';
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'app_id_mismatch' });
  assert.equal(state.sentMessages.length, 0);
});

test('rejects requests from an unapproved origin', async () => {
  const request = makeRequest();
  request.headers.origin = 'https://preview.example.vercel.app';
  const response = await invoke(request);

  assert.equal(response.statusCode, 403);
  assert.equal(state.verifyCalls.length, 0);
});

test('rejects methods other than POST and OPTIONS', async () => {
  const response = await invoke(makeRequest({ method: 'GET' }));

  assert.equal(response.statusCode, 405);
});

test('responds to CORS preflight with the allowed method and headers', async () => {
  const response = await invoke(makeRequest({ method: 'OPTIONS' }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Firebase-AppCheck/);
});

test('rejects malformed or oversized notification payloads', async t => {
  const invalidBodies = [
    null,
    [],
    { os: 'Android', browser: 'Chrome' },
    { os: 'Android', browser: 'Chrome', device: 'phone', extra: 'field' },
    { os: 'Android\nDesktop', browser: 'Chrome', device: 'phone' },
    { os: 'Android', browser: 'Chrome', device: 'x'.repeat(81) },
    { os: 123, browser: 'Chrome', device: 'phone' }
  ];

  for (const body of invalidBodies) {
    await t.test(JSON.stringify(body), async () => {
      state.sentMessages.length = 0;
      const response = await invoke(makeRequest({ body }));
      assert.equal(response.statusCode, 400);
      assert.equal(state.sentMessages.length, 0);
    });
  }
});

test('rejects non-JSON request bodies', async () => {
  const request = makeRequest();
  request.headers['content-type'] = 'text/plain';
  const response = await invoke(request);

  assert.equal(response.statusCode, 415);
  assert.equal(state.sentMessages.length, 0);
});

test('rejects stale or malformed timestamps', async t => {
  for (const timestamp of [String(Date.now() - 60000), '123junk']) {
    await t.test(timestamp, async () => {
      const request = makeRequest();
      request.headers['x-timestamp'] = timestamp;
      const response = await invoke(request);
      assert.equal(response.statusCode, 403);
      assert.equal(state.verifyCalls.length, 0);
    });
  }
});
