// bot.js — Telegram ⇄ Teams bridge, SQLite only, логирование расширено

require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const winston = require('winston');
const { DateTime } = require('luxon');

/* -------- 0. Логгер -------- */
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize({ all: true }), winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)) }),
    new winston.transports.File({ filename: path.join(logDir, 'app.log') }),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
  ],
});

/* -------- 1. Telegram -------- */
const bot = new Bot(process.env.BOT_API_KEY);

/* -------- 2. MSAL -------- */
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

/* -------- 3. SQLite -------- */
let db;
function initDatabase() {
  db = new sqlite3.Database(path.join(__dirname, 'summaries.db'), (err) => {
    if (err) return logger.error(`[db] SQLite error: ${err}`);
    db.run(`CREATE TABLE IF NOT EXISTS error_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT, message_id TEXT, summary_text TEXT, created_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT, text_hash TEXT, created_at TEXT,
      UNIQUE(chat_id, text_hash)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS error_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT, type TEXT, extracted_id TEXT, created_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS persistent_vars (
      key TEXT PRIMARY KEY, value TEXT
    )`);
    logger.info('[db] DB schema checked');
  });
}
initDatabase();

/* -------- 4. Helpers -------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function buildCsv(rows) {
  return ['hour,type,count', ...rows.map(r => `${r.hour},${r.type},${r.cnt}`)].join('\n');
}

// Экспортирует summary и детали в один CSV, без кракозябр, с BOM и кавычками
async function generateCsvForDate(dateIso) {
  return new Promise((resolve) => {
    db.all(`
      SELECT created_at, type, extracted_id as id, subject
      FROM error_events
      WHERE date(created_at, 'localtime') = ?
      ORDER BY created_at
    `, [dateIso], (err, rows) => {
      if (err) { logger.error(err); return resolve(null); }

      // Готовим детализированные строки
      const detailRows = rows.map(r => {
        const msk = DateTime.fromISO(r.created_at, { zone: 'utc' }).setZone('Europe/Moscow');
        return {
          timestamp: msk.toFormat('yyyy-MM-dd HH:mm:ss'),
          hour: String(msk.hour).padStart(2, '0'),
          type: r.type,
          id: r.id,
          subject: r.subject || '',
        };
      });

      // Считаем summary
      const summaryMap = {};
      for (const r of detailRows) {
        const key = `${r.hour},${r.type}`;
        summaryMap[key] = (summaryMap[key] || 0) + 1;
      }
      const summaryRows = Object.entries(summaryMap).map(([key, cnt]) => {
        const [hour, type] = key.split(',');
        return { hour, type, cnt };
      }).sort((a, b) => a.hour.localeCompare(b.hour) || a.type.localeCompare(b.type));

      // Функция для CSV-экранирования (кавычки удваиваются, поля в кавычки)
      const esc = v =>
        `"${String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

      // Формируем CSV с BOM, summary и деталями
      let csv = '\uFEFF' +
        '# Сводка по часам (МСК)\r\n' +
        'hour,type,count\r\n' +
        summaryRows.map(r => [esc(r.hour), esc(r.type), esc(r.cnt)].join(',')).join('\r\n') +
        '\r\n\r\n# Детализация (timestamp МСК, type, id, subject)\r\n' +
        'timestamp,type,id,subject\r\n' +
        detailRows.map(r =>
          [esc(r.timestamp), esc(r.type), esc(r.id), esc(r.subject)].join(',')
        ).join('\r\n');

      const dir = path.join(__dirname, 'reports');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = `errors_${dateIso}_${new Date().toISOString().slice(11,13)}00.csv`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, csv, 'utf8');
      resolve({ filePath, fileName });
    });
  });
}

async function safeSendMessage(chatId, text, options = {}) {
  logger.debug(`[send] Проверка дубликата для chat_id=${chatId}`);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const dup = await new Promise(res => {
    db.get(`SELECT id FROM sent_messages WHERE chat_id=? AND text_hash=?`, [String(chatId), hash], (e, r) => { if (e) { logger.error(e); return res(true); } res(!!r); });
  });
  if (dup) { logger.debug('[send] Дубликат, пропускаем'); return null; }
  logger.info(`[send] Отправка сообщения в chat_id=${chatId}`);
  const msg = await bot.api.sendMessage(chatId, text, options);
  db.run(`INSERT OR IGNORE INTO sent_messages (chat_id,text_hash,created_at) VALUES(?,?,?)`, [String(chatId), hash, new Date().toISOString()]);
  return msg;
}
async function setPersistentVar(key, value) {
  db.run(`INSERT INTO persistent_vars(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
}
function getPersistentVar(key) {
  return new Promise(res => {
    db.get(`SELECT value FROM persistent_vars WHERE key=?`, [key], (err, row) => {
      if (err || !row) return res(null);
      res(row.value);
    });
  });
}

/* -------- 5. Состояние: только SQLite -------- */
let processedErrorSubjects = new Set();
let lastProcessedMessageId = null;
async function loadState() {
  lastProcessedMessageId = await getPersistentVar('lastProcessedMessageId');
  logger.info('[state] lastProcessedMessageId = ' + lastProcessedMessageId);
  const processed = await getPersistentVar('processedErrorSubjects');
  processedErrorSubjects = new Set(processed ? JSON.parse(processed) : []);
  logger.info('[state] Загружено processedErrorSubjects (' + processedErrorSubjects.size + ')');
}
async function saveState() {
  await setPersistentVar('lastProcessedMessageId', lastProcessedMessageId || '');
  await setPersistentVar('processedErrorSubjects', JSON.stringify([...processedErrorSubjects]));
  logger.info('[state] Сохранено состояние');
}
loadState();

/* -------- 6. Graph + Teams -------- */
async function getMicrosoftToken() {
  logger.info('[MSAL] Получение токена MS');
  const cca = new ConfidentialClientApplication(msalConfig);
  try {
    const token = (await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })).accessToken;
    logger.debug('[MSAL] Успешно');
    return token;
  } catch (e) {
    logger.error('[MSAL] Ошибка: ' + e);
    return null;
  }
}
function extractTextContent(m) {
  const text = (m.body?.content || '').replace(/<[^>]+>/g, '').trim();
  let sender = 'Неизвестно', subject = 'Без темы', isReply = false, body = '';
  text.split('\n').forEach(line => {
    line = line.trim();
    if (line.startsWith('Отправитель:')) sender = line.replace('Отправитель:', '').trim();
    else if (line.startsWith('Тема:')) { subject = line.replace('Тема:', '').trim(); if (/^RE:/i.test(subject)) { isReply = true; subject = subject.replace(/^RE:/i, '').trim(); } }
    else body += (body ? '\n' : '') + line;
  });
  const isError = sender.toLowerCase() === 'noreply@winline.kz' && /(ошибка|оповещение|ошибки|error|fail|exception|critical)/i.test(subject + ' ' + body);
  return { id: m.id, sender, subject, body, isReply, isError, createdDateTime: m.createdDateTime };
}
async function fetchTeamsMessages(token, teamId, channelId) {
  logger.info('[teams] Запрос сообщений');
  try {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    logger.info(`[teams] Получено сообщений: ${res.data.value.length}`);
    return res.data.value.map(extractTextContent);
  } catch (e) {
    logger.error('[teams] Ошибка: ' + e);
    return [];
  }
}
function classifyError(msg) {
  const l = msg.body.toLowerCase();
  if (msg.subject.includes('STOPAZART')) return { type: 'STOPAZART', id: l.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден' };
  if (msg.subject.includes('SmartBridge')) return { type: 'SmartBridge', id: l.match(/номер транзакции\s*([0-9]+)/i)?.[1] || 'не найден' };
  if (msg.subject.includes('реестре должников')) return { type: 'Реестр должников', id: l.match(/id игрока[:\s]*([0-9]+)/i)?.[1] || 'не найден' };
  return { type: 'Другое', id: 'N/A' };
}

/* -------- 7. Summarization с полным промтом -------- */
async function summarizeMessages(messages, lastMsgId) {
  if (!messages.length) return null;
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
4. Содержание: составь одно‑два предложения, точно передающих суть сообщения, сохраняя все технические детали и вопросы. Не пересказывай сообщение слишком сильно.
5. Игнорируй элементы, не влияющие на понимание сути (например, стандартные подписи, ссылки и неинформативные фразы).

Составь резюме для следующих сообщений:

${list}
`.trim();
  logger.info(`[gpt] Summarizing ${messages.length} messages`);
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1000,
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      }
    );
    logger.info('[gpt] Результат получен');
    return res.data.choices[0]?.message?.content || '';
  } catch (err) {
    logger.error(`[gpt] Ошибка: ${err}`);
    return null;
  }
}

/* -------- 8. Сбор ошибок и их логгирование -------- */
const collectedErrors = [];
function logErrorEvent(msg) {
  db.run(`INSERT INTO error_events(subject,type,extracted_id,created_at) VALUES(?,?,?,?)`, [msg.subject, msg.type, msg.extractedId, msg.createdDateTime]);
  logger.debug(`[error-event] Добавлена ошибка: ${msg.subject} (${msg.type})`);
}

/* -------- 9. Hourly summary -------- */
async function sendErrorSummaryIfNeeded() {
  if (!collectedErrors.length) { logger.debug('Нет новых ошибок для сводки'); return; }
  const grouped = {};
  collectedErrors.forEach(e => {
    if (!grouped[e.subject]) grouped[e.subject] = { cnt: 0, last: e.createdDateTime };
    grouped[e.subject].cnt++; grouped[e.subject].last = e.createdDateTime;
  });
  const totalErrors = collectedErrors.length;
  const subjectsCnt = Object.keys(grouped).length;
  logger.info(`[hourly] Preparing: ${subjectsCnt} subjects, ${totalErrors} errors`);
  let txt = '🔍 *Сводка ошибок за последний час:*\n';
  for (const [s, d] of Object.entries(grouped)) txt += `📌 *${s}* — ${d.cnt}\n`;
  const msg = await safeSendMessage(
    process.env.TELEGRAM_CHAT_ID,
    txt,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('📥 CSV за день', 'csv_today') }
  );
  if (msg) {
    logger.info(`[hourly] Сводка отправлена (message_id=${msg.message_id})`);
    db.run(`INSERT INTO error_summaries(chat_id,message_id,summary_text,created_at) VALUES(?,?,?,?)`,
      [String(msg.chat.id), String(msg.message_id), txt, new Date().toISOString()]);
  } else {
    logger.warn('[hourly] Сводка была пропущена из-за дубликата');
  }
  collectedErrors.length = 0;
}

/* -------- 10. Callback (CSV за день) -------- */
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('csv')) return ctx.answerCallbackQuery({ text: '🤔 Неизвестная команда', show_alert: true });
  await ctx.answerCallbackQuery();
  const dateIso = todayStr();
  const res = await generateCsvForDate(dateIso);
  if (!res) { await ctx.reply('Не удалось сформировать CSV'); return; }
  await bot.api.sendDocument(ctx.chat.id, new InputFile(fs.createReadStream(res.filePath), res.fileName), { caption: `📊 CSV‑отчёт за ${dateIso}` });
  logger.info(`[CSV] Отчёт отправлен (${res.fileName})`);
});

async function processTeamsMessages() {
  logger.info('[loop] Чтение новых сообщений');
  const token = await getMicrosoftToken();
  if (!token) return;
  const msgs = await fetchTeamsMessages(token, process.env.TEAM_ID, process.env.CHANNEL_ID);
  if (!msgs.length) return;

  // ВНИМАНИЕ: ids — строки, но мы сравниваем лексикографически, что для UUID подходит
  const newMsgs = lastProcessedMessageId
    ? msgs.filter(m => m.id > lastProcessedMessageId)
    : msgs;

  if (!newMsgs.length) { logger.info('[loop] Нет новых сообщений'); return; }

  // ВАЖНО! Ищем максимальный id (он будет в последнем элементе, если сортировка гарантирована)
  // Обычно Graph отдаёт от новых к старым — значит newMsgs[0] — самый свежий
  lastProcessedMessageId = newMsgs[0].id;
  await saveState();

  const errors = newMsgs.filter(m => m.isError), ordinary = newMsgs.filter(m => !m.isError);
  for (const m of errors) {
    const { type, id } = classifyError(m);
    m.type = type; m.extractedId = id;
    logErrorEvent(m);
    if (!processedErrorSubjects.has(m.subject)) {
      await safeSendMessage(process.env.TELEGRAM_CHAT_ID, `❗ *Новая ошибка:* ${m.subject}`, { parse_mode: 'Markdown' });
      processedErrorSubjects.add(m.subject);
      await saveState();
    } else {
      collectedErrors.push(m);
    }
  }
  if (ordinary.length) {
    const sum = await summarizeMessages(ordinary, lastProcessedMessageId);
    if (sum) {
      const sent = await safeSendMessage(process.env.TELEGRAM_CHAT_ID, `📝 *Суммаризация сообщений:*\n\n${sum}`, { parse_mode: 'Markdown' });
      if (sent) logger.info(`[loop] Teams summary sent (message_id=${sent.message_id}, items=${ordinary.length})`);
    }
  }
}

/* -------- 12. CRON -------- */
cron.schedule('* * * * *', () => processTeamsMessages());
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());
cron.schedule('0 * * * *', async () => {
  const { filePath, fileName } = await generateCsvForDate(todayStr());
  if (filePath) await bot.api.sendDocument(process.env.TELEGRAM_CHAT_ID, new InputFile(fs.createReadStream(filePath), fileName), { caption: `📊 Авто‑CSV за ${todayStr()}` });
});

/* -------- 13. Команды -------- */
bot.command('start', ctx => ctx.reply('✅ Бот активен.'));
bot.catch(e => logger.error(e));
bot.start();
logger.info('Bot started — SQLite only');
