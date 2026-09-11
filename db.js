// Слой работы с БД (SQLite через better-sqlite3).
// Тут храним только одно: прошёл ли пользователь капчу и не забанен ли он.
// Именно ради этого файла нужна БД — чтобы при перезапуске бота
// (pm2 restart, падение процесса и т.д.) все, кто уже прошёл проверку,
// не должны были проходить её заново.
//
// Установка: npm install better-sqlite3

import Database from 'better-sqlite3';
import path from 'path';

// Файл базы будет создан рядом с ботом при первом запуске.
const db = new Database(path.resolve('./bot.db'));

// WAL — чтобы чтение и запись не блокировали друг друга под нагрузкой.
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    verified      INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    banned_until  INTEGER,
    permanent_ban INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  )
`);

const selectStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');

const upsertStmt = db.prepare(`
  INSERT INTO users (user_id, verified, fail_count, banned_until, permanent_ban, updated_at)
  VALUES (@userId, @verified, @failCount, @bannedUntil, @permanentBan, @updatedAt)
  ON CONFLICT(user_id) DO UPDATE SET
    verified      = excluded.verified,
    fail_count    = excluded.fail_count,
    banned_until  = excluded.banned_until,
    permanent_ban = excluded.permanent_ban,
    updated_at    = excluded.updated_at
`);

// Текущий статус пользователя. Если записи ещё нет — считаем,
// что это новый пользователь, капчу не проходил, не забанен.
export function getUserStatus(userId) {
  const row = selectStmt.get(userId);

  if (!row) {
    return {
      verified: false, failCount: 0, bannedUntil: null, permanentBan: false
    };
  }

  return {
    verified: !!row.verified,
    failCount: row.fail_count,
    bannedUntil: row.banned_until,
    permanentBan: !!row.permanent_ban
  };
}

// Пользователь успешно прошёл капчу — снимаем бан/счётчик, помечаем verified.
export function markVerified(userId) {
  upsertStmt.run({
    userId,
    verified: 1,
    failCount: 0,
    bannedUntil: null,
    permanentBan: 0,
    updatedAt: Date.now()
  });
}

// Неверный ответ на капчу. Эскалация бана:
//   1-я ошибка -> бан на 5 минут
//   2-я ошибка -> бан на 1 день
//   3-я и далее -> бан навсегда
// Возвращает новый статус, чтобы бот сразу мог показать нужное сообщение.
export function registerFailedAttempt(userId) {
  const current = getUserStatus(userId);
  const failCount = current.failCount + 1;

  let bannedUntil = null;
  let permanentBan = false;

  if (failCount === 1) {
    bannedUntil = Date.now() + 5 * 60 * 1000;
  } else if (failCount === 2) {
    bannedUntil = Date.now() + 24 * 60 * 60 * 1000;
  } else {
    permanentBan = true;
  }

  upsertStmt.run({
    userId,
    verified: 0,
    failCount,
    bannedUntil,
    permanentBan: permanentBan ? 1 : 0,
    updatedAt: Date.now()
  });

  return {
    failCount, bannedUntil, permanentBan
  };
}

export default db;