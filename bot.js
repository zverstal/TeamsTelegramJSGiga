// Загружаем переменные окружения
require('dotenv').config();
const { Bot } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_API_KEY);

const msalConfig = {
    auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
};

let lastProcessedMessageId = null;
let lastSummaryMessage = null;
let lastSummaryText = '';
let lastErrorSummaryDetails = null;

const collectedErrors = [];
const processedErrorSubjects = new Set();

const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

// Сохранить последний обработанный ID в файл
async function saveLastProcessedMessageId(id) {
    try {
        await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
    } catch (error) {
        console.error('Ошибка при сохранении lastMessageId.txt:', error);
    }
}

// Загрузить последний обработанный ID из файла
function loadLastProcessedMessageId() {
    try {
        if (fs.existsSync(lastMessageIdFile)) {
            const data = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
            if (data) {
                lastProcessedMessageId = data;
            }
        }
    } catch (error) {
        console.error('Ошибка при загрузке lastMessageId.txt:', error);
    }
}

// Загрузка обработанных тем ошибок (чтобы не дублировать уведомления)
function loadProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            const data = fs.readFileSync(processedSubjectsFile, 'utf8').trim();
            const subjects = JSON.parse(data);
            if (Array.isArray(subjects)) {
                subjects.forEach(subject => processedErrorSubjects.add(subject));
            }
        }
    } catch (error) {
        console.error('Ошибка при загрузке processedErrorSubjects.json:', error);
    }
}

// Сохранение обработанных тем ошибок
async function saveProcessedErrorSubjects() {
    try {
        await fs.promises.writeFile(processedSubjectsFile, JSON.stringify([...processedErrorSubjects], null, 2), 'utf8');
    } catch (error) {
        console.error('Ошибка при сохранении processedErrorSubjects.json:', error);
    }
}

// Сброс обработанных тем ошибок (например, раз в сутки)
async function resetProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            await fs.promises.unlink(processedSubjectsFile);
        }
        processedErrorSubjects.clear();
    } catch (error) {
        console.error('Ошибка при сбросе processedErrorSubjects:', error);
    }
}

// Изначально загружаем состояние из файлов
loadLastProcessedMessageId();
loadProcessedErrorSubjects();

// Получение токена Microsoft Graph
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

// Парсинг одного сообщения Teams
function extractTextContent(message) {
    const rawText = message.body?.content || '';
    // Убираем HTML-теги
    const text = rawText.replace(/<\/?[^>]+(>|$)/g, '').trim();

    let sender = 'Неизвестно';
    let subject = 'Без темы';
    let isReply = false;
    let body = '';

    // Разбиваем на строки
    const lines = text.split('\n').map(line => line.trim());

    // Парсим
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
            // Остальное считаем телом
            body += (body ? '\n' : '') + line;
        }
    }

    // Проверка, является ли сообщением об ошибке
    const errorKeywords = /ошибка|оповещение|failed|error|ошибки|exception|critical/i;
    const isError = (
        sender.toLowerCase() === 'noreply@winline.kz' &&
        (errorKeywords.test(subject) || errorKeywords.test(body))
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

// Выделяем тип ошибки и ID
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

// Чтение сообщений из указанной команды и канала
async function fetchTeamsMessages(token, teamId, channelId) {
    console.log('📡 Чтение сообщений из Teams...');
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const messages = response.data.value.map(extractTextContent);
        console.log(`📥 Найдено ${messages.length} сообщений.`);
        // Сортируем по дате создания
        return messages.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
    } catch (err) {
        console.error(`Ошибка при чтении сообщений из Teams: ${err.message}`);
        return [];
    }
}

// Суммаризация сообщений через OpenAI
async function summarizeMessages(messages, lastMsgId) {
    console.log('🧠 Запрос к OpenAI для суммаризации...');

    try {
        // Формируем список сообщений
        const messageList = messages.map((msg) => {
            const replyIndicator = msg.isReply ? '\nТип: Ответ (тема из контекста предыдущего сообщения)' : '';
            return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${replyIndicator}\nТекст сообщения: ${msg.body}`;
        }).join('\n\n');

        // Промт с правилами
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

${messageList}
        `.trim();

        const requestData = {
            model: 'gpt-4o-mini',
            temperature: 0.0,
            max_tokens: 1000,
            messages: [
                { role: 'user', content: prompt },
            ],
        };

        // Запрос к OpenAI
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

// Отправка сводки ошибок, если есть накопленные
async function sendErrorSummaryIfNeeded() {
    if (collectedErrors.length === 0) return;

    const errorCountBySubject = {};
    collectedErrors.forEach(error => {
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

    // Сохраняем детали для кнопки "Подробнее"
    lastErrorSummaryDetails = collectedErrors.map(e => ({ type: e.type, id: e.extractedId }));
    lastSummaryText = summary;

    // Отправляем сообщение в Telegram
    const message = await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '📋 Подробнее', callback_data: 'show_details' }]],
        },
    });

    // Запоминаем ID отправленного сообщения, чтобы обновлять при нажатии кнопок
    lastSummaryMessage = {
        message_id: message.message_id,
        chat_id: message.chat.id,
    };

    // Очищаем массив
    collectedErrors.length = 0;
}

// Основная функция: читать новые сообщения, определять ошибки, суммаризировать
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

    // Фильтруем новые сообщения
    const newMessages = messages.filter(msg => !lastProcessedMessageId || msg.id > lastProcessedMessageId);
    if (newMessages.length === 0) {
        console.log('📭 Нет новых сообщений с момента последней проверки.');
        return;
    }

    // Последний ID
    lastProcessedMessageId = newMessages[newMessages.length - 1].id;
    await saveLastProcessedMessageId(lastProcessedMessageId);

    // Разделяем на ошибки и обычные
    const errors = newMessages.filter(msg => msg.isError);
    const normalMessages = newMessages.filter(msg => !msg.isError);

    // Обрабатываем ошибки
    for (const errorMsg of errors) {
        const { type, id } = getErrorTypeAndIdentifier(errorMsg);
        errorMsg.type = type;
        errorMsg.extractedId = id;

        // Если это первая такая тема, сразу шлём уведомление, иначе копим для сводки
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

// Обработка callback из кнопок "Подробнее" и "Скрыть"
bot.on('callback_query:data', async (ctx) => {
    const action = ctx.callbackQuery.data;
    if (!lastSummaryMessage) return; // Нет сводки

    if (action === 'show_details') {
        // Нажали показать детали
        if (!lastErrorSummaryDetails?.length) {
            await ctx.answerCallbackQuery({ text: 'Нет данных.', show_alert: true });
            return;
        }

        // Группируем по типу
        const grouped = lastErrorSummaryDetails.reduce((acc, err) => {
            acc[err.type] = acc[err.type] || [];
            acc[err.type].push(err.id);
            return acc;
        }, {});

        let details = '📋 *Детали ошибок по типам:*\n';
        for (const [type, ids] of Object.entries(grouped)) {
            const uniqueIds = [...new Set(ids)].sort();
            details += `*${type}* (${uniqueIds.length}):\n\`${uniqueIds.join(', ')}\`\n`;
        }

        await ctx.answerCallbackQuery();
        await bot.api.editMessageText(
            lastSummaryMessage.chat_id,
            lastSummaryMessage.message_id,
            details,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔼 Скрыть', callback_data: 'hide_details' }]] },
            }
        );
    } else if (action === 'hide_details') {
        // Нажали скрыть
        await ctx.answerCallbackQuery();
        await bot.api.editMessageText(
            lastSummaryMessage.chat_id,
            lastSummaryMessage.message_id,
            lastSummaryText,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '📋 Подробнее', callback_data: 'show_details' }]] },
            }
        );
    }
});

// Планировщики
cron.schedule('* * * * *', () => processTeamsMessages()); // Каждую минуту
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded()); // Раз в час
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects(), { timezone: 'Europe/Moscow' }); // Сброс обработанных тем в 00:05

// Бот-команда /start
bot.command('start', (ctx) => {
    ctx.reply('✅ Бот запущен. Обработка сообщений Teams включена.');
});

// Ловим ошибки бота
bot.catch((err) => {
    console.error('Ошибка бота:', err);
});

// Старт
bot.start();
