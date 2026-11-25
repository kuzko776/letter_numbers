import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const admin = { email: 'admin@example.test', password: 'Local-test-admin-956' };
const origin = 'https://letters.example.test';
const employee = { name: 'موظف تجريبي', email: 'employee@example.test', password: 'Local-test-user-716' };

async function start(env, clock) {
  const child = fork(clock, [], { cwd: root, env, silent: true });
  const stopped = once(child, 'exit');
  child.stderr.pipe(process.stderr);
  await Promise.race([
    once(child, 'message'),
    stopped.then(([code]) => { throw new Error(`Backend stopped on startup: ${code}`); }),
  ]);
  const pending = new Map();
  child.on('message', ({ id, result }) => {
    pending.get(id)?.(result);
    pending.delete(id);
  });
  function send(message) {
    const id = randomUUID();
    const result = new Promise((resolve) => pending.set(id, resolve));
    child.send({ ...message, id });
    return result;
  }
  return {
    send,
    async stop() {
      child.kill();
      await stopped;
    },
    changeDate: (date) => send({ date }),
  };
}

async function request(service, path, { token, method = 'GET', data, expected = 200, source = origin } = {}) {
  const headers = { origin: source };
  if (token) headers.authorization = `Bearer ${token}`;
  if (data) headers['content-type'] = 'application/json';
  const res = await service.send({
    url: `/api${path}`, method, headers, body: data && JSON.stringify(data),
  });
  const result = JSON.parse(res.body);
  assert.equal(res.status, expected, JSON.stringify(result));
  assert.equal(res.headers['cache-control'], 'no-store');
  return result;
}

test('reservations, account permissions, rollover, and durable storage', { timeout: 35_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'amr-test-'));
  const clock = join(scratch, 'clock.mjs');
  const env = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    DB_PATH: join(scratch, 'letters.sqlite'),
    APP_ORIGIN: origin,
    ADMIN_EMAIL: admin.email,
    ADMIN_PASSWORD: admin.password,
  };
  await writeFile(clock, `
    import { Readable } from 'node:stream';
    import { handle } from ${JSON.stringify(pathToFileURL(join(root, 'server.mjs')).href)};
    const RealDate = Date;
    let fixed = '2026-11-25T10:00:00Z';
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
    };
    process.on('message', async ({ id, date, method = 'GET', headers = {}, url, body }) => {
      if (date) {
        fixed = date;
        process.send({ id });
        return;
      }
      const request = Readable.from(body ? [Buffer.from(body)] : []);
      Object.assign(request, { method, headers, url, socket: { remoteAddress: '127.0.0.1' } });
      const result = { headers: {} };
      const response = {
        setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
        writeHead(status, headers = {}) {
          result.status = status;
          for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
          return this;
        },
        end(data) { process.send({ id, result: { ...result, body: data?.toString() } }); },
      };
      await handle(request, response);
    });
    process.send('ready');
  `);

  let service;
  let peer;
  try {
    execFileSync(process.execPath, ['server.mjs', 'init-admin'], { cwd: root, env, stdio: 'ignore' });
    service = await start(env, clock);
    peer = await start(env, clock);
    const call = (path, options) => request(service, path, options);

    const page = await service.send({ url: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /lang="ar" dir="rtl"/);
    for (const asset of ['app.js', 'styles.css']) {
      assert.equal((await service.send({ url: `/${asset}` })).status, 200);
    }
    assert.equal((await service.send({ url: '/data/letters.sqlite' })).status, 404);
    await call('/login', { method: 'OPTIONS', expected: 403, source: 'https://untrusted.example' });
    await call('/letters', { expected: 401 });

    const { token: adminToken } = await call('/login', { method: 'POST', data: admin });
    await call('/users', { token: adminToken, method: 'POST', data: employee, expected: 201 });
    await call('/users', { token: adminToken, method: 'POST', data: employee, expected: 409 });
    const [account] = await call('/users', { token: adminToken });
    assert.deepEqual(Object.keys(account).sort(), ['active', 'email', 'id', 'name']);
    const { token: employeeToken } = await call('/login', { method: 'POST', data: employee });
    await call('/users', { token: employeeToken, expected: 403 });
    await call('/users', { token: employeeToken, method: 'POST', data: employee, expected: 403 });

    const data = { subject: 'موضوع أول', requestId: randomUUID() };
    const reservations = await Promise.all([
      call('/letters', { token: employeeToken, method: 'POST', data, expected: 201 }),
      request(peer, '/letters', {
        token: adminToken, method: 'POST', data: { subject: 'موضوع المدير', requestId: randomUUID() },
        expected: 201,
      }),
    ]);
    assert.deepEqual(reservations.map((letter) => letter.number).sort(), ['0001-48', '0002-48']);
    const retry = await call('/letters', { token: employeeToken, method: 'POST', data, expected: 201 });
    assert.deepEqual(retry, reservations[0]);
    await call('/letters', { token: employeeToken, method: 'POST', data: { ...data, subject: 'موضوع مختلف' }, expected: 409 });
    assert.equal((await call('/letters', { token: employeeToken })).letters.length, 1);
    assert.equal((await call('/letters', { token: adminToken })).letters.length, 2);
    assert.equal((await call('/letters?q=' + encodeURIComponent('موضوع المدير'), { token: adminToken })).letters.length, 1);

    const calendar = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'Asia/Riyadh', year: 'numeric',
    });
    let midnight = Date.UTC(2027, 5, 1, 21);
    while (midnight < Date.UTC(2027, 6, 1) && !calendar.format(new Date(midnight)).includes('1449')) {
      midnight += 86_400_000;
    }
    assert.ok(midnight < Date.UTC(2027, 6, 1));
    await service.changeDate(new Date(midnight - 1).toISOString());
    const before = await call('/letters', {
      token: adminToken, method: 'POST', data: { subject: 'آخر حجز', requestId: randomUUID() }, expected: 201,
    });
    assert.equal(before.number, '0003-48');
    await service.changeDate(new Date(midnight).toISOString());
    const after = await call('/letters', {
      token: adminToken, method: 'POST', data: { subject: 'سنة جديدة', requestId: randomUUID() }, expected: 201,
    });
    assert.equal(after.number, '0001-49');

    const accountPath = `/users/${account.id}`;
    await call(accountPath, { token: adminToken, method: 'PATCH', data: { active: false } });
    await call('/letters', { token: employeeToken, expected: 401 });
    await call('/login', { method: 'POST', data: employee, expected: 401 });
    await call(accountPath, { token: adminToken, method: 'PATCH', data: { active: true } });
    const { token: reactivated } = await call('/login', { method: 'POST', data: employee });
    const password = 'New-local-user-password-912';
    await call(accountPath, { token: adminToken, method: 'PATCH', data: { password } });
    await call('/letters', { token: reactivated, expected: 401 });
    await call('/login', { method: 'POST', data: employee, expected: 401 });
    const { token: renewed } = await call('/login', { method: 'POST', data: { email: employee.email, password } });
    await call('/logout', { token: renewed, method: 'POST' });
    await call('/letters', { token: renewed, expected: 401 });

    await peer.stop();
    peer = undefined;
    await service.stop();
    service = undefined;
    service = await start(env, clock);
    assert.equal((await request(service, '/letters', { token: adminToken })).letters.length, 4);
  } finally {
    await Promise.all([service?.stop(), peer?.stop()]);
    await rm(scratch, { recursive: true, force: true });
  }
});
