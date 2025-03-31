// Загружаем переменные окружения
require('dotenv').config();
const { Bot } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Для работы с SQLite

// Инициализируем бота
const bot = new Bot(process.env.BOT_API_KEY);

// MSAL-конфигурация
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

// *******************
// 1. Инициализация БД
// *******************
let db;
function initDatabase() {
  db = new sqlite3.Database(path.join(__dirname, 'summaries.db'), (err) => {
    if (err) {
      console.error('Ошибка при открытии БД SQLite:', err);
    } else {
      console.log('SQLite База подключена.');
      db.run(`
        CREATE TABLE IF NOT EXISTS error_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `, (err) => {
        if (err) {
          console.error('Ошибка при создании таблицы:', err);
        } else {
          console.log('Таблица error_summaries готова.');
        }
      });
    }
  });
}
initDatabase();

// *******************
// 2. Прочие переменные и сохранение состояния
// *******************
let lastProcessedMessageId = null;
const collectedErrors = [];
const processedErrorSubjects = new Set();

const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

async function saveLastProcessedMessageId(id) {
  try {
    await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
  } catch (error) {
    console.error('Ошибка при сохранении lastMessageId.txt:', error);
  }
}

function loadLastProcessedMessageId() {
  try {
    if (fs.existsSync(lastMessageIdFile)) {
      const data = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
      if (data) lastProcessedMessageId = data;
    }
  } catch (error) {
    console.error('Ошибка при загрузке lastMessageId.txt:', error);
  }
}

function loadProcessedErrorSubjects() {
  try {
    if (fs.existsSync(processedSubjectsFile)) {
      const data = fs.readFileSync(processedSubjectsFile, 'utf8').trim();
      const subjects = JSON.parse(data);
      if (Array.isArray(subjects)) subjects.forEach((subject) => processedErrorSubjects.add(subject));
    }
  } catch (error) {
    console.error('Ошибка при загрузке processedErrorSubjects.json:', error);
  }
}

async function saveProcessedErrorSubjects() {
  try {
    await fs.promises.writeFile(processedSubjectsFile, JSON.stringify([...processedErrorSubjects], null, 2), 'utf8');
  } catch (error) {
    console.error('Ошибка при сохранении processedErrorSubjects.json:', error);
  }
}

async function resetProcessedErrorSubjects() {
  try {
    if (fs.existsSync(processedSubjectsFile)) await fs.promises.unlink(processedSubjectsFile);
    processedErrorSubjects.clear();
  } catch (error) {
    console.error('Ошибка при сбросе processedErrorSubjects:', error);
  }
}

loadLastProcessedMessageId();
loadProcessedErrorSubjects();

// **************************
// 3. Функции для Microsoft Graph
// **************************
async function getMicrosoftToken() {
  const cca = new ConfidentialClientApplication(msalConfig);
  const tokenRequest = { scopes: ['https://graph.microsoft.com/.default'] };
  try {
    const response = await cca.acquireTokenByClientCredential(tokenRequest);
    console.log('🔑 Microsoft OAuth2 токен получен.');
    return response.accessToken;
  } catch (err) {
    console.error('❌ Ошибка получения токена Microsoft:', err.message);
    return null;
  }
}

function extractTextContent(message) {
  const rawText = message.body?.content || '';
  // Убираем HTML-теги
  const text = rawText.replace(/<\/?[^>]+(>|$)/g, '').trim();

  let sender = 'Неизвестно';
  let subject = 'Без темы';
  let isReply = false;
  let body = '';

  const lines = text.split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (line.startsWith('Отправитель:')) {
      sender = line.replace(/^Отправитель:\s*/i, '').trim();
    } else if (line.startsWith('Тема:')) {
      subject = line.replace(/^Тема:\s*/i, '').trim();
      if (/^RE:/i.test(subject)) {
        isReply = true;
        subject = subject.replace(/^RE:\s*/i, '').trim();
      }
    } else {
      body += (body ? '\n' : '') + line;
    }
  }

  const errorKeywords = /ошибка|оповещение|failed|error|ошибки|exception|critical/i;
  const isError = sender.toLowerCase() === 'noreply@winline.kz' &&
                  (errorKeywords.test(subject) || errorKeywords.test(body));

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

function getErrorTypeAndIdentifier(errorMsg) {
  const text = errorMsg.body.toLowerCase();
  if (errorMsg.subject.includes('STOPAZART')) {
    const match = text.match(/id игрока[:\s]*([0-9]+)/i);
    return { type: 'STOPAZART', id: match?.[1] || 'не найден' };
  } else if (errorMsg.subject.includes('SmartBridge')) {
    const match = text.match(/номер транзакции\s*([0-9]+)/i);
    return { type: 'SmartBridge', id: match?.[1] || 'не найден' };
  } else if (errorMsg.subject.includes('реестре должников')) {
    const match = text.match(/id игрока[:\s]*([0-9]+)/i);
    return { type: 'Реестр должников', id: match?.[1] || 'не найден' };
  } else {
    return { type: 'Другое', id: 'N/A' };
  }
}

async function fetchTeamsMessages(token, teamId, channelId) {
  console.log('📡 Чтение сообщений из Teams...');
  const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;
  try {
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const messages = response.data.value.map(extractTextContent);
    console.log(`📥 Найдено ${messages.length} сообщений.`);
    return messages.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
  } catch (err) {
    console.error(`Ошибка при чтении сообщений из Teams: ${err.message}`);
    return [];
  }
}

async function summarizeMessages(messages, lastMsgId) {
  console.log('🧠 Запрос к OpenAI для суммаризации...');
  try {
    const messageList = messages
      .map((msg) => {
        const replyIndicator = msg.isReply ? '\nТип: Ответ (тема из контекста предыдущего сообщения)' : '';
        return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${replyIndicator}\nТекст сообщения: ${msg.body}`;
      })
      .join('\n\n');

    const prompt = `
(Последний обработанный ID: ${lastMsgId})

Проанализируй следующие сообщения из Teams и составь краткое резюме (одним-двумя предложениями):
${messageList}
    `.trim();

    const requestData = {
      model: 'gpt-4o-mini',
      temperature: 0.0,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    };

    const response = await axios.post('https://api.openai.com/v1/chat/completions', requestData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const result = response.data.choices[0]?.message?.content || 'Нет ответа от OpenAI.';
    console.log('✅ Суммаризация завершена.');
    return result;
  } catch (err) {
    console.error('Ошибка при суммаризации сообщений:', err.message);
    return 'Не удалось получить резюме сообщений.';
  }
}

// ****************************************
// 4. Сохранение и отправка сводки об ошибках
// ****************************************
async function sendErrorSummaryIfNeeded() {
  if (collectedErrors.length === 0) return;

  const errorCountBySubject = {};
  collectedErrors.forEach((error) => {
    if (errorCountBySubject[error.subject]) {
      errorCountBySubject[error.subject].count++;
      errorCountBySubject[error.subject].lastOccurred = error.createdDateTime;
    } else {
      errorCountBySubject[error.subject] = {
        count: 1,
        lastOccurred: error.createdDateTime,
        body: error.body,
      };
    }
  });

  let summary = '🔍 *Сводка ошибок за последний час:*\n';
  for (const [subject, data] of Object.entries(errorCountBySubject)) {
    const lastDate = new Date(data.lastOccurred).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    summary += `📌 *Тема:* ${subject}\n- *Количество:* ${data.count}\n- *Последнее появление:* ${lastDate}\n`;
  }

  const errorDetails = collectedErrors.map((e) => ({
    type: e.type,
    id: e.extractedId,
    subject: e.subject,
    date: e.createdDateTime,
  }));

  collectedErrors.length = 0;

  // Отправляем сообщение с placeholder-кнопкой "Подробнее"
  const message = await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '📋 Подробнее', callback_data: 'show_details_TEMP' }]],
    },
  });

  // Сохраняем сводку в БД, чтобы в дальнейшем иметь возможность редактировать её
  const createdAt = new Date().toISOString();
  const insertSql = `
    INSERT INTO error_summaries (chat_id, message_id, summary_text, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `;
  db.run(
    insertSql,
    [
      String(message.chat.id),
      String(message.message_id),
      summary,
      JSON.stringify(errorDetails),
      createdAt,
    ],
    function (err) {
      if (err) {
        console.error('Ошибка при сохранении сводки в БД:', err);
        return;
      }
      const summaryId = this.lastID;
      const newInlineKeyboard = {
        inline_keyboard: [
          [{ text: '📋 Подробнее', callback_data: `show_details_${summaryId}` }],
        ],
      };
      bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, newInlineKeyboard)
        .catch((e) => console.error('Ошибка при редактировании клавиатуры:', e));
    }
  );
}

// *********************************************************
// 5. Основная функция обработки сообщений из Teams
// *********************************************************
async function processTeamsMessages() {
  console.log('🔄 Запуск обработки сообщений Teams...');
  const msToken = await getMicrosoftToken();
  if (!msToken) {
    console.error('❌ Токен не получен, пропускаем.');
    return;
  }
  const messages = await fetchTeamsMessages(msToken, process.env.TEAM_ID, process.env.CHANNEL_ID);
  console.log(`📬 Получено ${messages.length} сообщений.`);
  if (messages.length === 0) return;

  const newMessages = messages.filter((msg) => !lastProcessedMessageId || msg.id > lastProcessedMessageId);
  if (newMessages.length === 0) {
    console.log('📭 Нет новых сообщений с момента последней проверки.');
    return;
  }
  lastProcessedMessageId = newMessages[newMessages.length - 1].id;
  await saveLastProcessedMessageId(lastProcessedMessageId);

  const errors = newMessages.filter((msg) => msg.isError);
  const normalMessages = newMessages.filter((msg) => !msg.isError);

  // Обрабатываем ошибки
  for (const errorMsg of errors) {
    const { type, id } = getErrorTypeAndIdentifier(errorMsg);
    errorMsg.type = type;
    errorMsg.extractedId = id;

    if (!processedErrorSubjects.has(errorMsg.subject)) {
      const msgText = `❗ *Новая ошибка обнаружена:*\n📌 *Тема:* ${errorMsg.subject}`;
      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, { parse_mode: 'Markdown' });
      processedErrorSubjects.add(errorMsg.subject);
      await saveProcessedErrorSubjects();
    } else {
      collectedErrors.push(errorMsg);
    }
  }

  // Суммаризация обычных сообщений
  if (normalMessages.length > 0) {
    const summary = await summarizeMessages(normalMessages, lastProcessedMessageId);
    if (summary) {
      await bot.api.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `📝 *Суммаризация сообщений:*\n\n${summary}`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

// *********************************************************
// 6. Обработка callback_query (кнопки "Подробнее" и "Скрыть")
// *********************************************************
bot.on('callback_query:data', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const match = callbackData.match(/^(show_details|hide_details)_(\d+)$/);
  if (!match) {
    await ctx.answerCallbackQuery({ text: 'Неизвестная команда', show_alert: true });
    return;
  }
  const action = match[1];
  const summaryId = parseInt(match[2], 10);

  db.get('SELECT * FROM error_summaries WHERE id = ?', [summaryId], async (err, row) => {
    if (err) {
      console.error('Ошибка при запросе сводки из БД:', err);
      await ctx.answerCallbackQuery({ text: 'Ошибка при доступе к данным.', show_alert: true });
      return;
    }
    if (!row) {
      await ctx.answerCallbackQuery({ text: 'Сводка устарела или не найдена.', show_alert: true });
      return;
    }
    if (action === 'show_details') {
      const detailsArray = JSON.parse(row.details_json);
      const grouped = detailsArray.reduce((acc, errItem) => {
        acc[errItem.type] = acc[errItem.type] || [];
        acc[errItem.type].push(errItem.id);
        return acc;
      }, {});
      let detailsText = '📋 *Детали ошибок по типам:*\n\n';
      for (const [type, ids] of Object.entries(grouped)) {
        const uniqueIds = [...new Set(ids)].sort();
        detailsText += `*${type}* (кол-во: ${uniqueIds.length})\nID:\`${uniqueIds.join(', ')}\`\n\n`;
      }
      await ctx.answerCallbackQuery();
      await bot.api.editMessageText(
        row.chat_id,
        row.message_id,
        detailsText,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔼 Скрыть', callback_data: `hide_details_${summaryId}` }],
            ],
          },
        }
      );
    } else if (action === 'hide_details') {
      await ctx.answerCallbackQuery();
      await bot.api.editMessageText(
        row.chat_id,
        row.message_id,
        row.summary_text,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📋 Подробнее', callback_data: `show_details_${summaryId}` }],
            ],
          },
        }
      );
    }
  });
});

// *********************************************************
// 7. Планировщики (cron)
// *********************************************************
// Проверяем новые сообщения каждую минуту
cron.schedule('* * * * *', () => processTeamsMessages());
// Раз в час отправляем сводку ошибок (если накопилось)
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());
// Сбрасываем обработанные темы в 00:05 по Москве
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects(), { timezone: 'Europe/Moscow' });
// Чистим старые сводки (старше 3 месяцев) раз в сутки, например в 03:00 по МСК
cron.schedule('0 3 * * *', () => cleanOldSummaries(), { timezone: 'Europe/Moscow' });

function cleanOldSummaries() {
  const sql = `
    DELETE FROM error_summaries
    WHERE datetime(created_at) < datetime('now', '-3 months')
  `;
  db.run(sql, function (err) {
    if (err) {
      console.error('Ошибка при удалении старых сводок:', err);
    } else {
      console.log(`Старые сводки удалены. Удалено записей: ${this.changes}`);
    }
  });
}

// *********************************************************
// 8. Дополнительные команды бота и обработка ошибок
// *********************************************************
bot.command('start', (ctx) => {
  ctx.reply('✅ Бот запущен. Обработка сообщений Teams включена.');
});

bot.catch((err) => {
  console.error('Ошибка бота:', err);
});

bot.start();