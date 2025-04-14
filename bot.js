require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio');

// Инициализация бота
const bot = new Bot(process.env.BOT_API_KEY);

// MSAL-конфиг для доступа к Teams
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

// Инициализация БД SQLite
let db;
function initDatabase() {
  db = new sqlite3.Database(path.join(__dirname, 'summaries.db'), (err) => {
    if (err) return console.error('SQLite error:', err);

    // Таблица для хранения сводок об ошибках
    db.run(`
      CREATE TABLE IF NOT EXISTS error_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        message_id TEXT,
        summary_text TEXT,
        details_json TEXT,
        created_at TEXT
      )
    `);

    // Универсальная таблица для любых новостей (из разных источников)
    db.run(`
      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT,
        news_id TEXT,
        title TEXT,
        date TEXT,
        url TEXT,
        content TEXT,
        summary TEXT,
        created_at TEXT,
        UNIQUE(source, news_id)
      )
    `);
  });
}
initDatabase();

/* -----------------------------------------------------
   Переменные для отслеживания Teams-сообщений и ошибок
------------------------------------------------------*/
let lastProcessedMessageId = null;
const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const collectedErrors = [];
const processedErrorSubjects = new Set();
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

// Загрузка сохранённых значений при старте
function loadLastProcessedMessageId() {
  try {
    if (fs.existsSync(lastMessageIdFile)) {
      lastProcessedMessageId = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
    }
  } catch (e) {
    console.error(e);
  }
}
function loadProcessedErrorSubjects() {
  try {
    if (fs.existsSync(processedSubjectsFile)) {
      const arr = JSON.parse(fs.readFileSync(processedSubjectsFile, 'utf8'));
      arr.forEach((s) => processedErrorSubjects.add(s));
    }
  } catch (e) {
    console.error(e);
  }
}
loadLastProcessedMessageId();
loadProcessedErrorSubjects();

// Сохранение последнего ID
async function saveLastProcessedMessageId(id) {
  await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
}

// Сохранение обработанных тем
async function saveProcessedErrorSubjects() {
  await fs.promises.writeFile(
    processedSubjectsFile,
    JSON.stringify([...processedErrorSubjects], null, 2),
    'utf8'
  );
}

// Сброс обработанных тем
async function resetProcessedErrorSubjects() {
  processedErrorSubjects.clear();
  if (fs.existsSync(processedSubjectsFile)) fs.unlinkSync(processedSubjectsFile);
}

// Получаем токен Microsoft (для Teams)
async function getMicrosoftToken() {
  const cca = new ConfidentialClientApplication(msalConfig);
  const tokenRequest = { scopes: ['https://graph.microsoft.com/.default'] };
  try {
    const result = await cca.acquireTokenByClientCredential(tokenRequest);
    return result.accessToken;
  } catch (e) {
    console.error('MS token error:', e);
    return null;
  }
}

/* ----------------------------------------
   1) Логика для получения Teams-сообщений
-----------------------------------------*/
function extractTextContent(message) {
  const raw = message.body?.content || '';
  const text = raw.replace(/<[^>]+>/g, '').trim();
  let sender = 'Неизвестно';
  let subject = 'Без темы';
  let isReply = false;
  let body = '';

  text.split('\n').forEach((line) => {
    line = line.trim();
    if (line.startsWith('Отправитель:')) {
      sender = line.replace('Отправитель:', '').trim();
    } else if (line.startsWith('Тема:')) {
      subject = line.replace('Тема:', '').trim();
      if (/^RE:/i.test(subject)) {
        isReply = true;
        subject = subject.replace(/^RE:/i, '').trim();
      }
    } else {
      body += (body ? '\n' : '') + line;
    }
  });

  // Условный критерий определения "ошибочного" сообщения
  const isError = (
    sender.toLowerCase() === 'noreply@winline.kz'
    && /(ошибка|оповещение|ошибки|ошибочка|error|fail|exception|critical)/i.test(subject + ' ' + body)
  );

  return {
    id: message.id,
    sender,
    subject,
    body,
    isReply,
    isError,
    createdDateTime: message.createdDateTime,
  };
}

// Сортируем ошибки по типам
function getErrorTypeAndIdentifier(msg) {
  const txt = msg.body.toLowerCase();
  if (msg.subject.includes('STOPAZART')) {
    return {
      type: 'STOPAZART',
      id: txt.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден',
    };
  }
  if (msg.subject.includes('SmartBridge')) {
    return {
      type: 'SmartBridge',
      id: txt.match(/номер транзакции\s*([0-9]+)/i)?.[1] || 'не найден',
    };
  }
  if (msg.subject.includes('реестре должников')) {
    return {
      type: 'Реестр должников',
      id: txt.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден',
    };
  }
  return { type: 'Другое', id: 'N/A' };
}

// Получаем список сообщений Teams
async function fetchTeamsMessages(token, teamId, channelId) {
  try {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data.value.map(extractTextContent);
  } catch (e) {
    console.error('Fetch Teams error:', e);
    return [];
  }
}

/* ------------------------------------------------
   2) Промт для нейросети для "обычных" сообщений
      (ОСТАВЛЯЕМ КАК ЕСТЬ — «не ломать»)
-------------------------------------------------*/
async function summarizeMessages(messages, lastMsgId) {
  if (!messages.length) return null;

  const list = messages.map((msg) => {
    const reply = msg.isReply
      ? '\nТип: Ответ (тема из контекста предыдущего сообщения)'
      : '';
    return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${reply}\nТекст сообщения: ${msg.body}`;
  }).join('\n\n');

  // Старый промт, оставляем без изменений
  const prompt = `
(Последний обработанный ID: ${lastMsgId})

Проанализируй следующие сообщения из Teams. Для каждого сообщения, идентифицированного по уникальному ID, составь краткое, точное и понятное резюме, строго опираясь на фактическое содержание. Если сообщение является ответом (Тип: Ответ), обязательно укажи, что оно является ответом и что тема берётся из контекста предыдущего сообщения.

Правила:
1. ID сообщения: обязательно укажи уникальный идентификатор.
2. Отправитель: укажи email отправителя; если возможно, добавь ФИО, должность и название компании (на основе подписи или домена почты).
3. Тема: если тема явно указана или может быть определена из контекста, укажи её. Для ответов укажи, что тема берётся из предыдущего сообщения.
4. Содержание: составь одно-два предложения, точно передающих суть сообщения, сохраняя все технические детали и вопросы. Не пересказывай сообщение слишком сильно.
5. Игнорируй элементы, не влияющие на понимание сути (например, стандартные подписи, ссылки и неинформативные фразы).

Составь резюме для следующих сообщений:

${list}
`.trim();

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 1000,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    return response.data.choices[0]?.message?.content || 'Нет ответа от OpenAI.';
  } catch (err) {
    console.error('OpenAI summarization error (Teams messages):', err);
    return null;
  }
}

/* -------------------------------------------
   3) Промт для нейросети для "новостей"
      (УНИВЕРСАЛЬНЫЙ для разных источников)
--------------------------------------------*/
async function summarizeNewsContent(source, rawText) {
  const prompt = `
У тебя есть текст новости. Источник: ${source}.
Задача: составь краткое и понятное резюме новости (не более 2-3 предложений), передавая основные факты, даты, события, причины или последствия.
Старайся быть лаконичным, без дополнительных вымыслов и субъективных оценок.
Текст новости:
"""
${rawText}
"""
`.trim();

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    return response.data.choices[0]?.message?.content || '';
  } catch (err) {
    console.error('OpenAI summarization error (News):', err);
    return '';
  }
}

/* ----------------------------------------------------------------
   4) Логика для обработки повторяющихся ошибок (Teams) и отправки
      раз в час сводки
-----------------------------------------------------------------*/
async function sendErrorSummaryIfNeeded() {
  if (collectedErrors.length === 0) return;

  const grouped = {};
  collectedErrors.forEach((err) => {
    if (!grouped[err.subject]) {
      grouped[err.subject] = {
        count: 0,
        lastOccurred: err.createdDateTime,
        body: err.body,
      };
    }
    grouped[err.subject].count++;
    grouped[err.subject].lastOccurred = err.createdDateTime;
  });

  let summary = '🔍 *Сводка ошибок за последний час:*\n';
  for (const [subject, data] of Object.entries(grouped)) {
    const lastDate = new Date(data.lastOccurred).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    summary += `📌 *Тема:* ${subject}\n- *Количество:* ${data.count}\n- *Последнее появление:* ${lastDate}\n`;
  }

  const details = collectedErrors.map(e => ({
    type: e.type,
    id: e.extractedId,
    subject: e.subject,
    date: e.createdDateTime,
  }));
  collectedErrors.length = 0;

  const msg = await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, {
    parse_mode: 'Markdown',
    reply_markup: new InlineKeyboard().text('📋 Подробнее', 'show_details_TEMP'),
  });

  const createdAt = new Date().toISOString();
  db.run(`
    INSERT INTO error_summaries (chat_id, message_id, summary_text, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  [
    String(msg.chat.id),
    String(msg.message_id),
    summary,
    JSON.stringify(details),
    createdAt,
  ],
  function (err) {
    if (err) return console.error('DB insert error:', err);
    const summaryId = this.lastID;
    const keyboard = new InlineKeyboard().text('📋 Подробнее', `show_details_${summaryId}`);
    bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: keyboard })
      .catch(e => console.error('Edit markup error:', e));
  });
}

// Обработка свежих сообщений в Teams
async function processTeamsMessages() {
  const token = await getMicrosoftToken();
  if (!token) return;

  const messages = await fetchTeamsMessages(token, process.env.TEAM_ID, process.env.CHANNEL_ID);
  if (!messages || !messages.length) return;

  const newMessages = messages.filter(
    (m) => !lastProcessedMessageId || m.id > lastProcessedMessageId
  );
  if (newMessages.length === 0) return;

  lastProcessedMessageId = newMessages[newMessages.length - 1].id;
  await saveLastProcessedMessageId(lastProcessedMessageId);

  const errors = newMessages.filter((m) => m.isError);
  const normal = newMessages.filter((m) => !m.isError);

  // Обрабатываем ошибки
  for (const msg of errors) {
    const { type, id } = getErrorTypeAndIdentifier(msg);
    msg.type = type;
    msg.extractedId = id;

    if (!processedErrorSubjects.has(msg.subject)) {
      await bot.api.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `❗ *Новая ошибка:*\n📌 *Тема:* ${msg.subject}`,
        { parse_mode: 'Markdown' }
      );
      processedErrorSubjects.add(msg.subject);
      await saveProcessedErrorSubjects();
    } else {
      collectedErrors.push(msg);
    }
  }

  // Суммаризируем обычные
  if (normal.length > 0) {
    const summary = await summarizeMessages(normal, lastProcessedMessageId);
    if (summary) {
      await bot.api.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `📝 *Суммаризация сообщений:*\n\n${summary}`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

/* ----------------------------------------------------------------
   5) Механизм сбора новостей: ТОЛЬКО 2 варианта заголовка + проверка
      "сегодня + 3 дня"
-----------------------------------------------------------------*/

// Функция парсинга строки "DD.MM.YYYY" в Date
function parseDateDDMMYYYY(str) {
  const [day, month, year] = str.split('.');
  if (!day || !month || !year) return null;
  const d = new Date(+year, +month - 1, +day);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Функция fetchBecloudNewsList:
 * - Парсит список.
 * - Берёт ТОЛЬКО заголовки, начинающиеся на:
 *   1) Уведомление о проведении плановых
 *   2) Ухудшение качества услуги Интернет
 * - Имеющие в самом конце дату формата дд.мм.гггг
 */
async function fetchBecloudNewsList() {
  const baseURL = 'https://becloud.by';
  const newsURL = `${baseURL}/customers/informing/`;
  let newsItems = [];

  try {
    const { data } = await axios.get(newsURL, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);

    // Регулярка, ищем в заголовке:
    //   Начало: "Уведомление о проведении плановых" или "Ухудшение качества услуги Интернет"
    //   Потом любые символы
    //   В конце дата дд.мм.гггг
    const reWanted = /^(Уведомление о проведении плановых|Ухудшение качества услуги ?«?Интернет»?).*(\d{2}\.\d{2}\.\d{4})$/i;

    $('.news__item').each((_, el) => {
      const $item = $(el);
      const $titleTag = $item.find('h6 a');
      const fullTitle = $titleTag.text().trim();
      const match = fullTitle.match(reWanted);
      if (!match) {
        // Пропускаем заголовки, не удовлетворяющие нужному шаблону
        return;
      }

      // Извлекаем дату (из второй группы регекспа)
      const dateFromTitle = match[2]; // напр. "14.04.2025"

      const href = $titleTag.attr('href');
      if (!href) return;

      const url = href.startsWith('http') ? href : (baseURL + href);
      // формируем ID
      const news_id = url;

      newsItems.push({
        source: 'becloud',
        news_id,
        title: fullTitle,      // весь заголовок
        date: dateFromTitle,   // "дд.мм.гггг"
        url,
      });
    });
  } catch (err) {
    console.error('Ошибка при запросе becloud:', err.message);
    return [];
  }

  return newsItems;
}

// Загрузка полного текста новости
async function fetchBecloudNewsContent(url) {
  try {
    const { data } = await axios.get(url, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);
    // Предположим, что основной текст в .cnt
    const content = $('.cnt').text().trim();
    return content;
  } catch (err) {
    console.error('Ошибка при загрузке новости becloud:', err.message);
    return '';
  }
}

/**
 * processBecloudNews:
 * 1) Получаем список (только нужные заголовки)
 * 2) Проверяем дату: только [сегодня; сегодня+3 дня]
 * 3) Если новость не была в БД – вставляем и рассылаем
 */
async function processBecloudNews() {
  const list = await fetchBecloudNewsList();
  if (!list || !list.length) {
    console.log('[becloud] Список новостей пуст, выходим.');
    return;
  }

  // готовим "сегодня" и "сегодня+3"
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 3);

  for (const item of list) {
    // Парсим дату из item.date (дд.мм.гггг)
    const newsDate = parseDateDDMMYYYY(item.date);
    if (!newsDate) {
      console.log(`[becloud] Не смогли распарсить дату: '${item.date}' (заголовок: "${item.title}"). Пропускаем.`);
      continue;
    }
    // Сравниваем только день/месяц/год
    const dateOnly = new Date(newsDate.getFullYear(), newsDate.getMonth(), newsDate.getDate());

    // newsDate не должна быть < today (чтобы не брать "прошлые" работы)
    if (dateOnly < today) {
      console.log(`[becloud] Дата ${item.date} раньше сегодня. Пропускаем (заголовок: "${item.title}").`);
      continue;
    }
    // И не должна быть позже, чем +3 дня
    if (dateOnly > maxDate) {
      console.log(`[becloud] Дата ${item.date} позже, чем +3 дня. Пропускаем (заголовок: "${item.title}").`);
      continue;
    }

    // Проверяем в БД
    const exists = await new Promise((resolve) => {
      db.get(
        `SELECT id FROM news WHERE source = ? AND news_id = ?`,
        [item.source, item.news_id],
        (err, row) => {
          if (err) {
            console.error('DB check news error:', err);
            return resolve(true);
          }
          resolve(!!row);
        }
      );
    });
    if (exists) {
      console.log(`[becloud] Новость уже есть (title="${item.title}"). Пропускаем.`);
      continue;
    }

    // Загружаем полный текст
    const content = await fetchBecloudNewsContent(item.url);

    // Делаем AI-суммаризацию
    const summary = await summarizeNewsContent(item.source, content);

    // Сохраняем в БД
    const createdAt = new Date().toISOString();
    await new Promise((resolve) => {
      db.run(
        `INSERT INTO news (source, news_id, title, date, url, content, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.source,
          item.news_id,
          item.title,
          item.date,   // "дд.мм.гггг"
          item.url,
          content,
          summary,
          createdAt,
        ],
        function (err) {
          if (err) console.error('DB insert news error:', err);
          resolve();
        }
      );
    });

    // Отправляем сообщение в Telegram
    const shortText = summary || (content.slice(0, 500) + '...');
    const msgText =
      `📰 *Новая новость (${item.source})*\n` +
      `*Заголовок:* ${item.title}\n` +
      `*Дата:* ${item.date}\n` +
      (summary ? `*Краткое содержание:* ${summary}\n` : `*Фрагмент:* ${shortText}\n`) +
      `[Читать подробнее](${item.url})`;

    await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });
  }
}

/* --------------------------------------------------
   6) Команда /news для вывода последних N новостей
----------------------------------------------------*/
bot.command('news', async (ctx) => {
  console.log('[/news] Команда /news была вызвана.');

  const messageText = ctx.message?.text || '';
  console.log(`[/news] Текст сообщения: "${messageText}"`);

  const parts = messageText.split(' ');
  const limit = parseInt(parts[1], 10) || 3;
  console.log(`[/news] Будем показывать последние ${limit} новостей.`);

  console.log('[/news] Запрашиваем новости из БД...');
  db.all(
    `SELECT * FROM news ORDER BY id DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        console.error('DB select news error:', err);
        return ctx.reply('Произошла ошибка при чтении новостей.');
      }
      if (!rows || rows.length === 0) {
        console.log('[/news] В БД нет новостей для показа.');
        return ctx.reply('Пока нет сохранённых новостей.');
      }

      console.log(`[/news] Получили ${rows.length} новостей, формируем ответ...`);
      let response = `📰 *Последние ${rows.length} новостей (из разных источников)*:\n\n`;
      rows.forEach((row) => {
        response += `*Источник:* ${row.source}\n`;
        response += `*Заголовок:* ${row.title}\n`;
        if (row.summary) {
          response += `_${row.summary}_\n`;
        }
        response += `[Подробнее](${row.url})\n\n`;
      });

      console.log('[/news] Отправляем ответ пользователю...');
      ctx.reply(response, { parse_mode: 'Markdown', disable_web_page_preview: false });
    }
  );
});

/* ----------------------------------------------------------
   7) Коллбэки для "Подробнее"/"Скрыть" сводок ошибок Teams
-----------------------------------------------------------*/
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const match = data.match(/^(show_details|hide_details)_(\d+)$/);
  if (!match) {
    return ctx.answerCallbackQuery({ text: 'Неверный формат.', show_alert: true });
  }

  const [_, action, id] = match;
  db.get('SELECT * FROM error_summaries WHERE id = ?', [id], async (err, row) => {
    if (err || !row) {
      return ctx.answerCallbackQuery({ text: 'Сводка не найдена.', show_alert: true });
    }

    if (action === 'show_details') {
      const grouped = JSON.parse(row.details_json).reduce((acc, item) => {
        acc[item.type] = acc[item.type] || [];
        acc[item.type].push(item.id);
        return acc;
      }, {});

      let text = '📋 *Детали ошибок по типам:*\n\n';
      for (const [type, ids] of Object.entries(grouped)) {
        const unique = [...new Set(ids)].sort();
        text += `*${type}* (${unique.length}):\n\`${unique.join(', ')}\`\n\n`;
      }
      await ctx.answerCallbackQuery();
      await bot.api.editMessageText(row.chat_id, row.message_id, text, {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('🔼 Скрыть', `hide_details_${id}`),
      });
    } else {
      await ctx.answerCallbackQuery();
      await bot.api.editMessageText(row.chat_id, row.message_id, row.summary_text, {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('📋 Подробнее', `show_details_${id}`),
      });
    }
  });
});

/* -------------------------------------------------
   8) Починка "Подробнее" кнопок (для старых сводок)
--------------------------------------------------*/
async function repairMissingButtons() {
  db.all('SELECT id, chat_id, message_id FROM error_summaries', async (err, rows) => {
    if (err) return console.error('Ошибка при чтении сводок из БД:', err);
    for (const row of rows) {
      try {
        await bot.api.editMessageReplyMarkup(row.chat_id, row.message_id, {
          reply_markup: new InlineKeyboard().text('📋 Подробнее', `show_details_${row.id}`),
        });
        console.log(`🔧 Кнопка добавлена к message_id=${row.message_id}`);
      } catch (e) {
        console.warn(`⛔ Не удалось обновить message_id=${row.message_id}:`, e.description);
      }
    }
  });
}
bot.command('fixbuttons', async (ctx) => {
  console.log('[/fixbuttons] Команда fixbuttons получена.');
  await ctx.reply('🔧 Начинаю восстановление кнопок...');
  await repairMissingButtons();
  await ctx.reply('✅ Попробовал обновить все сводки.');
});

/* ------------------------------
   9) Cron-задачи
-------------------------------*/

// Каждую минуту — проверяем новые сообщения Teams
cron.schedule('* * * * *', () => processTeamsMessages());

// Каждый час (мин:00) — отправляем сводку ошибок (если накопились)
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());

// Сброс обработанных тем ошибок в 00:05
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects());

// Очистка старых сводок (старше 3 месяцев) в 03:00
cron.schedule('0 3 * * *', () => {
  db.run(
    `DELETE FROM error_summaries
     WHERE datetime(created_at) < datetime('now', '-3 months')`,
    function (err) {
      if (err) console.error('Очистка сводок:', err);
      else console.log(`Удалено старых сводок: ${this.changes}`);
    }
  );
});

// Каждые 30 минут — проверяем новости becloud
cron.schedule('*/30 * * * *', () => processBecloudNews());

/* -------------------------------------
   10) Прочие команды/старт бота
--------------------------------------*/
bot.command('start', (ctx) => {
  console.log('[/start] Команда start получена.');
  ctx.reply('✅ Бот активен. Проверяю Teams и разные новости.');
});

// Глобальный обработчик ошибок бота
bot.catch((err) => {
  console.error('Ошибка бота:', err);
});

// Запуск бота
bot.start();
