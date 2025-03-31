// bot.js
require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const bot = new Bot(process.env.BOT_API_KEY);

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
    db.run(`CREATE TABLE IF NOT EXISTS error_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message_id TEXT,
      summary_text TEXT,
      details_json TEXT,
      created_at TEXT
    )`);
  });
}
initDatabase();

let lastProcessedMessageId = null;
const collectedErrors = [];
const processedErrorSubjects = new Set();

const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

function loadLastProcessedMessageId() {
  try {
    if (fs.existsSync(lastMessageIdFile)) {
      lastProcessedMessageId = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
    }
  } catch (e) { console.error(e); }
}

function loadProcessedErrorSubjects() {
  try {
    if (fs.existsSync(processedSubjectsFile)) {
      JSON.parse(fs.readFileSync(processedSubjectsFile, 'utf8'))
        .forEach((s) => processedErrorSubjects.add(s));
    }
  } catch (e) { console.error(e); }
}

loadLastProcessedMessageId();
loadProcessedErrorSubjects();

async function saveLastProcessedMessageId(id) {
  await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
}

async function saveProcessedErrorSubjects() {
  await fs.promises.writeFile(
    processedSubjectsFile,
    JSON.stringify([...processedErrorSubjects], null, 2),
    'utf8'
  );
}

async function resetProcessedErrorSubjects() {
  processedErrorSubjects.clear();
  if (fs.existsSync(processedSubjectsFile)) fs.unlinkSync(processedSubjectsFile);
}

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

function extractTextContent(message) {
  const raw = message.body?.content || '';
  const text = raw.replace(/<[^>]+>/g, '').trim();
  let sender = 'Неизвестно';
  let subject = 'Без темы';
  let isReply = false;
  let body = '';
  text.split('\n').forEach((line) => {
    line = line.trim();
    if (line.startsWith('Отправитель:')) sender = line.replace('Отправитель:', '').trim();
    else if (line.startsWith('Тема:')) {
      subject = line.replace('Тема:', '').trim();
      if (/^RE:/i.test(subject)) {
        isReply = true;
        subject = subject.replace(/^RE:/i, '').trim();
      }
    } else body += (body ? '\n' : '') + line;
  });
  const isError = sender.toLowerCase() === 'noreply@winline.kz' && /(ошибка|оповещение|ошибки|ошибочка|error|fail|exception|critical)/i.test(subject + ' ' + body);
  return { id: message.id, sender, subject, body, isReply, isError, createdDateTime: message.createdDateTime };
}

function getErrorTypeAndIdentifier(msg) {
  const txt = msg.body.toLowerCase();
  if (msg.subject.includes('STOPAZART')) return { type: 'STOPAZART', id: txt.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден' };
  if (msg.subject.includes('SmartBridge')) return { type: 'SmartBridge', id: txt.match(/номер транзакции\s*([0-9]+)/i)?.[1] || 'не найден' };
  if (msg.subject.includes('реестре должников')) return { type: 'Реестр должников', id: txt.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден' };
  return { type: 'Другое', id: 'N/A' };
}

async function fetchTeamsMessages(token, teamId, channelId) {
  try {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.value.map(extractTextContent);
  } catch (e) {
    console.error('Fetch Teams error:', e);
    return [];
  }
}

async function summarizeMessages(messages, lastMsgId) {
  const list = messages.map((msg) => {
    const reply = msg.isReply ? '\nТип: Ответ (тема из контекста предыдущего сообщения)' : '';
    return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${reply}\nТекст сообщения: ${msg.body}`;
  }).join('\n\n');

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

${list}`.trim();

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
}

// Остальной код добавлен ниже

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
  db.run(`INSERT INTO error_summaries (chat_id, message_id, summary_text, details_json, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    [String(msg.chat.id), String(msg.message_id), summary, JSON.stringify(details), createdAt],
    function (err) {
      if (err) return console.error('DB insert error:', err);
      const summaryId = this.lastID;
      const keyboard = new InlineKeyboard().text('📋 Подробнее', `show_details_${summaryId}`);
      bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: keyboard })
        .catch(e => console.error('Edit markup error:', e));
    });
}

async function processTeamsMessages() {
  const token = await getMicrosoftToken();
  if (!token) return;
  const messages = await fetchTeamsMessages(token, process.env.TEAM_ID, process.env.CHANNEL_ID);
  if (messages.length === 0) return;

  const newMessages = messages.filter(m => !lastProcessedMessageId || m.id > lastProcessedMessageId);
  if (newMessages.length === 0) return;

  lastProcessedMessageId = newMessages[newMessages.length - 1].id;
  await saveLastProcessedMessageId(lastProcessedMessageId);

  const errors = newMessages.filter(m => m.isError);
  const normal = newMessages.filter(m => !m.isError);

  for (const msg of errors) {
    const { type, id } = getErrorTypeAndIdentifier(msg);
    msg.type = type;
    msg.extractedId = id;

    if (!processedErrorSubjects.has(msg.subject)) {
      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `❗ *Новая ошибка:*\n📌 *Тема:* ${msg.subject}`, {
        parse_mode: 'Markdown',
      });
      processedErrorSubjects.add(msg.subject);
      await saveProcessedErrorSubjects();
    } else {
      collectedErrors.push(msg);
    }
  }

  if (normal.length > 0) {
    const summary = await summarizeMessages(normal, lastProcessedMessageId);
    if (summary) {
      await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `📝 *Суммаризация сообщений:*\n\n${summary}`, {
        parse_mode: 'Markdown',
      });
    }
  }
}

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const match = data.match(/^(show_details|hide_details)_(\d+)$/);
  if (!match) return ctx.answerCallbackQuery({ text: 'Неверный формат.', show_alert: true });

  const [_, action, id] = match;
  db.get('SELECT * FROM error_summaries WHERE id = ?', [id], async (err, row) => {
    if (err || !row) return ctx.answerCallbackQuery({ text: 'Сводка не найдена.', show_alert: true });

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

cron.schedule('* * * * *', () => processTeamsMessages());
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects());
cron.schedule('0 3 * * *', () => {
  db.run(`DELETE FROM error_summaries WHERE datetime(created_at) < datetime('now', '-3 months')`, function (err) {
    if (err) console.error('Очистка сводок:', err);
    else console.log(`Удалено старых сводок: ${this.changes}`);
  });
});

bot.command('start', (ctx) => ctx.reply('✅ Бот активен. Ждёт ошибки в Teams.'));
bot.catch((err) => console.error('Ошибка бота:', err));
bot.start();
