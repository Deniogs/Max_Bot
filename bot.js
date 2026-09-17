//   ██████╗██████╗ ███████╗ █████╗ ████████╗███████╗██████╗     ██████╗  ██╗   ██╗
//  ██╔════╝██╔══██╗██╔════╝██╔══██╗╚══██╔══╝██╔════╝██╔══██╗    ██╔══██╗  ██╗ ██╔╝
//  ██║     ██████╔╝█████╗  ███████║   ██║   █████╗  ██║  ██║    ██████╔╝   ████╔╝ 
//  ██║     ██╔══██╗██╔══╝  ██╔══██║   ██║   ██╔══╝  ██║  ██║    ██╔══██╗    ██╔╝  
//   ██████╗██║  ██║███████╗██║  ██║   ██║   ███████╗██████╔╝    ██████╔╝    ██║   
//   ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═════╝     ╚═════╝     ╚═╝   
//
//  ██████╗ ███████╗███╗   ██╗██╗ █████╗ ██╗ ▄█████╗
//  ██╔══██╗██╔════╝████╗  ██║██║██╔══██╗██║██╔════╝
//  ██║  ██║█████╗  ██╔██╗ ██║██║██║  ██║██║██║  ███╗
//  ██║  ██║██╔══╝  ██║╚██╗██║██║██║  ██║██║██║   ██║
//  ██████╔╝███████╗██║ ╚████║██║ █████╔╝██║╚██████╔╝
//  ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝ ╚════╝ ╚═╝ ╚═════╝
// Это бот логистического центра ГУП "Почта Таврии"
//
// ---------------------------------------------------------------------------
// КАК ДОБАВИТЬ НОВЫЙ ВОПРОС В FAQ:
//   1. Добавь кнопку в faqKeyboard (ниже) с любым уникальным id вида 'faq_...'
//   2. Добавь запись с тем же id в объект FAQ_ANSWERS с текстом ответа
//   Всё, обработчик уже общий и подхватит любой id, начинающийся с 'faq_'.
//
// КАК ДОБАВИТЬ НОВЫЙ ШАГ В АНКЕТУ ЗАКАЗА (простой текстовый вопрос):
//   Добавь запись в объект TEXT_STEPS: { save: 'ключ_в_data', next: 'СЛЕДУЮЩИЙ_ШАГ',
//   prompt: 'текст вопроса', keyboard: () => backToMenuKeyboard }
//   и поставь на кого-то из соседних шагов next: 'ТВОЙ_НОВЫЙ_ШАГ'.
//   Если после ответа нужно не просто перейти дальше, а показать кнопки
//   (Да/Нет и т.п.) — используй `after` вместо `next/prompt/keyboard`,
//   смотри пример WAIT_PHONE или WAIT_ADRESS_UNLOAD ниже.
// ---------------------------------------------------------------------------

import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'fs/promises';

import { Bot, Keyboard, ImageAttachment } from '@maxhub/max-bot-api';
import { buildCaptchaChallenge } from './captcha.js';
import {
  getUserStatus, markVerified, registerFailedAttempt,
  saveSession, deleteSession, loadAllSessions,
  countOrdersToday, logOrder, getUserOrders,
  getOrderById, updateOrderStatus, getActiveOrders
} from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);

// ПОВТОР ПРИ ВРЕМЕННОМ СБОЕ СЕТИ. Ошибка вида
// "ConnectTimeoutError: platform-api2.max.ru" — это не баг бота, а
// временная недоступность API площадки. Раньше такая ошибка просто
// улетала в bot.catch() и сообщение терялось без каких-либо попыток
// повторить отправку. Патчим bot.api.sendMessageToChat один раз здесь —
// этим методом под капотом пользуется и ctx.reply() (внутри библиотеки),
// и наша прямая отправка заявки админам, так что ретраи разом
// применяются ко всем ~17 местам, где бот шлёт сообщения.
const MAX_SEND_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Отличаем временный сетевой сбой (таймаут соединения, обрыв, DNS и т.п.)
// от настоящей ошибки запроса (неверные данные, доступ запрещён и т.д.) —
// повторять имеет смысл только первое.
function isRetryableError(err) {
  const code = err?.cause?.code || err?.code;
  const retryableCodes = [
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'
  ];

  if (code && retryableCodes.includes(code)) return true;
  if (err?.message === 'fetch failed') return true; // именно так undici заворачивает сетевые сбои

  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, description) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryableError(err) || attempt === MAX_SEND_RETRIES) {
        throw err;
      }

      console.error(
        `⚠️ ${description}: временный сбой сети (попытка ${attempt}/${MAX_SEND_RETRIES}), повтор через ${RETRY_DELAY_MS * attempt}мс:`,
        err.message || err
      );
      await delay(RETRY_DELAY_MS * attempt); // растущая пауза между попытками
    }
  }

  throw lastError;
}

const rawSendMessageToChat = bot.api.sendMessageToChat.bind(bot.api);
bot.api.sendMessageToChat = (...args) => withRetry(
  () => rawSendMessageToChat(...args),
  'Отправка сообщения'
);

// Незавершённые анкеты, сохранённые в БД до прошлого перезапуска,
// подхватываем сразу при старте — пользователь продолжит с того же шага,
// на котором остановился, а не начнёт всё заново.
const userSessions = loadAllSessions();

// Тут храним ТОЛЬКО номер правильного ответа для текущей капчи, пока
// пользователь не ответил. Это не БД: если бот перезапустится в момент,
// когда человек как раз смотрит на капчу, ему просто пришлют новую —
// это не страшно, в отличие от статуса "прошёл/не прошёл", который
// обязательно должен пережить перезапуск (он в db.js).
const captchaState = {};

// ЗАЩИТА ОТ ДУБЛЕЙ. Две разные причины дублей — две разные проверки:
//  1. Совпадающий по времени повторный апдейт (двойной тап, пока бот
//     "думает") — ловит processingUsers.
//  2. Повторная ДОСТАВКА одного и того же сообщения/нажатия — платформа
//     или клиент при нестабильной сети иногда присылают апдейт дважды,
//     уже НЕ одновременно, а через секунду-другую. Такое processingUsers
//     не поймает (первый апдейт уже отпустил лок к моменту прихода
//     второго), поэтому дополнительно сверяем уникальный id сообщения
//     (mid) или нажатия (callback_id) — если такой уже обрабатывали
//     недавно для этого пользователя, второй раз просто игнорируем.
// Регистрируется САМОЙ ПЕРВОЙ, чтобы дубль отсекался до вообще любой
// обработки (включая сохранение сессии в БД чуть ниже).
const processingUsers = new Set();

const recentUpdateIds = new Map(); // ключ "userId:id" -> время обработки
const DEDUPE_WINDOW_MS = 2 * 60 * 1000; // с запасом — повторная доставка обычно приходит в течение секунд

// Уникальный id конкретного сообщения или нажатия кнопки, если он есть.
function getUpdateId(ctx) {
  return ctx.message?.body?.mid || ctx.callback?.callback_id || null;
}

function isDuplicateUpdate(userId, updateId) {
  if (!updateId) return false; // нечем сверять — не дедуплицируем вслепую

  const key = `${userId}:${updateId}`;
  const now = Date.now();

  // Заодно чистим устаревшие записи, чтобы Map не рос бесконечно
  for (const [k, ts] of recentUpdateIds) {
    if (now - ts > DEDUPE_WINDOW_MS) recentUpdateIds.delete(k);
  }

  if (recentUpdateIds.has(key)) return true;

  recentUpdateIds.set(key, now);
  return false;
}

bot.use(async (ctx, next) => {
  const { userId } = getUserData(ctx);
  if (!userId) return next();

  if (isDuplicateUpdate(userId, getUpdateId(ctx))) {
    // Точно повторная доставка того же самого сообщения/нажатия — игнор.
    return;
  }

  if (processingUsers.has(userId)) {
    // Предыдущий апдейт этого пользователя ещё в работе — игнорируем.
    return;
  }

  processingUsers.add(userId);
  try {
    await next();
  } finally {
    processingUsers.delete(userId);
  }
});

// ГЛОБАЛЬНАЯ ПЕРСИСТЕНТНОСТЬ СЕССИЙ. Регистрируется до капча-гейта
// и всех остальных обработчиков, а логика сохранения стоит ПОСЛЕ `await next()` —
// то есть выполняется уже после того, как весь остальной бот отработал апдейт.
// Это тот же приём "onion"-мидлвара, на котором построен собственный session()
// в этой библиотеке (см. node_modules/@maxhub/max-bot-api/dist/session) — здесь
// он написан вручную, чтобы не переписывать все места, где бот уже читает и
// меняет userSessions[userId] напрямую.
bot.use(async (ctx, next) => {
  await next();

  const { userId } = getUserData(ctx);
  if (!userId) return;

  const session = userSessions[userId];
  if (session) {
    saveSession(userId, session);
  } else {
    // Сессии больше нет (заказ отправлен, нажали "Главное меню", /start
    // и т.п.) — убираем и из БД, иначе после рестарта анкета "воскреснет".
    deleteSession(userId);
  }
});

// ГЛОБАЛЬНЫЙ ЛОГГЕР НА ВСЯКИЙ, УБИРАЕТЕ ЕГО ИХ КОММЕНТОВ И ВЕСТЬ ТЕСТ ПОЛЬЗОВАТЕЛЕЙ ЛЕТИТ В КОНСОЛЬ
//bot.use(async (ctx, next) => {
//  const msg = ctx.message || ctx.update?.message;
//  const recipient = msg?.recipient || ctx.recipient;
//
//  console.log('--- 🔍 ДЕТЕТКТОР ЧАТА ---');
//  console.log('Type:', ctx.updateType);
//  console.log('Recipient Object:', recipient);
//  console.log('Chat ID из recipient:', recipient?.chat_id);
//  console.log('Peer ID / Dialog ID:', msg?.peer_id || msg?.dialog_id);
//  console.log('-------------------------');
//
//  return next();
//});

function getUserData(ctx) {
  const user = ctx.user || ctx.sender || ctx.message?.sender || ctx.callback?.user || {};
  const userId = user.user_id || user.id;
  const firstName = user.first_name || '';
  const lastName = user.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Клиент';
  const username = user.username ? `@${user.username}` : 'не указан';

  return { userId, fullName, username };
}

// Достаём текущую сессию пользователя. Если её нет (например, бот
// перезапустился или сессия истекла) — вежливо отправляем в начало,
// вместо того чтобы упасть с ошибкой обращения к undefined.
async function requireSession(ctx, userId) {
  const session = userSessions[userId];
  if (!session) {
    await navigateTo(ctx, 'Сессия устарела. Начните заново.', startKeyboard);
    return null;
  }
  return session;
}

// Функция чтения данных тарифов из JSON

async function getClientRates(clientType) {
  try {
    const rawData = await fs.readFile('./rates.json', 'utf-8');
    const rates = JSON.parse(rawData);

    if (!rates[clientType]) {
      throw new Error(`Тип клиента "${clientType}" не найден в файле`);
    }

    return rates[clientType];
  } catch (error) {
    console.error('Ошибка:', error.message);
    return null;
  }
}

//Достаём тарифы из JSON и формируем текст для вывода. Я ХЗ что тут может быть непонятного, но на всякий случай, если за чтение кода сядет Виталя

async function getTariffs(client) {
  const rates = await getClientRates(client) || {};

  const {
    price = 0,
    min_order = 0,
    km_order = 0,
    wait_order = 0,
    loader_standard = 0,
    loader_hard = 0
  } = rates;

  const clientName = (client === 'legal') ? 'юридических' : 'физических';

  const text = `🚚 **Тарифы для ${clientName} лиц:**\n\n` +
               `    **Почасовая тарификация (по г. Мелитополю району в радиусе 10-15 км.)**\n` +
               `• Почасовая аренда авто — **${price} ₽/час**\n` +
               `• Минимальный заказ (автомобиль 2 часа) — **${min_order} ₽/час**\n\n` +
               `  **Покилометровая аренда автомобиля (от 100 км.)**\n` +
               `• Стоимость за 1 км — **${km_order} ₽/час**\n` +
               `• Простой при тарифе за км — **${wait_order} ₽/час**\n\n` +
               `📦 **Услуги грузчиков**\n` +
               `• Грузчик стандарт — **${loader_standard} ₽/час**\n` +
               `• ПРР повышеной сложности — **${loader_hard} ₽/час**`;

  return text;
}

async function navigateTo(ctx, text, keyboard) {
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Игнорируем ошибку, если сообщение уже удалено
  }
  return await ctx.reply(text, { attachments: [keyboard], format: 'markdown' });
}

// То же самое, что navigateTo, но без клавиатуры — для сообщений про бан,
// где пользователю пока нечего нажимать.
async function replyAndClear(ctx, text) {
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Игнорируем ошибку, если сообщение уже удалено
  }
  return await ctx.reply(text, { format: 'markdown' });
}

// Куда вести пользователя после выбора услуги / вопроса про этаж:
// у юрлиц сначала спрашиваем организацию и ИНН, у физлиц сразу ФИО.
// prefix — необязательный текст, который допишется перед вопросом
// (например "Вы выбрали: ...\n\n").
async function goToNameStep(ctx, session, prefix = '') {
  const isLegal = session.data.counterparty === '🏢 Юридическое лицо';

  if (isLegal) {
    session.step = 'WAIT_ORG_NAME';
    await navigateTo(ctx, `${prefix}Введите название организации`, backToMenuKeyboard);
  } else {
    session.step = 'WAIT_NAME';
    await navigateTo(ctx, `${prefix}Введите ФИО отправителя`, backToMenuKeyboard);
  }
}

// Формируем и отправляем администратору финальную заявку, затем чистим сессию
// Собирает текст с деталями заказа из session.data — используется и для
// сообщения админам, и для экрана "проверьте заявку" перед отправкой,
// чтобы не дублировать форматирование в двух местах.
function buildOrderDetailsText(data) {
  const {
    name, consigneename, counterparty, service, floor, floorItems, phone,
    consigneephone, date, adress, intermediateAdress, details,
    adressUnload, weight, orgName, inn, payment
  } = data;

  const orgLines = orgName
    ? `🏢 Организация: ${orgName}\n` +
      `🧾 ИНН: ${inn || 'Не указан'}\n`
    : '';

  return (
    `📌 Контрагент: ${counterparty || 'Не указан'}\n` +
    orgLines +
    `🛠️ Тип услуги: ${service || 'Не указан'}\n` +
    `👷 Подъем/спуск на этаж: ${floor}\n` +
    `📦 Что поднять/спустить: ${floorItems || '—'}\n` +
    `👤 ФИО отправителя: ${name}\n` +
    `👤 ФИО получателя: ${consigneename}\n` +
    `🗓️ Дата и время погрузки: ${date}\n` +
    `🏠 Адрес погрузки: ${adress}\n` +
    `🏠 Промежуточные пункты выгрузки/загрузки ${intermediateAdress}\n` +
    `🏠 Адрес выгрузки: ${adressUnload}\n` +
    `📞 Телефон отправителя: ${phone}\n` +
    `📞 Телефон получателя: ${consigneephone}\n` +
    `📦 Наименование груза, вес/объем: ${weight || 'Не указан'}\n` +
    `💳 Оплата: ${payment || 'Безналичный расчет (юрлицо)'}\n` +
    `📦 Детали заказа:\n${details}`
  );
}

// Дата отправки заявки (created_at в БД) — для "Мои заказы" и /orders.
// Это ОТДЕЛЬНАЯ дата от той, что пользователь вписал как "дату погрузки".
function formatSubmittedAt(timestampMs) {
  return new Date(timestampMs).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Достаёт КАЛЕНДАРНЫЙ день погрузки из поля вида "20.09.2026 14:30"
// (формат гарантирован validateDate на шаге WAIT_DATE). timestamp — полночь
// этого дня, чтобы даты можно было сравнивать и сортировать как числа;
// label — то, что показываем на кнопке/в заголовке.
function getOrderDateInfo(dateText) {
  const match = (dateText || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;

  const [, day, month, year] = match;
  const timestamp = new Date(Number(year), Number(month) - 1, Number(day)).getTime();

  return { timestamp, label: `${day}.${month}.${year}` };
}

// Читаемая подпись статуса заказа — используется и в карточке, и в текстах
// после смены статуса.
const ORDER_STATUS_LABELS = {
  active: '🟢 Активна',
  cancelled: '🚫 Отменена',
  closed: '✅ Закрыта'
};

// Карточка одного заказа — используется и в "Мои заказы" (у пользователя),
// и в /orders (у админов). Короткая выжимка, а не вся анкета целиком (её
// и так уже отправляли в чат с заявками в момент подачи).
function buildOrderCardText(order) {
  const d = order.data || {};
  const submittedAt = formatSubmittedAt(order.createdAt);
  const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;

  return (
    `**Заявка №${order.id}** — ${statusLabel}\n` +
    `Подана: ${submittedAt}\n` +
    `Телефон: ${d.phone || '—'}\n` +
    `Услуга: ${d.service || '—'}\n` +
    `Погрузка: ${d.date || '—'}, ${d.adress || '—'}\n` +
    `Выгрузка: ${d.adressUnload || '—'}`
  );
}

// Кнопки под карточкой активного заказа: у пользователя — только отмена,
// у админов — закрыть (выполнена) или отменить.
function userOrderKeyboard(orderId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отменить заказ', `user_cancel_${orderId}`)]
  ]);
}

function adminOrderKeyboard(orderId) {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Закрыть', `admin_close_${orderId}`),
      Keyboard.button.callback('❌ Отменить', `admin_cancel_${orderId}`)
    ]
  ]);
}

async function finishOrder(ctx, session, userId) {
  const adminMessage = `🚨 НОВАЯ ЗАЯВКА НА ПЕРЕВОЗКУ\n\n${buildOrderDetailsText(session.data)}`;

  // Если пользователь прислал фото груза — прикрепляем его к тому же
  // сообщению в чат с заявками (по токену, без повторной загрузки файла).
  const adminAttachments = session.data.photoToken
    ? [new ImageAttachment({ token: session.data.photoToken }).toJson()]
    : [];

  try {
    const targetChatId = Number(process.env.ADMIN_CHAT_ID);

    await bot.api.sendMessageToChat(targetChatId, adminMessage, { attachments: adminAttachments, format: 'markdown' });

    // Считаем в дневной лимит только реально дошедшие до менеджера заявки —
    // если отправка упала (catch ниже), она не должна съедать лимит пользователя.
    logOrder(userId, session.data);

    // Сессию чистим ТОЛЬКО после подтверждённой успешной отправки — если
    // удалить её раньше и отправка всё же провалится, заполненная анкета
    // потеряется безвозвратно.
    delete userSessions[userId];

    await ctx.reply(
      '✅ Ваша заявка принята!\n\nМенеджер уже обрабатывает данные и свяжется с вами в ближайшее время.',
      { attachments: [backToMenuKeyboard], format: 'markdown' }
    );
  } catch (err) {
    console.error('🔥 Ошибка отправки админам:', err);

    // Сессию НЕ трогаем — данные остаются, кнопка "Подтвердить и отправить"
    // сработает ещё раз без повторного заполнения анкеты с нуля.
    try {
      await ctx.reply(
        '⚠️ Не получилось отправить заявку из-за временного сбоя связи. ' +
        'Ваши данные никуда не делись — нажмите «Подтвердить и отправить» ещё раз через минуту.',
        { attachments: [confirmOrderKeyboard], format: 'markdown' }
      );
    } catch (replyErr) {
      // Сеть недоступна настолько, что даже это сообщение не ушло.
      // Ничего страшного: данные всё равно целы в сессии и в БД
      // (персистентная мидлвара сохранит их после этого апдейта) —
      // пользователь попробует снова, когда связь восстановится.
      console.error('🔥 Не удалось даже уведомить пользователя о сбое:', replyErr);
    }
  }
}

// Экран "проверьте заявку" перед отправкой — показывается вместо
// немедленной отправки, требует явного подтверждения кнопкой.
async function showOrderSummary(ctx, session) {
  session.step = '';

  await ctx.reply(
    '📋 **Проверьте данные перед отправкой:**\n\n' +
    buildOrderDetailsText(session.data) +
    '\n\nВсё верно?',
    { attachments: [confirmOrderKeyboard], format: 'markdown' }
  );
}

// Куда вести пользователя дальше после того, как он прислал фото
// (или нажал "Пропустить") — общее место для обоих исходов шага WAIT_PHOTO.
async function proceedAfterPhoto(ctx, session, userId) {
  const isIndividual = session.data.counterparty === '👤 Физическое лицо';

  if (isIndividual) {
    // Юрлица всегда платят по безналу (см. FAQ), поэтому кнопку
    // показываем только физлицам — им есть из чего выбирать.
    session.step = '';
    await ctx.reply('Как будете оплачивать заказ?', { attachments: [paymentKeyboard], format: 'markdown' });
    return;
  }

  await showOrderSummary(ctx, session);
}

// Общее продолжение после шага "детали заказа" — вызывается и когда
// пользователь написал текст, и когда нажал "Пропустить" (см. skip_details).
async function proceedAfterDetails(ctx, session) {
  session.step = 'WAIT_PHOTO';
  await ctx.reply(
    'Если есть фото груза — пришлите его сюда, это ускорит расчет. Либо нажмите «Пропустить».',
    { attachments: [skipPhotoKeyboard], format: 'markdown' }
  );
}

// Обрабатывает сообщение на шаге WAIT_PHOTO: достаёт токен фото из
// вложений входящего сообщения (если пользователь прислал картинку),
// сохраняет его и ведёт дальше по сценарию.
async function handlePhotoStep(ctx, session, userId) {
  const attachments =
    ctx.message?.body?.attachments ||
    ctx.update?.message?.body?.attachments ||
    [];

  const photo = attachments.find((a) => a.type === 'image');

  if (!photo) {
    // Прислали не фото (текст, файл и т.д.) — просим прислать именно фото
    // либо нажать «Пропустить», а не молча теряем сообщение.
    await ctx.reply(
      'Это не похоже на фото. Пришлите изображение груза или нажмите «Пропустить».',
      { attachments: [skipPhotoKeyboard], format: 'markdown' }
    );
    return;
  }

  // Токен уже загруженного в MAX файла — его достаточно, чтобы переслать
  // это же фото в чат с заявками без повторной загрузки.
  session.data.photoToken = photo.payload.token;

  await proceedAfterPhoto(ctx, session, userId);
}

// --- КЛАВИАТУРЫ ---

//const shareContactKeyboard = Keyboard.keyboard([
//  [Keyboard.button.requestContact('📱 Поделиться номером телефона')],
//  ['❌ Отмена']
//]);

const backToMenuKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('◀ Назад в главное меню', 'main_menu')]
]);

const startKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Тарифы', 'show_tariffs')],
  [Keyboard.button.callback('Рассчитать и оформить заказ', 'create_order')],
  [Keyboard.button.callback('Мои заказы', 'my_orders')],
  [Keyboard.button.callback('Контакты', 'show_contacts')],
  [Keyboard.button.callback('Часто задаваемые вопросы', 'faq')]
]);

const tariffsKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('Физлица', 'tariffs_individuals'),
    Keyboard.button.callback('Юрлица', 'tariffs_legal')
  ],
  [Keyboard.button.callback('◀ Назад в главное меню', 'main_menu')]
]);

const tariffOrderKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('▶ Оформить заказ', 'create_order')],
  [Keyboard.button.callback('◀ Назад к тарифам', 'main_menu')]
]);

const counterpartyKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('👤 Физическое лицо', 'select_counterparty_phys'),
    Keyboard.button.callback('🏢 Юридическое лицо', 'select_counterparty_jur')
  ],
  [Keyboard.button.callback('◀ Главное меню', 'main_menu')]
]);

const serviceTypeKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🚛 Аренда автомобиля', 'service_type_transport_car_driver')],
  [Keyboard.button.callback('📦 Аренда автомобиля + услуги грузчика', 'service_type_transport_loader')],
  //[Keyboard.button.callback('🏗️ С подъемом на этаж', 'service_type_transport_loader_floor')],
  [Keyboard.button.callback('💪 Услуги грузчиков', 'service_type_loader')],
  [Keyboard.button.callback('◀ Главное меню', 'main_menu')]
]);

// Чтобы добавить новый вопрос в FAQ: 1 кнопка сюда + 1 запись в FAQ_ANSWERS
const faqKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Как рассчитывается подъем на этаж?', 'faq_floor')],
  [Keyboard.button.callback('Что входит в ПРР?', 'faq_prr')],
  [Keyboard.button.callback('Какой минимальный заказ?', 'faq_min')],
  [Keyboard.button.callback('Какой транспорт доступен?', 'faq_auto')],
  [Keyboard.button.callback('Как отменить или изменить заявку?', 'faq_cancel')],
  [Keyboard.button.callback('Можно ли оплатить безналичным расчетом?', 'faq_payment')],
  [Keyboard.button.callback('◀ Назад в главное меню', 'main_menu')]
]);

const consigneeKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Да', 'consignee_is_consignor')],
  [Keyboard.button.callback('Нет', 'consignee_no_consignor')]
]);

const backToFAQKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❓ Вернуться к часто задаваемым вопросам', 'faq')],
  [Keyboard.button.callback('◀ Назад в главное меню', 'main_menu')]
]);

const loaderFloorKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Да, нужна', 'yes_load_floor')],
  [Keyboard.button.callback('Нет, не нужно', 'no_load_floor')]
]);

const intermediateKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('Да', 'intermediate_adress'),
    Keyboard.button.callback('Нет', 'intermediate_no_adress')
  ]
]);

// Способ оплаты спрашиваем только у физлиц (см. WAIT_DETAILS.after)
const paymentKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('Наличными', 'payment_cash'),
    Keyboard.button.callback('Безналичный расчет', 'payment_cashless')
  ]
]);

// Фото груза необязательно — даём кнопку пропустить этот шаг
const skipPhotoKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Пропустить', 'skip_photo')]
]);

// Детали заказа тоже не обязательны — не у всех есть что добавить
const skipDetailsKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Пропустить', 'skip_details')]
]);

// Финальный экран проверки заявки перед отправкой. "Отмена" переиспользует
// существующий main_menu (он и так чистит сессию и возвращает в меню).
const confirmOrderKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Подтвердить и отправить', 'confirm_order')],
  [Keyboard.button.callback('❌ Отмена', 'main_menu')]
]);

// --- ОТВЕТЫ FAQ (данные, а не код — просто добавляй новые пары id: текст) ---

const FAQ_ANSWERS = {
  faq_floor:
    '❓ **Как рассчитывается подъем/спуск на этаж?**\n\n' +
    ' • Тип груза — учитываются габариты и хрупкость, а также применяются повышающие коэффициенты в зависимости от категории груза (например, для негабаритных или особо хрупких предметов ставка увеличивается).\n' +
    ' • Тоннаж — чем тяжелее груз, тем больше времени и людей требуется для перемещения, что влияет на итоговую стоимость.\n' +
    ' • Количество этажей и наличие лифта.\n' +
    ' • Если в доме работает грузовой лифт — доплата за работу с лифтом 0 ₽. Если лифта нет или груз в него не помещается — расчет идет по этажам вручную с учетом коэффициентов.\n' +
    'Подъем на этаж рассчитывается отдельно — это не входит в часовую услугу грузчиков.\n' +
    'Точную стоимость менеджер назовет после уточнения параметров груза. Если у вас есть фото груза — приложите его к заявке, это ускорит расчет.',

  faq_prr:
    '❓ **Что входит в ПРР?**\n\n ПРР повышенной сложности применяется, если: Груз тяжелый, габаритный или неделимый — к данной категории относятся Крупная бытовая техника, Сейфы, Пианино, Цельная габаритная неразборная мебель.\n' +
    ' Подъем на этаж рассчитывается отдельно — это не входит в ПРР.',

  faq_min:
    '❓ **Какой минимальный заказ?**\n\n' +
    ' • Минимальный заказ зависит от типа услуги:\n' +
    ' • Почасовая аренда авто — минимум 2 часа\n' +
    ' • Покилометровая тарификация — от 100 км\n' +
    ' • Услуги грузчиков — минимум 1 часа на человека.\n' +
    ' Если фактическое время работы меньше минимального — оплата все равно за минимальное количество часов.',

  faq_auto:
    '❓ **Какой транспорт доступен?**\n\n Основной транспорт — ГАЗ «Валдай 8»:\n' +
    ' • Грузоподъемность — до 3,2 тонн\n' +
    ' • Закрытый изотермический кузов\n' +
    ' • Подходит для перевозки мебели, стройматериалов, оборудования, переездов, товаров',

  faq_cancel:
    '❓ **Как отменить или изменить заявку?**\n\n Заявку можно изменить или отменить несколькими способами:\n' +
    ' • Позвонить по номеру +7 (990) 170 70 00 — это быстрее всего\n' +
    ' • Написать в этот чат — бот передаст сообщение менеджеру.\n' +
    ' Рекомендуем сообщать об отмене или изменениях как можно раньше — минимум за 2–3 часа до подачи авто. Если машина уже выехала по адресу, может потребоваться оплата минимального заказа.',

  faq_payment:
    '❓ **Можно ли оплатить безналичным расчетом?**\n\n Да. Способы оплаты зависят от типа клиента:\n' +
    ' • Физлица — наличные, карта\n' +
    ' • Юрлица — безналичный расчет по счету, закрывающие документы предоставляются.\n' +
    ' Если нужен конкретный документ (счет, акт, УПД) — укажите это в комментарии к заявке или сообщите менеджеру при подтверждении.'
};

// --- ЛИНЕЙНЫЕ ШАГИ АНКЕТЫ ЗАКАЗА (данные, а не код) ---
// save     — в какое поле session.data записать введённый текст
// next     — на какой шаг перейти дальше (для простых вопросов "текст -> текст")
// prompt   — что спросить дальше
// keyboard — какую клавиатуру прикрепить к следующему вопросу
// after    — если после ответа нужна не текстовая подсказка, а кнопки/финал —
//            вместо next/prompt/keyboard используем свою функцию

// Общий текст вопроса про детали заказа — используется в двух местах
// (после этажного уточнения и без него), поэтому вынесен в константу.
const ORDER_DETAILS_PROMPT = 'Укажите детали заказа (пароль от подъезда, запасной контактный номер, хрупкий груз и т.д.):';

// Показывается при оформлении заказа: какая сейчас тарификация и в каких
// населённых пунктах работаем. На данный момент — покилометровая, зона —
// г. Мелитополь и Мелитопольский округ.
const SERVICE_AREA_NOTICE =
  'ℹ️ **Тарификация: покилометровая.**\n' +
  'На данный момент мы работаем по г. Мелитополь и Мелитопольскому округу. ' +
  'При расширении зоны оказания услуг будет сообщено отдельно.\n\n';

// Проверка ссылок — действует на ЛЮБОЙ текстовый шаг анкеты (см. использование
// в bot.on('message_created')), чтобы в заявку нельзя было протащить ссылку
// ни через одно поле (ФИО, адрес, детали заказа и т.д.).
const LINK_PATTERN = /(https?:\/\/|www\.|t\.me\/|vk\.com\/|\b[a-zа-я0-9-]+\.(ru|com|net|org|info|io|me|su|ua|by|xyz|рф)\b)/i;

function containsLink(text) {
  return LINK_PATTERN.test(text);
}

// Проверка российского номера телефона: код страны только +7/8/7,
// и ровно 10 цифр после него — отсекает и другие коды стран, и
// неправильное количество цифр (больше или меньше).
function validatePhone(text) {
  const digitsOnly = text.trim().replace(/[^\d+]/g, '');
  const isValid = /^(\+7|8|7)\d{10}$/.test(digitsOnly);

  return isValid
    ? true
    : '❌ Введите корректный номер телефона в формате +7XXXXXXXXXX или 8XXXXXXXXXX (ровно 10 цифр после кода страны, принимаются только российские номера).';
}

// Проверка даты и времени погрузки: строгий формат ДД.ММ.ГГГГ ЧЧ:ММ,
// дата должна реально существовать, и быть минимум на час позже текущего
// момента — иначе менеджер физически не успеет обработать заявку.
function validateDate(text) {
  // Время принимаем с разделителем ":", "-" или "." — 11:30, 11-30, 11.30
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2})[:\-.](\d{2})$/);

  const formatHint = '❌ Укажите дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ, например: 20.09.2026 14:30';

  if (!match) return formatHint;

  const [, dayStr, monthStr, yearStr, hourStr, minuteStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  const date = new Date(year, month - 1, day, hour, minute);

  // new Date() сама "переносит" несуществующие даты (например, 31.02
  // превратится в начало марта) — сверяем, что введённое совпадает
  // с тем, что реально получилось, иначе отсекаем.
  const isRealDate =
    date.getFullYear() === year && date.getMonth() === month - 1 &&
    date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;

  if (!isRealDate) {
    return '❌ Такой даты или времени не существует. Проверьте и введите ещё раз в формате ДД.ММ.ГГГГ ЧЧ:ММ.';
  }

  const minAllowed = new Date(Date.now() + 60 * 60 * 1000); // текущий момент + 1 час

  if (date < minAllowed) {
    return '❌ Дата и время погрузки должны быть минимум на час позже текущего момента. Укажите более позднее время.';
  }

  return true;
}

const TEXT_STEPS = {
  // Шаг про этаж теперь идёт ПОСЛЕ веса/объёма груза (см. WAIT_WEIGHT.after),
  // а не сразу после выбора услуги.
  WAIT_FLOOR: {
    save: 'floor',
    next: 'WAIT_FLOOR_ITEMS',
    prompt: 'Укажите, что именно нужно поднять/спустить (например, диван, коробки, стройматериалы):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_FLOOR_ITEMS: {
    save: 'floorItems',
    next: 'WAIT_DETAILS',
    prompt: ORDER_DETAILS_PROMPT,
    keyboard: () => skipDetailsKeyboard
  },
  // --- Эти два шага видят только юрлица, физлиц goToNameStep ведёт сразу на WAIT_NAME ---
  WAIT_ORG_NAME: {
    save: 'orgName',
    next: 'WAIT_INN',
    prompt: 'Введите ИНН организации',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_INN: {
    save: 'inn',
    next: 'WAIT_NAME', // после ИНН попадаем в тот же общий шаг "ФИО", что и у физлиц
    prompt: 'Введите ФИО контактного лица',
    keyboard: () => backToMenuKeyboard
  },
  // --- Общий шаг для всех: у физлиц это ФИО отправителя, у юрлиц — ФИО контактного лица ---
  WAIT_NAME: {
    save: 'name',
    next: 'WAIT_PHONE',
    prompt: 'Введите номер телефона отправителя (в формате +7XXXXXXXXXX или 8XXXXXXXXXX):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_PHONE: {
    save: 'phone',
    validate: validatePhone,
    next: 'WAIT_DATE',
    prompt: 'Укажите дату и время погрузки в формате ДД.ММ.ГГГГ ЧЧ:ММ (например, 20.09.2026 14:30):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_DATE: {
    save: 'date',
    validate: validateDate,
    next: 'WAIT_ADRESS',
    prompt: 'Укажите адресс погрузки (город, улица, дом, подъезд):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_ADRESS: {
    save: 'adress',
    next: 'WAIT_ADRESS_UNLOAD',
    prompt: 'Укажите адресс выгрузки (город, улица, дом, подъезд):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_ADRESS_UNLOAD: {
    save: 'adressUnload',
    after: async (ctx, session) => {
      session.step = '';
      await ctx.reply(
        'Есть ли промежуточные адреса погрузки/выгрузки',
        { attachments: [intermediateKeyboard], format: 'markdown' }
      );
    }
  },
  WAIT_ADRESS_INTERMEDIATE: {
    save: 'intermediateAdress',
    // Телефон отправителя теперь спрашивается сразу после ФИО (см. WAIT_NAME
    // выше), поэтому здесь сразу переходим к вопросу про получателя.
    after: async (ctx, session) => {
      session.step = '';
      await ctx.reply(
        'Грузополучатель и Грузоотправитель одно лицо?',
        { attachments: [consigneeKeyboard], format: 'markdown' }
      );
    }
  },
  WAIT_CONSIGNEE_NAME: {
    save: 'consigneename',
    next: 'WAIT_CONSIGNEE_PHONE',
    prompt: 'Введите номер телефона получателя',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_CONSIGNEE_PHONE: {
    save: 'consigneephone',
    validate: validatePhone,
    next: 'WAIT_WEIGHT',
    prompt: 'Наименование груза, ориентировочный вес/объем груза (например, "холодильник 100кг, 1 коробка картонная"):',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_WEIGHT: {
    // Раньше здесь по ошибке было save: 'consigneename' — вес нигде не
    // сохранялся, а ФИО получателя затиралось введённым весом. Исправлено.
    save: 'weight',
    after: async (ctx, session) => {
      // Про этаж спрашиваем только если в выбранной услуге были грузчики
      // (флаг hasLoader ставится в обработчике service_type_ ниже).
      if (session.data.hasLoader) {
        session.step = '';
        await ctx.reply('Нужен ли будет подъем/спуск на этаж', { attachments: [loaderFloorKeyboard], format: 'markdown' });
        return;
      }

      session.step = 'WAIT_DETAILS';
      await ctx.reply(ORDER_DETAILS_PROMPT, { attachments: [skipDetailsKeyboard], format: 'markdown' });
    }
  },
  WAIT_DETAILS: {
    save: 'details',
    after: async (ctx, session) => {
      await proceedAfterDetails(ctx, session);
    }
  }
};

// --- КАПЧА "ВЫ ЧЕЛОВЕК?" ---
// Показываем 5 слов (4 про грузоперевозки + 1 постороннее), просим нажать
// на лишнее. Правильный ответ на время ожидания храним в памяти (captchaState),
// а сам факт "прошёл/не прошёл" и бан — в БД (db.js), чтобы пережить рестарт бота.

async function sendCaptcha(ctx, userId) {
  const { words, correctIndex } = buildCaptchaChallenge();
  captchaState[userId] = { correctIndex };

  const keyboard = Keyboard.inlineKeyboard(
    words.map((word, i) => [Keyboard.button.callback(word, `captcha_${i}`)])
  );

  await ctx.reply(
    '🤖 Прежде чем начать — небольшая проверка, что вы не бот.\n\n' +
    'Выберите слово, которое НЕ относится к грузоперевозкам:',
    { attachments: [keyboard], format: 'markdown' }
  );
}

// Переводит миллисекунды бана в человекочитаемую подпись
function formatTimeLeft(untilTimestamp) {
  const msLeft = untilTimestamp - Date.now();
  const minutesLeft = Math.max(1, Math.ceil(msLeft / 60000));

  return minutesLeft > 60
    ? `${Math.ceil(minutesLeft / 60)} ч.`
    : `${minutesLeft} мин.`;
}

// ГЛОБАЛЬНЫЙ ГЕЙТ. Регистрируется через bot.use() ПЕРЕД всеми остальными
// обработчиками (bot.command/bot.action/bot.on ниже) — а в этом SDK
// порядок регистрации и есть порядок прохождения апдейта по цепочке.
// Поэтому именно расположение этого блока в файле (в самом начале, до
// bot.command('start', ...)) и заставляет капчу перехватывать вообще всё.
bot.use(async (ctx, next) => {
  const { userId } = getUserData(ctx);
  if (!userId) return next();

  // Капча — это проверка клиентов, а не админ-чата. Иначе и /orders,
  // и вообще любое действие админов упиралось бы в "докажите, что вы не бот".
  if (ctx.chatId === ADMIN_CHAT_ID) return next();

  // Нажатие на саму капчу должно дойти до своего обработчика ниже,
  // иначе пользователь никогда не сможет её пройти.
  // Важно: в этом SDK payload нажатой кнопки лежит в ctx.callback.payload
  // (а не ctx.callbackQuery.data, как в Telegram-подобных библиотеках —
  // такого поля тут просто нет, отсюда и было зацикливание капчи).
  const actionData = ctx.callback?.payload || ctx.update?.callback?.payload;
  if (typeof actionData === 'string' && actionData.startsWith('captcha_')) {
    return next();
  }

  const status = getUserStatus(userId);

  if (status.permanentBan) {
    await ctx.reply('🚫 Доступ к боту заблокирован навсегда за многократные провалы проверки.', { format: 'markdown' });
    return;
  }

  if (status.bannedUntil && status.bannedUntil > Date.now()) {
    await ctx.reply(`⏳ Слишком много неверных попыток. Попробуйте снова через ${formatTimeLeft(status.bannedUntil)}.`, { format: 'markdown' });
    return;
  }

  if (!status.verified) {
    await sendCaptcha(ctx, userId);
    return;
  }

  return next();
});

bot.action(/^captcha_/, async (ctx) => {
  const { userId } = getUserData(ctx);
  if (!userId) return;

  const rawData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  const chosenIndex = Number(String(rawData).replace('captcha_', ''));

  const pending = captchaState[userId];
  delete captchaState[userId];

  if (!pending) {
    // Капча "протухла" (например, бот перезапускался прямо в этот момент) —
    // просто выдаём новую, вместо того чтобы упасть с ошибкой.
    await sendCaptcha(ctx, userId);
    return;
  }

  if (chosenIndex === pending.correctIndex) {
    markVerified(userId);
    await navigateTo(
      ctx,
      'Проверка пройдена ✅\n\n' +
      'Привет! Я бот логистического центра ГУП "Почта Таврии". Помогу оформить заявку на грузоперевозку. Выберите, что нужно:',
      startKeyboard
    );
    return;
  }

  const { failCount, bannedUntil, permanentBan } = registerFailedAttempt(userId);

  if (permanentBan) {
    await replyAndClear(ctx, '🚫 Неверно. Доступ к боту заблокирован навсегда.');
    return;
  }

  const label = failCount === 1
    ? `${Math.max(1, Math.ceil((bannedUntil - Date.now()) / 60000))} мин.`
    : formatTimeLeft(bannedUntil);

  await replyAndClear(ctx, `❌ Неверно. Попробуйте снова через ${label}.`);
});

// Обработчик комманд. Он должен стоять ПЕРЕД обработчиком строк, короче если захочется еще каких-нить комманд добавить - пихайте под старт

async function sendWelcome(ctx, userId) {
  if (userId) delete userSessions[userId];

  await ctx.reply(
    'Привет! Я бот логистического центра ГУП "Почта Таврии". Помогу  оформить заявку на грузоперевозку. Выберите, что нужно:',
    { attachments: [startKeyboard], format: 'markdown' }
  );
}

bot.command('start', async (ctx) => {
  const { userId } = getUserData(ctx);
  await sendWelcome(ctx, userId);
});

// Кнопка "Начать" в самом интерфейсе MAX (когда человек первый раз открывает
// бота) — это ОТДЕЛЬНЫЙ тип апдейта bot_started, а не текстовая команда
// /start. Раньше он вообще никак не обрабатывался, поэтому при нажатии
// именно этой кнопки бот молчал — визуально выглядело как "не запускается".
bot.on('bot_started', async (ctx) => {
  const { userId } = getUserData(ctx);
  await sendWelcome(ctx, userId);
});

// /orders — ТОЛЬКО в чате админов. Вместо того чтобы сразу вываливать все
// активные заявки, сначала показываем даты погрузки (на которые есть хоть
// одна активная заявка), от ближайшей к самой поздней — начиная с сегодня.
// Выбор конкретной даты — уже отдельным нажатием, см. orders_date_ ниже.
bot.command('orders', async (ctx) => {
  if (ctx.chatId !== ADMIN_CHAT_ID) {
    // Не отвечаем вообще — не подсказываем посторонним, что такая команда есть.
    return;
  }

  const orders = getActiveOrders(200);

  if (orders.length === 0) {
    await ctx.reply('🟢 Активных заявок нет.', { format: 'markdown' });
    return;
  }

  // Группируем по календарному дню погрузки (не по дню подачи заявки —
  // админу для планирования важно, на какую дату что запланировано)
  const dateGroups = new Map(); // timestamp полуночи -> { label, count }

  for (const order of orders) {
    const info = getOrderDateInfo(order.data.date);
    if (!info) continue; // на всякий случай, если в старых заявках дата не по формату

    const existing = dateGroups.get(info.timestamp);
    dateGroups.set(info.timestamp, { label: info.label, count: (existing?.count || 0) + 1 });
  }

  if (dateGroups.size === 0) {
    await ctx.reply('Не удалось определить даты погрузки активных заявок.', { format: 'markdown' });
    return;
  }

  const todayTimestamp = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

  const sortedTimestamps = [...dateGroups.keys()].sort((a, b) => a - b);

  const buttons = sortedTimestamps.map((timestamp) => {
    const { label, count } = dateGroups.get(timestamp);
    const isToday = timestamp === todayTimestamp;
    const isOverdue = timestamp < todayTimestamp;
    const prefix = isOverdue ? '⚠️ ' : (isToday ? '▶️ Сегодня, ' : '');

    return [Keyboard.button.callback(`${prefix}${label} (${count})`, `orders_date_${timestamp}`)];
  });

  await ctx.reply(
    '📅 **Выберите дату погрузки, чтобы посмотреть активные заявки:**\n' +
    '⚠️ — дата уже прошла, а заявка всё ещё активна.',
    { attachments: [Keyboard.inlineKeyboard(buttons)], format: 'markdown' }
  );
});

// Показ активных заявок на выбранную дату — каждая отдельной карточкой
// с кнопками "Закрыть" / "Отменить".
bot.action(/^orders_date_/, async (ctx) => {
  if (ctx.chatId !== ADMIN_CHAT_ID) return;

  const rawData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  const targetTimestamp = Number(String(rawData).replace('orders_date_', ''));

  const orders = getActiveOrders(200).filter((order) => {
    const info = getOrderDateInfo(order.data.date);
    return info && info.timestamp === targetTimestamp;
  });

  if (orders.length === 0) {
    await replyAndClear(ctx, 'На эту дату активных заявок не найдено (возможно, их уже обработали).');
    return;
  }

  const dateLabel = getOrderDateInfo(orders[0].data.date)?.label || '';

  try {
    await ctx.deleteMessage(); // убираем экран с выбором даты
  } catch (e) {
    // Игнорируем, если уже удалено
  }

  await ctx.reply(`📦 **Заявки на ${dateLabel} (${orders.length}):**`, { format: 'markdown' });

  for (const order of orders) {
    await ctx.reply(
      buildOrderCardText(order),
      { attachments: [adminOrderKeyboard(order.id)], format: 'markdown' }
    );
  }
});

// Админ закрывает заявку (считает выполненной) или отменяет её.
// Обе кнопки живут только в чате админов — доп. проверка на всякий случай,
// если payload вдруг придёт откуда-то ещё.
bot.action(/^admin_close_/, async (ctx) => {
  if (ctx.chatId !== ADMIN_CHAT_ID) return;

  const rawData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  const orderId = Number(String(rawData).replace('admin_close_', ''));
  const order = getOrderById(orderId);

  if (!order) {
    await replyAndClear(ctx, 'Заявка не найдена (возможно, уже обработана).');
    return;
  }

  updateOrderStatus(orderId, 'closed');

  // Уведомляем клиента, что заявка выполнена — как и при отмене, только
  // с другим текстом (закрыл её админ = заявка выполнена, не отменена).
  try {
    await bot.api.sendMessageToUser(
      order.userId,
      `✅ Ваша заявка №${orderId} выполнена. Спасибо, что обратились в ГУП "Почта Таврии"!`,
      { format: 'markdown' }
    );
  } catch (err) {
    console.error('Не удалось уведомить клиента о закрытии заявки админом:', err.message || err);
  }

  await replyAndClear(ctx, `✅ Заявка №${orderId} закрыта.`);
});

bot.action(/^admin_cancel_/, async (ctx) => {
  if (ctx.chatId !== ADMIN_CHAT_ID) return;

  const rawData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  const orderId = Number(String(rawData).replace('admin_cancel_', ''));
  const order = getOrderById(orderId);

  if (!order) {
    await replyAndClear(ctx, 'Заявка не найдена (возможно, уже обработана).');
    return;
  }

  updateOrderStatus(orderId, 'cancelled');

  // Уведомляем клиента, что его заявку отменили — чтобы он не ждал впустую.
  try {
    await bot.api.sendMessageToUser(
      order.userId,
      `⚠️ Ваша заявка №${orderId} была отменена менеджером. Если это неожиданно — свяжитесь с нами: +7 990 170 70 00.`,
      { format: 'markdown' }
    );
  } catch (err) {
    console.error('Не удалось уведомить клиента об отмене заявки админом:', err.message || err);
  }

  await replyAndClear(ctx, `❌ Заявка №${orderId} отменена.`);
});

// Это обработчик мать его строк. Ебанет? Не должно, но может.
bot.on('message_created', async (ctx) => {
  const { userId } = getUserData(ctx);
  if (!userId) return;

  const session = userSessions[userId];
  if (!session || !session.step) return;

  // Особый случай: на этом шаге мы ждём фото, а не текст, поэтому
  // достаём его из attachments и дальше не идём по обычной текстовой ветке.
  if (session.step === 'WAIT_PHOTO') {
    await handlePhotoStep(ctx, session, userId);
    return;
  }

  // Извлекаем текст из всех возможных полей MAX API
  const text =
    ctx.message?.body?.text ||
    ctx.message?.text ||
    ctx.body?.text ||
    ctx.update?.message?.body?.text;

  if (!text) return;

  const stepConfig = TEXT_STEPS[session.step];
  if (!stepConfig) return; // неизвестный/пустой шаг — просто игнорируем сообщение

  // Клавиатура текущего шага — нужна и для обычного prompt, и для
  // повторного показа при ошибке валидации/ссылке.
  const currentKeyboard = stepConfig.keyboard ? stepConfig.keyboard() : backToMenuKeyboard;

  // Запрет на ссылки действует на любое текстовое поле анкеты.
  if (containsLink(text)) {
    await ctx.reply(
      '❌ Ссылки в заявке использовать нельзя. Перепишите сообщение без ссылок.',
      { attachments: [currentKeyboard], format: 'markdown' }
    );
    return;
  }

  if (stepConfig.validate) {
    const validation = stepConfig.validate(text);
    if (validation !== true) {
      await ctx.reply(validation, { attachments: [currentKeyboard], format: 'markdown' });
      return;
    }
  }

  session.data[stepConfig.save] = text;

  if (stepConfig.after) {
    await stepConfig.after(ctx, session, userId);
    return;
  }

  session.step = stepConfig.next;
  await ctx.reply(stepConfig.prompt, { attachments: [stepConfig.keyboard()], format: 'markdown' });
});

// Подстраховка на случай, если SDK использует название 'message'
bot.on('message', async (ctx) => {
  // Вызываем ту же логику через виртуальное событие
  if (ctx.updateType !== 'message_created') {
    bot.emit('message_created', ctx);
  }
});

// --- ОБРАБОТЧИКИ НАВИГАЦИИ ---

bot.action('main_menu', async (ctx) => {
  const { userId } = getUserData(ctx);
  if (userId) delete userSessions[userId];

  await navigateTo(
    ctx,
    'Главное меню логистического центра ГУП "Почта Таврии". Выберите необходимое действие:',
    startKeyboard
  );
});

bot.action('show_tariffs', async (ctx) => {
  await navigateTo(
    ctx,
    'Тарифы разделены по категориям клиентов. Выберите категорию, чтобы увидеть детали:',
    tariffsKeyboard
  );
});

bot.action('tariffs_individuals', async (ctx) => {
  const { userId } = getUserData(ctx);

  // Инициализируем сессию и фиксируем контрагента
  if (!userSessions[userId]) userSessions[userId] = { data: {} };
  if (!userSessions[userId].data) userSessions[userId].data = {};

  userSessions[userId].data.counterparty = '👤 Физическое лицо';

  await navigateTo(
    ctx,
    await getTariffs("individuals"),
    tariffOrderKeyboard
  );
});

bot.action('tariffs_legal', async (ctx) => {
  const { userId } = getUserData(ctx);

  // Инициализируем сессию и фиксируем контрагента
  if (!userSessions[userId]) userSessions[userId] = { data: {} };
  if (!userSessions[userId].data) userSessions[userId].data = {};

  userSessions[userId].data.counterparty = '🏢 Юридическое лицо';

  await navigateTo(
    ctx,
    await getTariffs("legal"),
    tariffOrderKeyboard
  );
});

bot.action('create_order', async (ctx) => {
  const { userId, fullName } = getUserData(ctx);

  // Лимит: не больше 3 УЖЕ ОТПРАВЛЕННЫХ заявок в день. Незавершённые
  // (брошенные на середине) анкеты в счёт не идут — считаем только то,
  // что реально долетело до менеджера (см. logOrder в finishOrder).
  if (countOrdersToday(userId) >= 3) {
    await navigateTo(
      ctx,
      '🚫 Вы уже оформили максимум заявок на сегодня (3 шт.).\n\n' +
      'Новую заявку можно будет отправить завтра. Если нужно срочно — ' +
      'позвоните напрямую: +7 990 170 70 00.',
      startKeyboard
    );
    return;
  }

  // Инициализируем сессию, сохраняя ранее выбранные данные (если они были)
  const existingData = userSessions[userId]?.data || {};

  userSessions[userId] = {
    step: '',
    data: {
      fullName,
      ...existingData
    }
  };

  const session = userSessions[userId];

  // ПРОВЕРКА: Если контрагент еще НЕ выбран — спрашиваем первым делом
  if (!session.data.counterparty) {
    session.step = 'SELECT_COUNTERPARTY';

    await navigateTo(
      ctx,
      SERVICE_AREA_NOTICE +
      `Здравствуйте, ${fullName}!\n\n` +
      `Укажите тип вашего контрагента для оформления заявки:`,
      counterpartyKeyboard
    );
    return;
  }

  session.step = 'SELECT_TYPE';
  await navigateTo(
    ctx,
    SERVICE_AREA_NOTICE +
    `Контрагент: ${session.data.counterparty}\n\n📦 Теперь выберите тип услуги:`,
    serviceTypeKeyboard
  );
});

bot.action(/^select_counterparty_/, async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  if (session.step !== 'SELECT_COUNTERPARTY') {
    await navigateTo(ctx, 'Сессия устарела. Начните заново.', startKeyboard);
    return;
  }

  const actionData = ctx.callback?.payload || ctx.update?.callback?.payload;
  const isJur = actionData === 'select_counterparty_jur';

  // 1. Сохраняем контрагента
  session.data.counterparty = isJur ? '🏢 Юридическое лицо' : '👤 Физическое лицо';

  // 2. Переводим на шаг выбора услуги (вместо WAIT_PHONE)
  session.step = 'SELECT_TYPE';

  // 3. Отправляем клавиатуру выбора услуги
  await navigateTo(
    ctx,
    `Контрагент: ${session.data.counterparty}\n\n📦 Теперь выберите тип услуги:`,
    serviceTypeKeyboard
  );
});

bot.action(/^service_type_/, async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  if (session.step !== 'SELECT_TYPE') {
    await navigateTo(ctx, 'Сессия устарела. Начните заново.', startKeyboard);
    return;
  }

  // 1. Достаем ПОЛНУЮ строку кнопки (без обрезки по регулярке)
  const rawData =
    ctx.callback?.payload ||
    ctx.match?.input ||
    ctx.update?.callback?.payload;

  const actionData = String(rawData || '');

  let selectedService = null;

  // 2. Проверяем значения
  if (actionData.includes('car_driver')) {
    selectedService = 'Перевозка груза (авто + водитель)';
  } else if (actionData.includes('loader_floor')) {
    selectedService = 'Перевозка груза + грузчики + подъем на этаж';
  } else if (actionData.includes('transport_loader')) {
    selectedService = 'Перевозка груза + грузчики';
  } else if (actionData.includes('loader')) {
    selectedService = 'Только услуги грузчиков';
  }

  session.data.service = selectedService;
  // Запоминаем, была ли выбрана услуга с грузчиками — этот флаг решит,
  // нужно ли позже (после вопроса про вес) спрашивать про этаж.
  session.data.hasLoader = actionData.includes('loader');

  if (!selectedService) {
    console.error('Не удалось распознать услугу:', actionData);
    await navigateTo(ctx, 'Не удалось распознать выбор. Попробуйте еще раз.', serviceTypeKeyboard);
    return;
  }

  // Вопрос про этаж переехал к вопросу про вес/объём груза (см. WAIT_WEIGHT.after),
  // поэтому здесь сразу переходим к вводу ФИО/реквизитов.
  await goToNameStep(ctx, session, `Вы выбрали: ${session.data.service}\n\n`);
});

bot.action('yes_load_floor', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.step = 'WAIT_FLOOR';
  await navigateTo(
    ctx,
    'Напишите на какой этаж нужно поднять/спустить груз',
    backToMenuKeyboard
  );
});

bot.action('no_load_floor', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.floor = '—';
  session.data.floorItems = '—';
  session.step = 'WAIT_DETAILS';
  await navigateTo(ctx, ORDER_DETAILS_PROMPT, skipDetailsKeyboard);
});

bot.action('intermediate_adress', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.step = 'WAIT_ADRESS_INTERMEDIATE';
  await navigateTo(
    ctx,
    'Введите промежуточные адреса для погрузки/выгрузки',
    backToMenuKeyboard
  );
});

bot.action('intermediate_no_adress', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.intermediateAdress = '—';
  session.step = '';

  await navigateTo(
    ctx,
    'Грузополучатель и Грузоотправитель одно лицо?',
    consigneeKeyboard
  );
});

bot.action('consignee_is_consignor', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  // Грузополучатель = грузоотправитель, поэтому его ФИО/телефон не спрашиваем
  session.data.consigneename = session.data.name;
  session.data.consigneephone = session.data.phone;
  session.step = 'WAIT_WEIGHT';

  await navigateTo(
    ctx,
    // Раньше здесь был текст про "промежуточные адреса" — скопированный не
    // из того места. Исправлено на вопрос, который реально ждёт WAIT_WEIGHT.
    'Наименование груза, ориентировочный вес/объем груза (например, "холодильник 100кг, 1 коробка картонная"):',
    backToMenuKeyboard
  );
});

bot.action('consignee_no_consignor', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.step = 'WAIT_CONSIGNEE_NAME';

  await navigateTo(
    ctx,
    'Введите ФИО получателя:',
    // Раньше здесь была intermediateKeyboard (кнопки Да/Нет), хотя ждём
    // текстовый ввод ФИО — пользователю не на что было нажать. Исправлено.
    backToMenuKeyboard
  );
});

bot.action('skip_details', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.details = '—';
  await proceedAfterDetails(ctx, session);
});

bot.action('skip_photo', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  await proceedAfterPhoto(ctx, session, userId);
});

bot.action('payment_cash', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.payment = 'Наличными';
  await showOrderSummary(ctx, session);
});

bot.action('payment_cashless', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.payment = 'Безналичный расчет';
  await showOrderSummary(ctx, session);
});

// Финальное подтверждение — только отсюда заявка реально уходит в чат.
bot.action('confirm_order', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  // Убираем сам экран "Проверьте данные перед отправкой" — дальше уже
  // либо "Заявка принята", либо сообщение об ошибке (см. finishOrder).
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Игнорируем, если сообщение уже удалено
  }

  await finishOrder(ctx, session, userId);
});

bot.action('my_orders', async (ctx) => {
  const { userId } = getUserData(ctx);
  const orders = getUserOrders(userId, 10);

  // Убираем экран меню, из которого нажали "Мои заказы" — дальше идёт
  // либо одно сообщение (если заявок нет), либо несколько (карточки).
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Игнорируем, если уже удалено
  }

  if (orders.length === 0) {
    await ctx.reply('У вас пока нет отправленных заявок.', { attachments: [startKeyboard], format: 'markdown' });
    return;
  }

  const activeOrders = orders.filter((o) => o.status === 'active');
  const pastOrders = orders.filter((o) => o.status !== 'active');

  // Активные — отдельной карточкой с кнопкой отмены на каждую, чтобы
  // было сразу понятно, какую именно заявку отменяешь.
  for (const order of activeOrders) {
    await ctx.reply(
      buildOrderCardText(order),
      { attachments: [userOrderKeyboard(order.id)], format: 'markdown' }
    );
  }

  // Прошлые (отменённые/закрытые) — одним компактным списком, без кнопок.
  const historyText = pastOrders.length > 0
    ? `📋 **Прошлые заявки (${pastOrders.length}):**\n\n${pastOrders.map(buildOrderCardText).join('\n\n')}`
    : (activeOrders.length > 0 ? 'Прошлых заявок пока нет.' : 'У вас пока нет отправленных заявок.');

  await ctx.reply(historyText, { attachments: [startKeyboard], format: 'markdown' });
});

// Пользователь отменяет СВОЮ заявку. Владельца проверяем по userId в
// записи заказа — иначе кто угодно, подобрав id, мог бы отменить чужую.
// Всё тело обёрнуто в try/catch с логом: если тут что-то падает молча,
// пользователь раньше просто не получал вообще никакого ответа — теперь
// в худшем случае увидит "Не получилось..." и мы увидим причину в логах.
bot.action(/^user_cancel_/, async (ctx) => {
  try {
    const { userId } = getUserData(ctx);
    if (!userId) return;

    const rawData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
    const orderId = Number(String(rawData).replace('user_cancel_', ''));

    if (!Number.isFinite(orderId)) {
      console.error('user_cancel_: не удалось распознать id заказа из payload:', rawData);
      await replyAndClear(ctx, 'Не получилось определить заявку. Откройте «Мои заказы» ещё раз.');
      return;
    }

    const order = getOrderById(orderId);

    if (!order || order.userId !== userId) {
      await replyAndClear(ctx, 'Заявка не найдена.');
      return;
    }

    if (order.status !== 'active') {
      await replyAndClear(ctx, `Эта заявка уже не активна (текущий статус: ${ORDER_STATUS_LABELS[order.status] || order.status}).`);
      return;
    }

    updateOrderStatus(orderId, 'cancelled');

    // Сообщаем админам, что клиент сам отменил заявку — чтобы менеджер
    // не тратил время на её обработку.
    try {
      await bot.api.sendMessageToChat(
        ADMIN_CHAT_ID,
        `🚫 Клиент отменил заявку №${orderId}.\nТелефон: ${order.data?.phone || '—'}`,
        { format: 'markdown' }
      );
    } catch (err) {
      console.error('Не удалось уведомить админов об отмене заявки клиентом:', err.message || err);
    }

    await replyAndClear(ctx, `Заявка №${orderId} отменена.`);
  } catch (err) {
    console.error('🔥 Ошибка при отмене заявки пользователем:', err);
    try {
      await ctx.reply('⚠️ Не получилось отменить заявку из-за временного сбоя. Попробуйте ещё раз через минуту.', { format: 'markdown' });
    } catch (replyErr) {
      console.error('🔥 Не удалось даже уведомить об ошибке отмены:', replyErr);
    }
  }
});

bot.action('show_contacts', async (ctx) => {
  await navigateTo(
    ctx,
    '📞 Контакты ГУП "Почта Таврии":\n\n• Телефон: +7990-170-70-00\n• Режим работы: Пн-Пт с 8:00 до 17:00\n• Ссылка на бота: https://max.ru/logistics_tavriyapost_bot',
    backToMenuKeyboard
  );
});

bot.action('faq', async (ctx) => {
  await navigateTo(
    ctx,
    'Ниже приведены наиболее часто задаваемые вопросы:',
    faqKeyboard
  );
});

// Один общий обработчик для ВСЕХ вопросов FAQ — тексты ответов лежат в
// FAQ_ANSWERS выше. Новый вопрос = новая кнопка + новая запись в словаре,
// сюда лезть больше не нужно.
bot.action(/^faq_/, async (ctx) => {
  const rawData =
    ctx.callback?.payload ||
    ctx.match?.input ||
    ctx.update?.callback?.payload;

  const actionData = String(rawData || '');
  const answer = FAQ_ANSWERS[actionData];

  if (!answer) {
    console.error('Не найден ответ FAQ для:', actionData);
    return;
  }

  await navigateTo(ctx, answer, backToFAQKeyboard);
});

bot.catch((err) => {
  console.error('Ошибка бота:', err);
});

bot.start();
console.log('Бот ГУП "Почта Таврии" запущен!');