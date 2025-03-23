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

// Настройка конфигурации OAuth2 для Microsoft Graph
const msalConfig = {
    auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
    },
};

// Переменные для отслеживания состояния
let lastProcessedMessageId = null;       // Последний обработанный ID сообщения
const collectedErrors = [];                // Сбор ошибок для последующей сводки
const processedErrorSubjects = new Set();  // Сохранение тем ошибок (чтобы не дублировать уведомления)

// Пути к файлам состояния
const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

// Функция для сохранения lastProcessedMessageId
async function saveLastProcessedMessageId(id) {
    try {
        await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
        console.log(`✅ Сохранен последний ID сообщения: ${id}`);
    } catch (error) {
        console.error('❌ Ошибка при сохранении lastMessageId.txt:', error);
    }
}

// Функция для загрузки lastProcessedMessageId при старте
function loadLastProcessedMessageId() {
    try {
        if (fs.existsSync(lastMessageIdFile)) {
            const data = fs.readFileSync(lastMessageIdFile, 'utf8').trim();
            if (data) {
                lastProcessedMessageId = data;
                console.log(`📥 Загружен последний ID сообщения: ${lastProcessedMessageId}`);
            } else {
                console.log('ℹ️ lastMessageId.txt пуст. Начинаем с нуля.');
            }
        } else {
            console.log('ℹ️ Файл lastMessageId.txt не найден. Начинаем с нуля.');
        }
    } catch (error) {
        console.error('❌ Ошибка при загрузке lastMessageId.txt:', error);
    }
}

// Функция для загрузки processedErrorSubjects при старте
function loadProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            const data = fs.readFileSync(processedSubjectsFile, 'utf8').trim();
            if (data) {
                const subjects = JSON.parse(data);
                if (Array.isArray(subjects)) {
                    subjects.forEach(subject => processedErrorSubjects.add(subject));
                    console.log(`📥 Загружено ${processedErrorSubjects.size} обработанных тем ошибок.`);
                } else {
                    console.warn('⚠️ processedErrorSubjects.json не содержит массива. Инициализируем пустым набором.');
                }
            } else {
                console.log('ℹ️ processedErrorSubjects.json пуст. Начинаем с пустого набора.');
            }
        } else {
            console.log('ℹ️ Файл processedErrorSubjects.json не найден. Начинаем с пустого набора.');
        }
    } catch (error) {
        console.error('❌ Ошибка при загрузке processedErrorSubjects.json:', error);
    }
}

// Функция для сохранения processedErrorSubjects в JSON-файл
async function saveProcessedErrorSubjects() {
    try {
        const subjectsArray = Array.from(processedErrorSubjects);
        await fs.promises.writeFile(processedSubjectsFile, JSON.stringify(subjectsArray, null, 2), 'utf8');
        console.log('✅ processedErrorSubjects сохранены.');
    } catch (error) {
        console.error('❌ Ошибка при сохранении processedErrorSubjects.json:', error);
    }
}

// Функция для очистки processedErrorSubjects (сброс) через cron
async function resetProcessedErrorSubjects() {
    try {
        if (fs.existsSync(processedSubjectsFile)) {
            await fs.promises.unlink(processedSubjectsFile);
            console.log('🧹 processedErrorSubjects.json удален.');
        }
        processedErrorSubjects.clear();
        console.log('✅ Счётчик тем ошибок сброшен.');
    } catch (error) {
        console.error('❌ Ошибка при сбросе processedErrorSubjects:', error);
    }
}

// Загрузка состояния при старте
loadLastProcessedMessageId();
loadProcessedErrorSubjects();

/**
 * Получение токена Microsoft Graph
 */
async function getMicrosoftToken() {
    const cca = new ConfidentialClientApplication(msalConfig);
    const tokenRequest = {
        scopes: ['https://graph.microsoft.com/.default'],
    };

    try {
        const response = await cca.acquireTokenByClientCredential(tokenRequest);
        console.log('🔑 Microsoft OAuth2 токен получен.');
        return response.accessToken;
    } catch (err) {
        console.error('❌ Ошибка получения токена Microsoft:', err.message);
        return null;
    }
}

/**
 * Функция для извлечения информации из одного сообщения.
 * Считаем, что Teams возвращает 1 сообщение = 1 ID.
 */
function extractTextContent(message) {
    // Убираем HTML-теги
    const rawText = message.body?.content || '';
    const text = rawText.replace(/<\/?[^>]+(>|$)/g, '').trim();

    let sender = 'Неизвестно';
    let subject = 'Без темы';
    let isReply = false;

    // Разделяем на строки, чтобы найти "Отправитель:" или "Тема:"
    const lines = text.split('\n').map(line => line.trim());
    let body = '';

    for (const line of lines) {
        if (line.startsWith('Отправитель:')) {
            sender = line.replace(/^Отправитель:\s*/i, '').trim();
        } else if (line.startsWith('Тема:')) {
            subject = line.replace(/^Тема:\s*/i, '').trim();
            // Если тема начинается с "RE:" или "Re:", помечаем как ответ
            if (/^RE:/i.test(subject)) {
                isReply = true;
                // Можно сохранить оригинальную тему без "RE:" для справки
                subject = subject.replace(/^RE:\s*/i, '').trim();
            }
        } else {
            body += (body ? '\n' : '') + line;
        }
    }

    // Логика определения "ошибки"
    const errorKeywords = /ошибка|оповещение|failed|error|ошибки|exception|critical/i;
    const isError =
        sender.toLowerCase() === 'noreply@winline.kz' &&
        (errorKeywords.test(subject) || errorKeywords.test(body));

    return {
        id: message.id,
        sender,
        subject,
        body,
        isReply, // Флаг, указывающий, что сообщение является ответом
        isError,
        createdDateTime: message.createdDateTime,
    };
}

/**
 * Чтение сообщений из канала Microsoft Teams.
 */
async function fetchTeamsMessages(token, teamId, channelId) {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;

    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        console.log(`📥 Найдено ${response.data.value.length} сообщений в канале.`);

        // Преобразуем данные, используя extractTextContent
        const parsed = response.data.value.map((msg) => extractTextContent(msg));
        // Сортируем по времени
        return parsed.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
    } catch (err) {
        if (err.response) {
            console.error(`❌ Ошибка при чтении сообщений из Teams: ${err.response.status} - ${err.response.statusText}`);
            console.error(`🔍 Детали ошибки: ${JSON.stringify(err.response.data)}`);
        } else {
            console.error(`❌ Ошибка при чтении сообщений из Teams: ${err.message}`);
        }
        return [];
    }
}

/**
 * Суммаризация сообщений через OpenAI.
 * Используем модель "gpt-4o-mini" и ключ OPENAI_API_KEY.
 */
async function summarizeMessages(messages, lastMsgId) {
    try {
        // Формируем список сообщений с явным указанием, если сообщение является ответом
        const messageList = messages.map((msg) => {
            const replyIndicator = msg.isReply ? '\nТип: Ответ (тема из контекста предыдущего сообщения)' : '';
            return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}${replyIndicator}\nТекст сообщения: ${msg.body}`;
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

${messageList}
        `.trim();

        const requestData = {
            model: 'gpt-4o-mini',
            temperature: 0.0,
            max_tokens: 1000,
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            requestData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            }
        );

        console.log('📝 Суммаризация сообщений завершена.');
        return response.data.choices[0]?.message?.content || 'Нет ответа от OpenAI.';
    } catch (err) {
        console.error('❌ Ошибка при суммаризации сообщений:', err.message);
        return 'Не удалось получить резюме сообщений.';
    }
}

/**
 * Отправка сводки ошибок раз в час.
 */
async function sendErrorSummaryIfNeeded() {
    if (collectedErrors.length === 0) {
        console.log('📭 Нет новых ошибок для сводки.');
        return;
    }

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

    try {
        await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, { parse_mode: 'Markdown' });
        console.log('📤 Сводка ошибок отправлена в Telegram.');
        collectedErrors.length = 0;
    } catch (err) {
        console.error('❌ Ошибка при отправке сводки ошибок в Telegram:', err.message);
    }
}

/**
 * Основная функция обработки сообщений из Teams.
 */
async function processTeamsMessages() {
    const msToken = await getMicrosoftToken();
    if (!msToken) {
        console.error('❌ Не удалось получить токен Microsoft.');
        return;
    }

    const teamId = process.env.TEAM_ID;
    const channelId = process.env.CHANNEL_ID;

    const messages = await fetchTeamsMessages(msToken, teamId, channelId);
    if (messages.length === 0) {
        console.log('📭 Нет новых сообщений для обработки.');
        return;
    }

    const newMessages = messages.filter(msg => {
        if (!lastProcessedMessageId) return true;
        return msg.id > lastProcessedMessageId;
    });

    if (newMessages.length === 0) {
        console.log('📭 Нет новых сообщений с момента последней проверки.');
        return;
    }

    lastProcessedMessageId = newMessages[newMessages.length - 1].id;
    await saveLastProcessedMessageId(lastProcessedMessageId);

    // Фильтрация ошибок и обычных сообщений
    const errors = newMessages.filter(msg => msg.isError);
    const normalMessages = newMessages.filter(msg => !msg.isError);

    // Обработка ошибок
    if (errors.length > 0) {
        for (const errorMsg of errors) {
            const errorSubject = errorMsg.subject;
            if (!processedErrorSubjects.has(errorSubject)) {
                const errorMessage = `❗ *Новая ошибка обнаружена:*\n\n📌 *Тема:* ${errorMsg.subject}`;
                try {
                    await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, errorMessage, { parse_mode: 'Markdown' });
                    console.log('📤 Ошибка отправлена в Telegram.');
                    processedErrorSubjects.add(errorSubject);
                    await saveProcessedErrorSubjects();
                } catch (err) {
                    console.error('❌ Ошибка при отправке сообщения об ошибке в Telegram:', err.message);
                }
            } else {
                collectedErrors.push(errorMsg);
                console.log(`📥 Ошибка с темой "${errorSubject}" добавлена в сводку.`);
            }
        }
    }

    // Обработка нормальных сообщений (суммаризация)
    if (normalMessages.length > 0) {
        const summary = await summarizeMessages(normalMessages, lastProcessedMessageId);
        if (summary) {
            await bot.api.sendMessage(
                process.env.TELEGRAM_CHAT_ID,
                `📝 *Суммаризация сообщений:*\n\n${summary}`,
                { parse_mode: 'Markdown' }
            );
            console.log('📤 Суммаризация сообщений отправлена в Telegram.');
        }
    }
}

// Запуск задачи cron для обработки сообщений каждую минуту
cron.schedule('* * * * *', () => {
    console.log('🔄 Запуск обработки сообщений Teams...');
    processTeamsMessages();
});

// Задача cron для отправки сводки ошибок раз в час
cron.schedule('0 * * * *', async () => {
    console.log('🕒 Проверка необходимости отправки сводки ошибок...');
    await sendErrorSummaryIfNeeded();
});

// Задача cron для сброса счётчика тем ошибок в 00:05 по Москве
cron.schedule('5 0 * * *', async () => {
    console.log('🧹 Запуск сброса processedErrorSubjects...');
    await resetProcessedErrorSubjects();
}, {
    timezone: "Europe/Moscow"
});

// Команда /start для запуска бота
bot.command('start', (ctx) => {
    ctx.reply('✅ Бот запущен. Обработка сообщений Teams включена.');
});

// Обработчик ошибок бота
bot.catch((err) => {
    console.error('❌ Ошибка бота:', err);
});

// Запуск бота
bot.start();
