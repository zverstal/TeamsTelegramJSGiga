// Загружаем переменные окружения
require('dotenv').config();
const { Bot } = require('grammy');
const axios = require('axios');
const https = require('https');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Инициализация бота
const bot = new Bot(process.env.BOT_API_KEY);

// Конфигурация Microsoft OAuth2
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
const collectedErrors = [];
const processedErrorSubjects = new Set();

const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

async function saveLastProcessedMessageId(id) {
    try {
        await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
    } catch (error) {
        console.error('Ошибка сохранения lastMessageId:', error);
    }
}

function loadLastProcessedMessageId() {
    try {
        if (fs.existsSync(lastMessageIdFile)) {
            const data = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
            if (data) lastProcessedMessageId = data;
        }
    } catch (error) {
        console.error('Ошибка загрузки lastMessageId:', error);
    }
}

function loadProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            const data = fs.readFileSync(processedSubjectsFile, 'utf8').trim();
            if (data) JSON.parse(data).forEach(subject => processedErrorSubjects.add(subject));
        }
    } catch (error) {
        console.error('Ошибка загрузки processedErrorSubjects:', error);
    }
}

async function saveProcessedErrorSubjects() {
    try {
        await fs.promises.writeFile(processedSubjectsFile, JSON.stringify([...processedErrorSubjects], null, 2), 'utf8');
    } catch (error) {
        console.error('Ошибка сохранения processedErrorSubjects:', error);
    }
}

async function resetProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            await fs.promises.unlink(processedSubjectsFile);
        }
        processedErrorSubjects.clear();
    } catch (error) {
        console.error('Ошибка сброса processedErrorSubjects:', error);
    }
}

loadLastProcessedMessageId();
loadProcessedErrorSubjects();

async function getMicrosoftToken() {
    const cca = new ConfidentialClientApplication(msalConfig);
    const tokenRequest = { scopes: ['https://graph.microsoft.com/.default'] };
    try {
        const response = await cca.acquireTokenByClientCredential(tokenRequest);
        return response.accessToken;
    } catch (err) {
        console.error('Ошибка получения токена Microsoft:', err.message);
        return null;
    }
}

function extractTextContent(message) {
    const rawText = message.body?.content || '';
    const text = rawText.replace(/<\/?[^>]+(>|$)/g, '').trim();
    let sender = 'Неизвестно';
    let subject = 'Без темы';
    let isReply = false;
    const lines = text.split('\n').map(line => line.trim());
    let body = '';

    for (const line of lines) {
        if (line.startsWith('Отправитель:')) sender = line.replace(/^Отправитель:\s*/i, '').trim();
        else if (line.startsWith('Тема:')) {
            subject = line.replace(/^Тема:\s*/i, '').trim();
            if (/^RE:/i.test(subject)) {
                isReply = true;
                subject = subject.replace(/^RE:\s*/i, '').trim();
            }
        } else body += (body ? '\n' : '') + line;
    }

    const errorKeywords = /ошибка|оповещение|failed|error|ошибки|exception|critical/i;
    const isError = sender.toLowerCase() === 'noreply@winline.kz' && (errorKeywords.test(subject) || errorKeywords.test(body));

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
    }
    return { type: 'Другое', id: 'N/A' };
}

async function fetchTeamsMessages(token, teamId, channelId) {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return response.data.value.map(extractTextContent).sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
    } catch (err) {
        console.error('Ошибка получения сообщений из Teams:', err.message);
        return [];
    }
}

async function sendErrorSummaryIfNeeded() {
    if (collectedErrors.length === 0) return;

    const errorCountBySubject = {};
    collectedErrors.forEach(error => {
        if (errorCountBySubject[error.subject]) {
            errorCountBySubject[error.subject].count += 1;
            errorCountBySubject[error.subject].lastOccurred = error.createdDateTime;
        } else {
            errorCountBySubject[error.subject] = {
                count: 1,
                lastOccurred: error.createdDateTime,
                body: error.body,
            };
        }
    });

    let summary = '🔍 *Сводка ошибок за последний час:*\n\n';
    for (const [subject, data] of Object.entries(errorCountBySubject)) {
        const lastDate = new Date(data.lastOccurred).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
        summary += `📌 *Тема:* ${subject}\n- *Количество:* ${data.count}\n- *Последнее появление:* ${lastDate}\n\n`;
    }

    lastSummaryText = summary;
    const message = await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '📋 Подробнее', callback_data: 'show_details' }]]
        }
    });

    lastSummaryMessage = {
        message_id: message.message_id,
        chat_id: message.chat.id,
    };

    collectedErrors.length = 0;
}

async function processTeamsMessages() {
    const msToken = await getMicrosoftToken();
    if (!msToken) return;

    const messages = await fetchTeamsMessages(msToken, process.env.TEAM_ID, process.env.CHANNEL_ID);
    if (messages.length === 0) return;

    const newMessages = messages.filter(msg => !lastProcessedMessageId || msg.id > lastProcessedMessageId);
    if (newMessages.length === 0) return;

    lastProcessedMessageId = newMessages[newMessages.length - 1].id;
    await saveLastProcessedMessageId(lastProcessedMessageId);

    const errors = newMessages.filter(msg => msg.isError);
    for (const errorMsg of errors) {
        const { type, id } = getErrorTypeAndIdentifier(errorMsg);
        errorMsg.type = type;
        errorMsg.extractedId = id;

        if (!processedErrorSubjects.has(errorMsg.subject)) {
            const msgText = `❗ *Новая ошибка обнаружена:*\n\n📌 *Тема:* ${errorMsg.subject}`;
            await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, msgText, { parse_mode: 'Markdown' });
            processedErrorSubjects.add(errorMsg.subject);
            await saveProcessedErrorSubjects();
        } else {
            collectedErrors.push(errorMsg);
        }
    }
}

bot.on('callback_query:data', async (ctx) => {
    const action = ctx.callbackQuery.data;
    if (!lastSummaryMessage) return;

    if (action === 'show_details') {
        const grouped = collectedErrors.reduce((acc, err) => {
            acc[err.type] = acc[err.type] || [];
            acc[err.type].push(err.extractedId);
            return acc;
        }, {});

        let details = '📋 *Детали ошибок по типам:*\n\n';
        for (const [type, ids] of Object.entries(grouped)) {
            const uniqueIds = [...new Set(ids)].sort();
            details += `*${type}* (${uniqueIds.length}):\n\`${uniqueIds.join(', ')}\`\n\n`;
        }

        await ctx.answerCallbackQuery();
        await bot.api.editMessageText(
            lastSummaryMessage.chat_id,
            lastSummaryMessage.message_id,
            details,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔼 Скрыть', callback_data: 'hide_details' }]]
                }
            }
        );
    }

    if (action === 'hide_details') {
        await ctx.answerCallbackQuery();
        await bot.api.editMessageText(
            lastSummaryMessage.chat_id,
            lastSummaryMessage.message_id,
            lastSummaryText,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '📋 Подробнее', callback_data: 'show_details' }]]
                }
            }
        );
    }
});

cron.schedule('* * * * *', () => processTeamsMessages());
cron.schedule('0 * * * *', () => sendErrorSummaryIfNeeded());
cron.schedule('5 0 * * *', () => resetProcessedErrorSubjects(), { timezone: 'Europe/Moscow' });

bot.command('start', (ctx) => ctx.reply('✅ Бот запущен. Обработка сообщений Teams включена.'));
bot.catch((err) => console.error('Ошибка бота:', err));
bot.start();