import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';

const utcDay = () => new Date().toISOString().slice(0, 10);

// One namespaced store per bot: users + free-form kv, JSON on disk, atomic writes.
export function makeStore(ns) {
  const dir = join(DATA_DIR, ns);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'db.json');
  const ledgerPath = join(dir, 'purchases.jsonl');

  let db = { users: {}, kv: {} };
  if (existsSync(dbPath)) {
    try { db = { users: {}, kv: {}, ...JSON.parse(readFileSync(dbPath, 'utf8')) }; } catch {}
  }
  let dirty = false;
  const persist = () => {
    if (!dirty) return;
    dirty = false;
    writeFileSync(dbPath + '.tmp', JSON.stringify(db));
    renameSync(dbPath + '.tmp', dbPath);
  };
  setInterval(persist, 5_000).unref();
  process.on('beforeExit', persist);

  const getUser = (id) => {
    const key = String(id);
    let u = db.users[key];
    if (!u) {
      u = db.users[key] = { credits: 0, day: utcDay(), usedToday: 0, total: 0, firstSeen: new Date().toISOString() };
      dirty = true;
    }
    if (u.day !== utcDay()) { u.day = utcDay(); u.usedToday = 0; dirty = true; }
    return u;
  };

  return {
    getUser,
    users: () => db.users,
    touch: () => { dirty = true; },
    consume(id, freePerDay) {
      const u = getUser(id);
      if (u.usedToday < freePerDay) { u.usedToday++; u.total++; dirty = true; return { ok: true, source: 'free', freeLeft: freePerDay - u.usedToday, credits: u.credits }; }
      if (u.credits > 0) { u.credits--; u.total++; dirty = true; return { ok: true, source: 'credit', freeLeft: 0, credits: u.credits }; }
      return { ok: false, freeLeft: 0, credits: 0 };
    },
    refund(id, source) {
      const u = getUser(id);
      if (source === 'credit') u.credits++;
      else if (u.usedToday > 0) u.usedToday--;
      if (u.total > 0) u.total--;
      dirty = true;
    },
    addCredits(id, n) { const u = getUser(id); u.credits += n; dirty = true; return u.credits; },
    kvGet: (k, dflt = null) => (k in db.kv ? db.kv[k] : dflt),
    kvSet: (k, v) => { db.kv[k] = v; dirty = true; },
    recordPurchase: (e) => appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n'),
    persist,
  };
}

export const pickLang = (code) => ((code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en');
