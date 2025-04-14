require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio'); // Для парсинга HTML

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
    // Таблица для хранения сводок
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

    // Таблица для хранения новостей becloud
    db.run(`
      CREATE TABLE IF NOT EXISTS becloud_news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        news_id TEXT UNIQUE, 
        title TEXT,
        date TEXT,
        url TEXT,
        content TEXT,
        created_at TEXT
      )
    `);
  });
}
initDatabase();

// Переменные для отслеживания последнего ID сообщения из Teams
let lastProcessedMessageId = null;
const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');

// Сборщик ошибок, которые повторяются
const collectedErrors = [];
// Set с уже упомянутыми темами (чтобы не дублировать уведомление)
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

// Сброс обработанных тем (например, раз в сутки)
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

// Извлекает текст из тела сообщения
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

// Определяет тип ошибки и идентификатор по теме
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

// GPT-суммаризация обычных (не-ошибочных) сообщений
async function summarizeMessages(messages, lastMsgId) {
  if (!messages.length) return null;

  const list = messages.map((msg) => {
    const reply = msg.isReply
      ? '\nТип: Ответ (тема из контекста предыдущего сообщения)'
      : '';
    return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${reply}\nТекст сообщения: ${msg.body}`;
  }).join('\n\n');

  // Пример promptа. Подстройте под себя и модель
  const prompt = `
(Последний обработанный ID: ${lastMsgId})

Проанализируй следующие сообщения из Teams. Для каждого сообщения, составь краткое резюме:

${list}
`.trim();

  // Здесь в примере вызывается OpenAI (gpt-4o-mini). У вас может быть другой эндпоинт/модель
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
    console.error('OpenAI summarization error:', err);
    return null;
  }
}

/* --------------------------------------
   Логика обработки повторяющихся ошибок
-----------------------------------------*/

// Отправляет раз в час сводку собранных повторяющихся ошибок
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
  collectedErrors.length = 0; // очищаем

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

// Основная функция по обработке новых сообщений в Teams
async function processTeamsMessages() {
  const token = await getMicrosoftToken();
  if (!token) return;

  const messages = await fetchTeamsMessages(token, process.env.TEAM_ID, process.env.CHANNEL_ID);
  if (messages.length === 0) return;

  // Берём сообщения, которые идут после последнего обработанного
  const newMessages = messages.filter(m => !lastProcessedMessageId || m.id > lastProcessedMessageId);
  if (newMessages.length === 0) return;

  // Запоминаем самый свежий ID
  lastProcessedMessageId = newMessages[newMessages.length - 1].id;
  await saveLastProcessedMessageId(lastProcessedMessageId);

  // Разделяем на ошибки и нормальные
  const errors = newMessages.filter(m => m.isError);
  const normal = newMessages.filter(m => !m.isError);

  // Обрабатываем ошибки
  for (const msg of errors) {
    const { type, id } = getErrorTypeAndIdentifier(msg);
    msg.type = type;
    msg.extractedId = id;

    // Если тема ошибки ещё не встречалась, сразу отправим в чат
    if (!processedErrorSubjects.has(msg.subject)) {
      await bot.api.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `❗ *Новая ошибка:*\n📌 *Тема:* ${msg.subject}`,
        { parse_mode: 'Markdown' }
      );
      processedErrorSubjects.add(msg.subject);
      await saveProcessedErrorSubjects();
    } else {
      // Иначе складируем, отправим сводку раз в час
      collectedErrors.push(msg);
    }
  }

  // Суммаризируем обычные сообщения
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
   Команды бота, связанные со сводками ошибок (подробнее/скрыть)
-------------------------------------------------------------------*/
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

// Починка "Подробнее" кнопок для старых сообщений
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
  await ctx.reply('🔧 Начинаю восстановление кнопок...');
  await repairMissingButtons();
  await ctx.reply('✅ Попробовал обновить все сводки.');
});

/* ------------------------------------------
   1) Функции для получения новостей becloud
-------------------------------------------*/

// Парсим главную страницу "https://becloud.by/customers/informing/"
async function fetchBecloudNewsList() {
  const baseURL = 'https://becloud.by';
  const newsURL = `${baseURL}/customers/informing/`;

  const { data } = await axios.get(newsURL, {
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
  const $ = cheerio.load(data);
  
  const newsItems = [];

  // Примерно ищем блоки с новостями
  $('.news__item').each((_, el) => {
    const $item = $(el);
    const $titleTag = $item.find('h6 a');
    const title = $titleTag.text().trim();
    const href = $titleTag.attr('href');
    const date = $item.find('.news-date').text().trim();

    // Сконструируем полный url новости
    const url = href.startsWith('http') ? href : `${baseURL}${href}`;

    // Для уникального идентификатора можно взять часть URL или id из атрибута
    const idAttr = $item.attr('id') || '';
    // Или просто используем сам href как news_id
    const news_id = href;

    // Сохраняем данные
    if (title && date && href) {
      newsItems.push({ news_id, title, date, url });
    }
  });

  return newsItems;
}

// Загружаем содержимое конкретной новости
async function fetchBecloudNewsContent(url) {
  const { data } = await axios.get(url, {
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
  const $ = cheerio.load(data);
  // Предположим, что текст новости в div.cnt
  const content = $('.cnt').text().trim();
  return content;
}

// Основная обёртка: получаем список новостей, загружаем текст и сохраняем новые
async function processBecloudNews() {
  try {
    const list = await fetchBecloudNewsList();

    for (const item of list) {
      // Проверим, есть ли уже в базе
      const isExists = await new Promise((resolve) => {
        db.get(
          'SELECT id FROM becloud_news WHERE news_id = ?',
          [item.news_id],
          (err, row) => {
            if (err) {
              console.error('DB check error:', err);
              return resolve(true); // Чтобы не дублировать
            }
            resolve(!!row);
          }
        );
      });
      if (isExists) continue; // Уже есть, пропускаем

      // Загружаем контент новости
      const content = await fetchBecloudNewsContent(item.url);

      // Сохраняем в БД
      const createdAt = new Date().toISOString();
      await new Promise((resolve) => {
        db.run(
          `INSERT INTO becloud_news (news_id, title, date, url, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [item.news_id, item.title, item.date, item.url, content, createdAt],
          function (err) {
            if (err) {
              console.error('DB insert news error:', err);
            }
            resolve();
          }
        );
      });

      // Отправляем в Telegram
      // Немного сократим текст, если оно слишком длинное
      const shortContent = content.length > 1000
        ? (content.slice(0, 1000) + '...')
        : content;

      const msgText =
        `📰 *Новая новость от beCloud!* \n\n` +
        `*Заголовок:* ${item.title}\n` +
        `*Дата:* ${item.date}\n\n` +
        `_${shortContent}_\n\n` +
        `[Подробнее](${item.url})`;

      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });
    }
  } catch (err) {
    console.error('Ошибка при обновлении новостей becloud:', err);
  }
}

/* ---------------------------------------------------------
   2) Команда /news – показывает последние N новостей
----------------------------------------------------------*/
bot.command('news', async (ctx) => {
  // Берём последние 3-5 новостей
  const limit = 3;
  db.all(
    `SELECT * FROM becloud_news ORDER BY id DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        console.error('DB select news error:', err);
        return ctx.reply('Произошла ошибка при чтении новостей.');
      }
      if (!rows || rows.length === 0) {
        return ctx.reply('Пока нет сохранённых новостей.');
      }

      let response = '📰 *Последние новости beCloud:*\n\n';
      rows.forEach((row) => {
        response += `*${row.title}* (${row.date})\n[Подробнее](${row.url})\n\n`;
      });
      ctx.reply(response, { parse_mode: 'Markdown', disable_web_page_preview: false });
    }
  );
});

/* --------------------------------
   Расписание cron-задач
-----------------------------------*/

// Каждую минуту — проверяем новые сообщения Teams
cron.schedule('* * * * *', () => processTeamsMessages());

// Каждый час (мин:00) — отправляем сводку ошибок (если накопились)
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());

// Сброс обработанных тем ошибок в 00:05
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects());

// Очистка старых сводок ошибок в 03:00 (старше 3 месяцев)
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

// Каждые 30 минут — проверяем, нет ли новых новостей на becloud
cron.schedule('*/30 * * * *', () => processBecloudNews());

// Тестовая команда
bot.command('start', (ctx) => ctx.reply('✅ Бот активен. Ждёт ошибки в Teams и проверяет новости beCloud.'));

// Глобальный обработчик ошибок бота
bot.catch((err) => console.error('Ошибка бота:', err));

// Запуск бота
bot.start();
