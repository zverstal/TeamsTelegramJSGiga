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

let db;
function initDatabase() {
  db = new sqlite3.Database(path.join(__dirname, 'summaries.db'), (err) => {
    if (err) return console.error('SQLite error:', err);

    // Таблица для сводок об ошибках
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
        posted INTEGER DEFAULT 0,
        UNIQUE(source, news_id)
      )
    `);
  });
}

initDatabase(); // ✅ вызов функции уже после её определения

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

  // Пример запроса в OpenAI (модель и параметры меняйте под себя)
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
  // Универсальный промт для краткого пересказа новости
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
  collectedErrors.length = 0; // очистим

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

  // Берём только те, что идут после последнего обработанного
  const newMessages = messages.filter(
    (m) => !lastProcessedMessageId || m.id > lastProcessedMessageId
  );
  if (newMessages.length === 0) return;

  // Обновляем последний обработанный
  lastProcessedMessageId = newMessages[newMessages.length - 1].id;
  await saveLastProcessedMessageId(lastProcessedMessageId);

  // Разделяем на ошибки и обычные
  const errors = newMessages.filter((m) => m.isError);
  const normal = newMessages.filter((m) => !m.isError);

  // Обрабатываем ошибки
  for (const msg of errors) {
    const { type, id } = getErrorTypeAndIdentifier(msg);
    msg.type = type;
    msg.extractedId = id;

    // Если тема ещё не встречалась, отправим уведомление
    if (!processedErrorSubjects.has(msg.subject)) {
      await bot.api.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `❗ *Новая ошибка:*\n📌 *Тема:* ${msg.subject}`,
        { parse_mode: 'Markdown' }
      );
      processedErrorSubjects.add(msg.subject);
      await saveProcessedErrorSubjects();
    } else {
      // Иначе складируем, чтобы потом отправить сводку
      collectedErrors.push(msg);
    }
  }

  // Суммаризируем обычные сообщения, если есть
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
   5) Парсинг becloud — с фильтрацией по RegExp и отложенной отправкой
-----------------------------------------------------------------*/

const reWantedBecloud = /^(Уведомление о проведении плановых|Ухудшение качества услуги ?«?Интернет»?).*(\d{2}\.\d{2}\.\d{4})$/i;

async function fetchBecloudNewsList() {
  const baseURL = 'https://becloud.by';
  const newsURL = `${baseURL}/customers/informing/`;
  const newsItems = [];

  try {
    const { data } = await axios.get(newsURL, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);

    $('.news__item').each((_, el) => {
      const $item = $(el);
      const $titleTag = $item.find('h6 a');
      const title = $titleTag.text().trim();
      const href = $titleTag.attr('href');

      if (!title || !href) return;

      const match = title.match(reWantedBecloud);
      if (!match) return;

      const extractedDate = match[2];
      const url = href.startsWith('http') ? href : baseURL + href;
      const news_id = href;

      newsItems.push({
        source: 'becloud',
        news_id,
        title,
        date: extractedDate,
        url,
      });
    });
  } catch (err) {
    console.error('Ошибка при запросе becloud:', err.message);
    return [];
  }

  return newsItems;
}

async function fetchBecloudNewsContent(url) {
  try {
    const { data } = await axios.get(url, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);
    return $('.cnt').text().trim();
  } catch (err) {
    console.error('Ошибка при загрузке новости becloud:', err.message);
    return '';
  }
}

async function processBecloudNews() {
  const list = await fetchBecloudNewsList();
  if (!list || !list.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setDate(today.getDate() + 3);

  for (const item of list) {
    const parsedDate = parseDateDDMMYYYY(item.date);
    if (!parsedDate) continue;
    parsedDate.setHours(0, 0, 0, 0);

    if (parsedDate < today || parsedDate > maxDate) {
      console.log(`[becloud] Пропущена по дате: ${item.title} (${item.date})`);
      continue;
    }

    const exists = await new Promise((resolve) => {
      db.get(
        'SELECT id FROM news WHERE source = ? AND news_id = ?',
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
    if (exists) continue;

    const content = await fetchBecloudNewsContent(item.url);
    const summary = await summarizeNewsContent(item.source, content);
    const createdAt = new Date().toISOString();

    const posted = parsedDate.getTime() === today.getTime() ? 1 : 0;

    if (posted === 1) {
      const shortText = summary || (content.slice(0, 500) + '...');
      const msgText = `📰 *Новая новость (${item.source})*\n` +
        `*Заголовок:* ${item.title}\n` +
        (item.date ? `*Дата:* ${item.date}\n` : '') +
        (summary ? `*Краткое содержание:* ${summary}\n` : `*Фрагмент:* ${shortText}\n`) +
        `[Читать подробнее](${item.url})`;

      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
    }

    db.run(
      `INSERT INTO news (source, news_id, title, date, url, content, summary, created_at, posted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.source, item.news_id, item.title, item.date, item.url, content, summary, createdAt, posted],
      (err) => {
        if (err) console.error('DB insert error:', err);
      }
    );
  }
}

async function checkBecloudPlannedDates() {
  const todayStr = getDDMMYYYY(new Date());
  db.all(
    `SELECT * FROM news WHERE source='becloud' AND posted=0 AND date=?`,
    [todayStr],
    async (err, rows) => {
      if (err) return console.error('[becloud] DB error:', err);
      for (const row of rows) {
        const shortText = row.summary || (row.content.slice(0, 500) + '...');
        const msgText = `📰 *Новая новость (${row.source})*\n` +
          `*Заголовок:* ${row.title}\n` +
          (row.date ? `*Дата:* ${row.date}\n` : '') +
          (row.summary ? `*Краткое содержание:* ${row.summary}\n` : `*Фрагмент:* ${shortText}\n`) +
          `[Читать подробнее](${row.url})`;

        await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        });

        db.run(`UPDATE news SET posted=1 WHERE id=?`, [row.id]);
      }
    }
  );
}


/* ----------------------------------------------------------------
   6) Парсинг ERIP — аналогичная логика (отправка в день события)
-----------------------------------------------------------------*/

function parseDateDDMonthYYYY(str) {
  const monthMap = {
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'июн': 5,
    'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
  };
  const parts = str.toLowerCase().split(' ');
  if (parts.length < 3) return null;
  const day = parseInt(parts[0], 10);
  const month = monthMap[parts[1]];
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(year) || month === undefined) return null;
  return new Date(year, month, day);
}

async function fetchEripNewsList() {
  const baseURL = 'https://raschet.by';
  const newsURL = `${baseURL}/about/novosti/uvedomleniya/`;
  const newsItems = [];

  try {
    const { data } = await axios.get(newsURL, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);

    $('a.news-item').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      if (!href) return;

      const dateStr = $a.find('.date').text().trim();
      const title = $a.find('.news-title').text().trim();
      if (!dateStr || !title) return;

      const url = href.startsWith('http') ? href : baseURL + href;

      newsItems.push({
        source: 'erip',
        news_id: url,
        title,
        date: dateStr,
        url,
      });
    });
  } catch (err) {
    console.error('Ошибка при запросе ERIP:', err.message);
    return [];
  }

  return newsItems;
}

async function fetchEripNewsContent(url) {
  try {
    const { data } = await axios.get(url, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10_000,
    });
    const $ = cheerio.load(data);
    const $detail = $('.news-detail, .item-content');
    let text = '';
    $detail.find('p').each((_, p) => {
      text += $(p).text().trim() + '\n';
    });
    return text.trim() || $detail.text().trim();
  } catch (err) {
    console.error('Ошибка при загрузке новости ERIP:', err.message);
    return '';
  }
}

async function processEripNews() {
  const list = await fetchEripNewsList();
  if (!list || !list.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today);
  maxDate.setDate(today.getDate() + 3);

  for (const item of list) {
    const parsedDate = parseDateDDMonthYYYY(item.date);
    if (!parsedDate) continue;
    parsedDate.setHours(0, 0, 0, 0);

    if (parsedDate < today || parsedDate > maxDate) {
      console.log(`[erip] Пропущена по дате: ${item.title} (${item.date})`);
      continue;
    }

    const exists = await new Promise((resolve) => {
      db.get(
        'SELECT id FROM news WHERE source = ? AND news_id = ?',
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
    if (exists) continue;

    const content = await fetchEripNewsContent(item.url);
    const summary = await summarizeNewsContent(item.source, content);
    const createdAt = new Date().toISOString();

    const posted = parsedDate.getTime() === today.getTime() ? 1 : 0;

    if (posted === 1) {
      const shortText = summary || (content.slice(0, 500) + '...');
      const msgText = `📰 *Новая новость (${item.source})*\n` +
        `*Заголовок:* ${item.title}\n` +
        (item.date ? `*Дата:* ${item.date}\n` : '') +
        (summary ? `*Краткое содержание:* ${summary}\n` : `*Фрагмент:* ${shortText}\n`) +
        `[Читать подробнее](${item.url})`;

      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
    }

    db.run(
      `INSERT INTO news (source, news_id, title, date, url, content, summary, created_at, posted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.source, item.news_id, item.title, item.date, item.url, content, summary, createdAt, posted],
      (err) => {
        if (err) console.error('DB insert error:', err);
      }
    );
  }
}

async function checkEripPlannedDates() {
  const todayStr = getDDMMYYYY(new Date());
  db.all(
    `SELECT * FROM news WHERE source='erip' AND posted=0 AND date=?`,
    [todayStr],
    async (err, rows) => {
      if (err) return console.error('[erip] DB error:', err);
      for (const row of rows) {
        const shortText = row.summary || (row.content.slice(0, 500) + '...');
        const msgText = `📰 *Новая новость (${row.source})*\n` +
          `*Заголовок:* ${row.title}\n` +
          (row.date ? `*Дата:* ${row.date}\n` : '') +
          (row.summary ? `*Краткое содержание:* ${row.summary}\n` : `*Фрагмент:* ${shortText}\n`) +
          `[Читать подробнее](${row.url})`;

        await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        });

        db.run(`UPDATE news SET posted=1 WHERE id=?`, [row.id]);
      }
    }
  );
}


/* --------------------------------------------------
   7) Команда /news для вывода последних N новостей
----------------------------------------------------*/
bot.command('news', async (ctx) => {
  console.log('[/news] Команда /news была вызвана.');
  const messageText = ctx.message?.text || '';
  console.log(`[/news] Текст сообщения: "${messageText}"`);

  const parts = messageText.split(' ');
  const limit = parseInt(parts[1], 10) || 3;
  console.log(`[/news] Будем показывать последние ${limit} новостей.`);

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
        if (row.date) {
          response += `Дата: ${row.date}\n`;
        }
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
   8) Коллбэки для "Подробнее"/"Скрыть" сводок ошибок Teams
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
   9) Починка "Подробнее" кнопок (для старых сводок)
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
   10) Cron-задачи
-------------------------------*/
cron.schedule('* * * * *', () => processTeamsMessages());
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects());
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

// Каждые 30 минут — проверяем becloud
cron.schedule('* * * * *', () => processBecloudNews());
// Каждые 30 минут — проверяем ERIP
cron.schedule('* * * * *', () => processEripNews());

cron.schedule('1 0 * * *', async () => {
  console.log('[becloud] Запуск плановой проверки новостей (cron 00:01)');
  await checkBecloudPlannedDates();
});

cron.schedule('1 0 * * *', async () => {
  console.log('[erip] Запуск плановой проверки новостей (cron 00:01)');
  await checkEripPlannedDates();
});



/* -------------------------------------
   11) Прочие команды/старт бота
--------------------------------------*/
bot.command('start', (ctx) => {
  console.log('[/start] Команда start получена.');
  ctx.reply('✅ Бот активен. Проверяю Teams, becloud и ERIP-новости.');
});

// Глобальный обработчик ошибок бота
bot.catch((err) => {
  console.error('Ошибка бота:', err);
});

// Запуск бота
bot.start();