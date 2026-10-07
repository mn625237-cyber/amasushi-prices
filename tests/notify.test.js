const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const state = {
  verifyCalls: [],
  sentMessages: [],
  shouldRejectToken: false,
  documentExists: true,
  fcmToken: 'test-fcm-token'
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
                  data: () => ({ token: state.fcmToken })
                };
              },
              async delete() {}
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
        return { app_id: '1:972743740267:web:24eb04cf828b545a41da2e' };
      }
    };
  },
  messaging() {
    return {
      async send(message) {
        state.sentMessages.push(message);
        return 'test-message-id';
      }
    };
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
  state.documentExists = true;
  state.fcmToken = 'test-fcm-token';
});

test('allows a valid App Check token without NOTIFY_SECRET and sends the notification', async () => {
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true });
  assert.deepEqual(state.verifyCalls, ['verified-app-check-token']);
  assert.equal(state.sentMessages.length, 1);
  assert.match(state.sentMessages[0].data.body, /Android · Chrome · phone/);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://amasushi-prices.vercel.app');
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Firebase-AppCheck/);
  assert.doesNotMatch(response.headers['Access-Control-Allow-Headers'], /X-Notify-Secret/);
});

test('rejects a request without an App Check token', async () => {
  const request = makeRequest();
  delete request.headers['x-firebase-appcheck'];
  const response = await invoke(request);

  assert.equal(response.statusCode, 401);
  assert.equal(state.sentMessages.length, 0);
});

test('rejects an invalid App Check token', async () => {
  state.shouldRejectToken = true;
  const response = await invoke(makeRequest());

  assert.equal(response.statusCode, 401);
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
