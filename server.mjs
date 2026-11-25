import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const yearFormat = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  year: 'numeric',
  timeZone: 'Asia/Riyadh',
});
const sessionAge = 8 * 60 * 60 * 1000;
const loginWindow = 10 * 60 * 1000;
const loginAttempts = new Map();
const port = Number(process.env.PORT ?? 3000);
const appOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null;
const dbFile = resolve(process.env.DB_PATH ?? 'data/letters.sqlite');
mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbFile, { timeout: 5000 });
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'employee')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS letters (
    year INTEGER NOT NULL,
    serial INTEGER NOT NULL CHECK(serial BETWEEN 1 AND 9999),
    subject TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    PRIMARY KEY(year, serial),
    UNIQUE(user_id, request_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS letters_user ON letters(user_id, year DESC, serial DESC);
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkedText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `أدخل ${label} بما لا يزيد على ${max} حرفًا.`);
  }
  return value.trim();
}

function checkedEmail(value) {
  const email = checkedText(value, 254, 'البريد الإلكتروني').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'أدخل عنوانًا بصيغة بريد إلكتروني.');
  }
  return email;
}

function checkedPassword(value, minimum = 10) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 128) {
    throw new HttpError(400, `أدخل كلمة مرور تتكون من ${minimum} إلى 128 حرفًا.`);
  }
  return value;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function validPassword(password, stored) {
  const [salt, hash] = (stored ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await derive(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex')) && Boolean(stored);
}

function digest(token) {
  return createHash('sha256').update(token).digest('hex');
}

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'صيغة الطلب غير مدعومة.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 8192) {
      request.resume();
      throw new HttpError(413, 'حجم الطلب أكبر من الحد المسموح.');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'بيانات الطلب غير صالحة.');
  }
}

function currentSession(request) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'سجّل دخولك للمتابعة.');
  const tokenHash = digest(token);
  const user = db.prepare(`
    SELECT u.id, u.name, u.email, u.role FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(tokenHash, Date.now());
  if (!user) throw new HttpError(401, 'سجّل دخولك للمتابعة.');
  return { user, tokenHash };
}

function limitLogin(key, maximum) {
  const now = Date.now();
  const bucket = loginAttempts.get(key);
  if (!bucket || bucket.expires <= now) {
    loginAttempts.set(key, { count: 1, expires: now + loginWindow });
    return;
  }
  if (bucket.count >= maximum) {
    throw new HttpError(429, 'محاولات دخول كثيرة. حاول مرة أخرى بعد عدة دقائق.');
  }
  bucket.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of loginAttempts) {
    if (bucket.expires <= now) loginAttempts.delete(key);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}, 60_000).unref();

async function login(request) {
  limitLogin(`ip:${request.socket.remoteAddress}`, 300);
  const input = await body(request);
  const email = checkedEmail(input.email);
  const password = checkedPassword(input.password, 1);
  limitLogin(`email:${email}`, 8);
  const candidate = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!(await validPassword(password, candidate?.password_hash)) || !candidate.active) {
    throw new HttpError(401, 'البريد أو كلمة المرور غير صحيحة.');
  }
  const token = randomBytes(32).toString('hex');
  transaction(() => {
    const user = db.prepare('SELECT active, password_hash FROM users WHERE id = ?').get(candidate.id);
    if (!user.active || user.password_hash !== candidate.password_hash) {
      throw new HttpError(401, 'البريد أو كلمة المرور غير صحيحة.');
    }
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), candidate.id, Date.now() + sessionAge);
  });
  loginAttempts.delete(`email:${email}`);
  return { token };
}

function formatLetter(row) {
  return {
    number: `${String(row.serial).padStart(4, '0')}-${String(row.year % 100).padStart(2, '0')}`,
    subject: row.subject,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
  };
}

function reserve(request, input) {
  const subject = checkedText(input.subject, 200, 'موضوع الخطاب');
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) {
    throw new HttpError(400, 'معرّف طلب الحجز غير صالح.');
  }
  return transaction(() => {
    const { user } = currentSession(request);
    const previous = db.prepare('SELECT * FROM letters WHERE user_id = ? AND request_id = ?')
      .get(user.id, requestId);
    if (previous) {
      if (previous.subject !== subject) throw new HttpError(409, 'يرتبط الطلب بحجز آخر.');
      return formatLetter(previous);
    }
    const now = new Date();
    const year = Number(yearFormat.formatToParts(now).find((part) => part.type === 'year')?.value);
    if (!Number.isInteger(year)) throw new Error('Unable to determine Hijri year');
    const { serial } = db.prepare('SELECT COALESCE(MAX(serial), 0) + 1 AS serial FROM letters WHERE year = ?')
      .get(year);
    if (serial > 9999) throw new HttpError(409, 'تم بلوغ الحد السنوي لأرقام الخطابات.');
    const createdAt = now.toISOString();
    db.prepare('INSERT INTO letters VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(year, serial, subject, user.id, user.name, createdAt, requestId);
    return formatLetter({ year, serial, subject, requested_by: user.name, created_at: createdAt });
  });
}

async function createEmployee(request, input) {
  const name = checkedText(input.name, 100, 'اسم الموظف');
  const email = checkedEmail(input.email);
  const hash = await hashPassword(checkedPassword(input.password));
  transaction(() => {
    adminSession(request);
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'يوجد حساب بهذا البريد بالفعل.');
    }
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'employee')")
      .run(name, email, hash);
  });
}

function adminSession(request) {
  const session = currentSession(request);
  if (session.user.role !== 'admin') throw new HttpError(403, 'هذه العملية متاحة للمدير.');
  return session;
}

async function updateEmployee(request, id, input) {
  const changesPassword = Object.hasOwn(input, 'password');
  if (changesPassword ? Object.hasOwn(input, 'active') : typeof input.active !== 'boolean') {
    throw new HttpError(400, 'بيانات تعديل الحساب غير صالحة.');
  }
  const hash = changesPassword ? await hashPassword(checkedPassword(input.password)) : null;
  transaction(() => {
    adminSession(request);
    const result = changesPassword
      ? db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'employee'").run(hash, id)
      : db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'employee'").run(Number(input.active), id);
    if (!result.changes) throw new HttpError(404, 'حساب الموظف غير موجود.');
    if (changesPassword || !input.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  });
}

function listLetters(user, url) {
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const offset = Math.min(1_000_000, Math.max(0, Number.parseInt(url.searchParams.get('offset'), 10) || 0));
  const rows = db.prepare(`
    SELECT year, serial, subject, requested_by, created_at FROM letters
    WHERE (? = 1 OR user_id = ?)
      AND (instr(subject, ?) > 0 OR instr(printf('%04d-%02d', serial, year % 100), ?) > 0 OR ? = '')
    ORDER BY year DESC, serial DESC LIMIT 26 OFFSET ?
  `).all(Number(user.role === 'admin'), user.id, query, query, query, offset);
  return { letters: rows.slice(0, 25).map(formatLetter), more: rows.length > 25 };
}

async function api(request, response, url) {
  const { pathname } = url;
  const method = request.method;
  if (method === 'POST' && pathname === '/api/login') return json(response, 200, await login(request));
  const { user, tokenHash } = currentSession(request);
  if (method === 'GET' && pathname === '/api/me') return json(response, 200, user);
  if (method === 'POST' && pathname === '/api/logout') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return json(response, 200, {});
  }
  if (method === 'GET' && pathname === '/api/letters') return json(response, 200, listLetters(user, url));
  if (method === 'POST' && pathname === '/api/letters') {
    return json(response, 201, reserve(request, await body(request)));
  }
  if (pathname === '/api/users' || /^\/api\/users\/\d+$/.test(pathname)) {
    adminSession(request);
    if (method === 'GET' && pathname === '/api/users') {
      return json(response, 200, db.prepare("SELECT id, name, email, active FROM users WHERE role = 'employee' ORDER BY name, id").all());
    }
    if (method === 'POST' && pathname === '/api/users') {
      await createEmployee(request, await body(request));
      return json(response, 201, {});
    }
    if (method === 'PATCH' && pathname !== '/api/users') {
      await updateEmployee(request, Number(pathname.split('/').at(-1)), await body(request));
      return json(response, 200, {});
    }
  }
  throw new HttpError(404, 'الصفحة غير موجودة.');
}

export async function handle(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      const origin = request.headers.origin;
      if (origin && origin !== (appOrigin ?? `http://${request.headers.host}`)) {
        throw new HttpError(403, 'مصدر الطلب غير مصرح به.');
      }
      await api(request, response, url);
      return;
    }
    const asset = request.method === 'GET' && assets.get(url.pathname);
    if (!asset) throw new HttpError(404, 'الصفحة غير موجودة.');
    const [file, type] = asset;
    const content = await readFile(new URL(`./web/${file}`, import.meta.url));
    response.setHeader('X-Frame-Options', 'DENY');
    response.writeHead(200, { 'Content-Type': type }).end(content);
  } catch (error) {
    if (error instanceof HttpError) {
      json(response, error.status, { error: error.message });
    } else {
      console.error(error);
      json(response, 500, { error: 'تعذر إكمال العملية. حاول مرة أخرى.' });
    }
  }
}

if (process.argv[2] === 'init-admin') {
  const email = checkedEmail(process.env.ADMIN_EMAIL);
  const name = checkedText(process.env.ADMIN_NAME ?? 'مدير النظام', 100, 'اسم المدير');
  const hash = await hashPassword(checkedPassword(process.env.ADMIN_PASSWORD));
  transaction(() => {
    if (db.prepare("SELECT id FROM users WHERE role = 'admin'").get()) {
      throw new Error('An administrator already exists');
    }
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(name, email, hash);
  });
  console.log('Administrator created.');
  db.close();
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, handle);
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Listening on port ${server.address().port}`);
  });
}
