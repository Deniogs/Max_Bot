// Слой работы с БД (SQLite через better-sqlite3). Четыре вещи:
//  1. Прошёл ли пользователь капчу и не забанен ли он (таблица users).
//  2. Незавершённая анкета заказа — чтобы пережить перезапуск бота
//     (таблица sessions).
//  3. Журнал отправленных заявок — лимит "не больше 3 в день", "Мои заказы"
//     у пользователя и /orders в чате админов (таблица order_log).
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
  );

  CREATE TABLE IF NOT EXISTS sessions (
    user_id    INTEGER PRIMARY KEY,
    step       TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data       TEXT,
    status     TEXT NOT NULL DEFAULT 'active'
  );

  CREATE INDEX IF NOT EXISTS idx_order_log_user_created
    ON order_log(user_id, created_at);
`);

// Миграция для БД, созданных до появления "Моих заказов"/`/orders`/статусов —
// у них таблица order_log может быть ещё без колонок data/status.
// CREATE TABLE IF NOT EXISTS не добавляет колонки в уже существующую
// таблицу, поэтому проверяем и дописываем вручную, чтобы не терять
// старую базу при обновлении бота.
const orderLogColumns = db.prepare("PRAGMA table_info(order_log)").all().map((c) => c.name);
if (!orderLogColumns.includes('data')) {
  db.exec('ALTER TABLE order_log ADD COLUMN data TEXT');
}
if (!orderLogColumns.includes('status')) {
  db.exec("ALTER TABLE order_log ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}

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

// --- СЕССИИ АНКЕТЫ (переживают перезапуск бота) ---

const selectSessionStmt = db.prepare('SELECT * FROM sessions WHERE user_id = ?');

const upsertSessionStmt = db.prepare(`
  INSERT INTO sessions (user_id, step, data, updated_at)
  VALUES (@userId, @step, @data, @updatedAt)
  ON CONFLICT(user_id) DO UPDATE SET
    step       = excluded.step,
    data       = excluded.data,
    updated_at = excluded.updated_at
`);

const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');

const selectAllSessionsStmt = db.prepare('SELECT * FROM sessions');

// Сохраняет (или перезаписывает) текущее состояние анкеты пользователя.
export function saveSession(userId, session) {
  upsertSessionStmt.run({
    userId,
    step: session.step ?? '',
    data: JSON.stringify(session.data ?? {}),
    updatedAt: Date.now()
  });
}

// Удаляет сессию — вызывается, когда анкета завершена/сброшена
// (заказ отправлен, нажали "Главное меню", ввели /start и т.д.).
export function deleteSession(userId) {
  deleteSessionStmt.run(userId);
}

// Отдаёт одну сессию — не используется в горячем пути бота (там всё
// живёт в памяти), но пригодится для отладки.
export function loadSession(userId) {
  const row = selectSessionStmt.get(userId);
  if (!row) return null;

  try {
    return { step: row.step || '', data: JSON.parse(row.data) };
  } catch (e) {
    console.error('Повреждённая сессия в БД для userId', userId, e.message);
    return null;
  }
}

// Загружает ВСЕ сохранённые сессии сразу — вызывается один раз при
// старте бота, чтобы восстановить userSessions после перезапуска.
export function loadAllSessions() {
  const rows = selectAllSessionsStmt.all();
  const sessions = {};

  for (const row of rows) {
    try {
      sessions[row.user_id] = { step: row.step || '', data: JSON.parse(row.data) };
    } catch (e) {
      // Одна битая запись не должна мешать восстановлению остальных
      console.error('Пропускаю повреждённую сессию для userId', row.user_id, e.message);
    }
  }

  return sessions;
}

// --- ЖУРНАЛ ЗАЯВОК: дневной лимит, статусы, "Мои заказы", /orders у админов ---

const insertOrderStmt = db.prepare('INSERT INTO order_log (user_id, created_at, data) VALUES (?, ?, ?)');

const countOrdersTodayStmt = db.prepare(
  'SELECT COUNT(*) AS count FROM order_log WHERE user_id = ? AND created_at >= ?'
);

const selectUserOrdersStmt = db.prepare(
  'SELECT * FROM order_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
);

// Для админов — от СТАРЫХ к НОВЫМ (очередь на обработку), поэтому
// отдельный запрос с ASC, а не просто DESC, как для "Моих заказов".
const selectRecentOrdersAscStmt = db.prepare(
  'SELECT * FROM order_log ORDER BY created_at ASC LIMIT ?'
);
const selectRecentOrdersDescStmt = db.prepare(
  'SELECT * FROM order_log ORDER BY created_at DESC LIMIT ?'
);

const selectOrderByIdStmt = db.prepare('SELECT * FROM order_log WHERE id = ?');
const updateOrderStatusStmt = db.prepare('UPDATE order_log SET status = ? WHERE id = ?');

const countAllOrdersStmt = db.prepare('SELECT COUNT(*) AS count FROM order_log');

// Начало текущих суток по локальному времени сервера.
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseOrderRow(row) {
  try {
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      status: row.status || 'active',
      data: row.data ? JSON.parse(row.data) : {}
    };
  } catch (e) {
    console.error('Повреждённая запись заказа id', row.id, e.message);
    return null;
  }
}

// Сколько заявок пользователь уже успешно отправил сегодня. Считаются ВСЕ
// заявки независимо от статуса — лимит про то, сколько раз в день человек
// дошёл до подтверждения заявки, а не про то, что с ней случилось потом.
export function countOrdersToday(userId) {
  return countOrdersTodayStmt.get(userId, startOfToday()).count;
}

// Фиксирует факт отправки заявки — вызывать ТОЛЬКО после успешной
// доставки сообщения в чат с заявками (см. finishOrder в bot.js).
// data — это session.data целиком, чтобы потом можно было показать
// и "Мои заказы" пользователю, и полный список /orders админам.
// Статус новой заявки всегда 'active' (значение по умолчанию в таблице).
export function logOrder(userId, data) {
  insertOrderStmt.run(userId, Date.now(), JSON.stringify(data ?? {}));
}

// Заказы конкретного пользователя, самые свежие первыми — для "Мои заказы".
export function getUserOrders(userId, limit = 10) {
  return selectUserOrdersStmt.all(userId, limit).map(parseOrderRow).filter(Boolean);
}

// Последние заказы вообще всех пользователей — для /orders в чате админов.
// ascending: true — от старых к новым (так админы видят очередь как надо
// её обрабатывать, а не перевёрнуто).
export function getRecentOrders(limit = 20, { ascending = false } = {}) {
  const stmt = ascending ? selectRecentOrdersAscStmt : selectRecentOrdersDescStmt;
  return stmt.all(limit).map(parseOrderRow).filter(Boolean);
}

// Только АКТИВНЫЕ заказы, от старых к новым — используется для выбора
// даты в /orders (закрытые/отменённые в этом разборе не нужны).
const selectActiveOrdersAscStmt = db.prepare(
  "SELECT * FROM order_log WHERE status = 'active' ORDER BY created_at ASC LIMIT ?"
);

export function getActiveOrders(limit = 200) {
  return selectActiveOrdersAscStmt.all(limit).map(parseOrderRow).filter(Boolean);
}

// Одна заявка по id — нужна, чтобы проверить владельца перед отменой
// (пользователь) или просто найти заявку перед сменой статуса (админ).
export function getOrderById(orderId) {
  const row = selectOrderByIdStmt.get(orderId);
  return row ? parseOrderRow(row) : null;
}

// Смена статуса: 'active' -> 'cancelled' (отменил пользователь или админ)
// или 'active' -> 'closed' (админ отметил заявку выполненной).
export function updateOrderStatus(orderId, status) {
  updateOrderStatusStmt.run(status, orderId);
}

// Общее число заявок за всё время — чтобы в /orders можно было написать
// "показаны последние 20 из 137", а не просто выгрузить необозримый список.
export function countAllOrders() {
  return countAllOrdersStmt.get().count;
}