//   ██████╗██████╗ ███████╗ █████╗ ████████╗███████╗██████╗     ██████╗  ██╗   ██╗
//  ██╔════╝██╔══██╗██╔════╝██╔══██╗╚══██╔══╝██╔════╝██╔══██╗    ██╔══██╗  ██╗ ██╔╝
//  ██║     ██████╔╝█████╗  ███████║   ██║   █████╗  ██║  ██║    ██████╔╝   ████╔╝ 
//  ██║     ██╔══██╗██╔══╝  ██╔══██║   ██║   ██╔══╝  ██║  ██║    ██╔══██╗    ██╔╝  
//   ██████╗██║  ██║███████╗██║  ██║   ██║   ███████╗██████╔╝    ██████╔╝    ██║   
//   ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═════╝     ╚═════╝     ╚═╝   
//
//  ██████╗ ███████╗███╗   ██╗██╗ █████╗  ▄█████╗
//  ██╔══██╗██╔════╝████╗  ██║██║██╔══██╗██╔════╝
//  ██║  ██║█████╗  ██╔██╗ ██║██║██║  ██║██║  ███╗
//  ██║  ██║██╔══╝  ██║╚██╗██║██║██║  ██║██║   ██║
//  ██████╔╝███████╗██║ ╚████║██║ █████╔╝╚██████╔╝
//  ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝ ╚════╝  ╚═════╝
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
import { getUserStatus, markVerified, registerFailedAttempt } from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const userSessions = {}; 

// Тут храним ТОЛЬКО номер правильного ответа для текущей капчи, пока
// пользователь не ответил. Это не БД: если бот перезапустится в момент,
// когда человек как раз смотрит на капчу, ему просто пришлют новую —
// это не страшно, в отличие от статуса "прошёл/не прошёл", который
// обязательно должен пережить перезапуск (он в db.js).
const captchaState = {};

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

  const text = `🚚 *Тарифы для ${clientName} лиц:*\n\n` +
               `    *Почасовая тарификация (по г. Мелитополю району в радиусе 10-15 км.)*\n` +
               `• Почасовая аренда авто — *${price} ₽/час*\n` +
               `• Минимальный заказ (автомобиль 2 часа) — *${min_order} ₽/час*\n\n` +
               `  *Покилометровая аренда автомобиля (от 100 км.)*\n` +
               `• Стоимость за 1 км — *${km_order} ₽/час*\n` +
               `• Простой при тарифе за км — *${wait_order} ₽/час*\n\n` +
               `📦 *Услуги грузчиков*\n` +
               `• Грузчик стандарт — *${loader_standard} ₽/час\n*` +
               `• ПРР повышеной сложности — *${loader_hard} ₽/час*`;

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
async function finishOrder(ctx, session, userId) {
  const {
    name, consigneename, counterparty, service, floor, floorItems, phone,
    consigneephone, date, adress, intermediateAdress, details,
    adressUnload, weight, orgName, inn, payment, photoToken
  } = session.data;

  // Строки про организацию показываем в заявке только если это юрлицо
  const orgLines = orgName
    ? `🏢 Организация: ${orgName}\n` +
      `🧾 ИНН: ${inn || 'Не указан'}\n`
    : '';

  const adminMessage =
    `🚨 НОВАЯ ЗАЯВКА НА ПЕРЕВОЗКУ\n\n` +
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
    `⚖️ Вес/объем груза: ${weight || 'Не указан'}\n` +
    `💳 Оплата: ${payment || 'Безналичный расчет (юрлицо)'}\n` +
    `📦 Детали заказа:\n${details}`;

  // Если пользователь прислал фото груза — прикрепляем его к тому же
  // сообщению в чат с заявками (по токену, без повторной загрузки файла).

  const adminAttachments = photoToken
    ? [new ImageAttachment({ token: photoToken }).toJson()]
    : [];

  try {
    const targetChatId = Number(process.env.ADMIN_CHAT_ID);

    await bot.api.sendMessageToChat(targetChatId, adminMessage, { attachments: adminAttachments, format: 'markdown' });

    await ctx.reply(
      '✅ Ваша заявка принята!\n\nМенеджер уже обрабатывает данные и свяжется с вами в ближайшее время.',
      { attachments: [backToMenuKeyboard], format: 'markdown' }
    );
  } catch (err) {
    console.error('🔥 Ошибка отправки админам:', err);
    await ctx.reply(
      '⚠️ Произошла ошибка при отправке заявки. Попробуйте позже.',
      { attachments: [backToMenuKeyboard], format: 'markdown' }
    );
  }

  delete userSessions[userId];
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

  await finishOrder(ctx, session, userId);
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
  [Keyboard.button.callback('Контакты', 'show_contacts')],
  [Keyboard.button.callback('Часто задаваемые вопросы', 'faq')]
]);

const tariffsKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('Физлица', 'tariffs_individuals'),
    Keyboard.button.callback('Юрлица', 'tariffs_legal')
  ],
  [Keyboard.button.callback('Посмотреть тарифы', 'tariffs_imamge')],
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

// --- ОТВЕТЫ FAQ (данные, а не код — просто добавляй новые пары id: текст) ---

const FAQ_ANSWERS = {
  faq_floor:
    '❓ *Как рассчитывается подъем/спуск на этаж?*\n\n' +
    ' • Тип груза — учитываются габариты и хрупкость, а также применяются повышающие коэффициенты в зависимости от категории груза (например, для негабаритных или особо хрупких предметов ставка увеличивается).\n' +
    ' • Тоннаж — чем тяжелее груз, тем больше времени и людей требуется для перемещения, что влияет на итоговую стоимость.\n' +
    ' • Количество этажей и наличие лифта.\n' +
    ' • Если в доме работает грузовой лифт — доплата за работу с лифтом 0 ₽. Если лифта нет или груз в него не помещается — расчет идет по этажам вручную с учетом коэффициентов.\n' +
    'Подъем на этаж рассчитывается отдельно — это не входит в часовую услугу грузчиков.\n' +
    'Точную стоимость менеджер назовет после уточнения параметров груза. Если у вас есть фото груза — приложите его к заявке, это ускорит расчет.',

  faq_prr:
    '❓ *Что входит в ПРР?*\n\n ПРР повышенной сложности применяется, если: Груз тяжелый, габаритный или неделимый — к данной категории относятся Крупная бытовая техника, Сейфы, Пианино, Цельная габаритная неразборная мебель.\n' +
    ' Подъем на этаж рассчитывается отдельно — это не входит в ПРР.',

  faq_min:
    '❓ *Какой минимальный заказ?*\n\n' +
    ' • Минимальный заказ зависит от типа услуги:\n' +
    ' • Почасовая аренда авто — минимум 2 часа\n' +
    ' • Покилометровая тарификация — от 100 км\n' +
    ' • Услуги грузчиков — минимум 1 часа на человека.\n' +
    ' Если фактическое время работы меньше минимального — оплата все равно за минимальное количество часов.',

  faq_auto:
    '❓ *Какой транспорт доступен?*\n\n Основной транспорт — ГАЗ «Валдай 8»:\n' +
    ' • Грузоподъемность — до 3,2 тонн\n' +
    ' • Закрытый изотермический кузов\n' +
    ' • Подходит для перевозки мебели, стройматериалов, оборудования, переездов, товаров',

  faq_cancel:
    '❓ *Как отменить или изменить заявку?*\n\n Заявку можно изменить или отменить несколькими способами:\n' +
    ' • Позвонить по номеру +7 (990) 170 70 00 — это быстрее всего\n' +
    ' • Написать в этот чат — бот передаст сообщение менеджеру.\n' +
    ' Рекомендуем сообщать об отмене или изменениях как можно раньше — минимум за 2–3 часа до подачи авто. Если машина уже выехала по адресу, может потребоваться оплата минимального заказа.',

  faq_payment:
    '❓ *Можно ли оплатить безналичным расчетом?*\n\n Да. Способы оплаты зависят от типа клиента:\n' +
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
  'ℹ️ *Тарификация: покилометровая.*\n' +
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
    keyboard: () => backToMenuKeyboard
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
    prompt: 'Укажите желаемую дату и время погрузки',
    keyboard: () => backToMenuKeyboard
  },
  WAIT_DATE: {
    save: 'date',
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
    prompt: 'Ориентировочный вес/объем груза (например, "200 кг, 3 коробки"):',
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
      await ctx.reply(ORDER_DETAILS_PROMPT, { attachments: [backToMenuKeyboard], format: 'markdown' });
    }
  },
  WAIT_DETAILS: {
    save: 'details',
    after: async (ctx, session) => {
      session.step = 'WAIT_PHOTO';
      await ctx.reply(
        'Если есть фото груза — пришлите его сюда, это ускорит расчет. Либо нажмите «Пропустить».',
        { attachments: [skipPhotoKeyboard], format: 'markdown' }
      );
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

bot.command('start', async (ctx) => {
  const { userId } = getUserData(ctx);
  if (userId) delete userSessions[userId];

  await ctx.reply(
    'Привет! Я бот логистического центра ГУП "Почта Таврии". Помогу  оформить заявку на грузоперевозку. Выберите, что нужно:',
    { attachments: [startKeyboard], format: 'markdown' }
  );
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
  await navigateTo(ctx, ORDER_DETAILS_PROMPT, backToMenuKeyboard);
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
    'Ориентировочный вес/объем груза (например, "200 кг, 3 коробки"):',
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

//tariffs.jfif

bot.action('tariffs_imamge', async (ctx) =>{
  const image = await ctx.api.uploadImage({ source: '/Images/tariffs.jfif' });
  await ctx.reply('Актуальные тарифы', {
    attachments: [backToMenuKeyboard, image.toJson()],
  });
})

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
  await finishOrder(ctx, session, userId);
});

bot.action('payment_cashless', async (ctx) => {
  const { userId } = getUserData(ctx);
  const session = await requireSession(ctx, userId);
  if (!session) return;

  session.data.payment = 'Безналичный расчет';
  await finishOrder(ctx, session, userId);
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