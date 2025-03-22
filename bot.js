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
const collectedErrors = [];             // Сбор ошибок для последующей сводки
const processedErrorSubjects = new Set(); // Сохранение тем ошибок (чтобы не дублировать уведомления)

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
 * Получение токена GigaChat (для суммаризации)
 */
async function getGigaChatToken() {
    const data = new URLSearchParams({ 'scope': 'GIGACHAT_API_PERS' });
    const config = {
        method: 'post',
        url: 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
        headers: {
            'RqUID': '6f0b1291-c7f3-43c6-bb2e-9f3efb2dc98e',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${process.env.GIGACHAT_API_KEY}`,
        },
        data: data,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    };

    try {
        const response = await axios.request(config);
        console.log('🔑 GigaChat токен получен.');
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Ошибка получения GigaChat токена:', error.message);
        return null;
    }
}

/**
 * Пример (опционально) — «склейка» сообщений, 
 * если у вас действительно бывают ситуации, 
 * когда одно сообщение в Teams приходит под разными ID.
 * Раскомментируйте, если нужно.
 */
// function unifyMessages(messages, timeWindowMinutes = 3) {
//     const unified = [];
//     let current = null;

//     // Сортируем по времени
//     const sorted = [...messages].sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));

//     for (const msg of sorted) {
//         if (current) {
//             const sameSender = (current.sender === msg.sender);
//             const sameSubject = (current.subject === msg.subject);
//             const timeDiff = Math.abs(new Date(msg.createdDateTime) - new Date(current.createdDateTime));
//             const withinTimeWindow = timeDiff < timeWindowMinutes * 60_000;

//             if (sameSender && sameSubject && withinTimeWindow) {
//                 current.body += `\n\n---\n\n${msg.body}`;
//                 console.log(`🔗 Склеили сообщение ID=${msg.id} c ID=${current.id}`);
//             } else {
//                 unified.push(current);
//                 current = { ...msg };
//             }
//         } else {
//             current = { ...msg };
//         }
//     }
//     if (current) unified.push(current);
//     return unified;
// }

/**
 * Извлекает информацию из одного сообщения. 
 * Считаем, что Teams уже возвращает 1 сообщение = 1 ID.
 */
function extractTextContent(message) {
    // Убираем HTML-теги
    const rawText = message.body?.content || '';
    const text = rawText.replace(/<\/?[^>]+(>|$)/g, '').trim();

    let sender = 'Неизвестно';
    let subject = 'Без темы';

    // Разделяем на строки, чтобы при желании найти "Отправитель:" / "Тема:"
    const lines = text.split('\n').map(line => line.trim());
    let body = '';

    for (const line of lines) {
        if (line.startsWith('Отправитель:')) {
            sender = line.replace(/^Отправитель:\s*/i, '').trim();
        } else if (line.startsWith('Тема:')) {
            subject = line.replace(/^Тема:\s*/i, '').trim();
        } else {
            body += (body ? '\n' : '') + line;
        }
    }

    // Если же в Teams API есть message.from / message.subject, можно брать напрямую:
    // sender = message.from?.emailAddress?.address || 'Неизвестно';
    // subject = message.subject || 'Без темы';

    // Логика определения «ошибки»
    const errorKeywords = /ошибка|оповещение|failed|error|ошибки|exception|critical/i;
    const isError =
        sender.toLowerCase() === 'noreply@winline.kz' &&
        (errorKeywords.test(subject) || errorKeywords.test(body));

    return {
        id: message.id,
        sender,
        subject,
        body,
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
 * Суммаризация сообщений через GigaChat.
 * Передаём в промт ID каждого сообщения (и добавляем lastProcessedMessageId).
 */
async function summarizeMessages(messages, token, lastMsgId) {
    try {
        // Формируем список самих сообщений
        const messageList = messages.map((msg) => {
            return `ID: ${msg.id}\nОтправитель: ${msg.sender}\nТема: ${msg.subject}\nТекст сообщения: ${msg.body}`;
        }).join('\n\n');

        const improvedPrompt = `
        (Последний обработанный ID: ${lastMsgId})
        
        Привет! Посмотри на приведённые ниже сообщения из Teams. Твоя задача — для каждого сообщения, определённого по его ID, составить краткое, понятное и дружелюбное резюме, сохраняя при этом все важные технические детали.
        
        Для каждого сообщения укажи:
        1. Отправитель: постарайся определить имя, должность и компанию, если это возможно (например, по подписи или email). Если подробностей нет — укажи email.
        2. Тема: перефразируй тему сообщения простыми словами.
        3. Содержание: опиши основное содержание письма в одном-двух предложениях, отметив важные технические детали, такие как ID, время или коды ошибок. Если сообщение является ответом (с индикатором "RE"), упомяни, что оно связано с предыдущим сообщением.
        
        Пожалуйста, составь резюме для каждого сообщения отдельно, не объединяя их, и игнорируй вложения или внешние данные.
        
        Пример ответа:
        - [ID: 12345]
          Отправитель: Иван Иванов (i.ivanov@company.com), DevOps Engineer, CompanyName.
          Тема: Проблема при деплое
          Содержание: Сообщение описывает возникшую ошибку во время деплоя, с указанием кода ошибки и времени возникновения. Является ответом на предыдущее сообщение.
        
        Составь резюме для следующих сообщений:
        
        ${messageList}
        `.trim();
        

        const requestData = {
            model: 'GigaChat:latest',
            temperature: 0.80,
            n: 1,
            max_tokens: 1000,
            repetition_penalty: 1.07,
            stream: false,
            messages: [
                {
                    role: 'user',
                    content: improvedPrompt,
                },
            ],
        };

        const response = await axios.post(
            'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
            requestData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            }
        );

        console.log('📝 Суммаризация сообщений завершена.');
        return response.data.choices[0]?.message?.content || 'Нет ответа от GigaChat.';
    } catch (err) {
        console.error('❌ Ошибка при суммаризации сообщений:', err.message);
        return 'Не удалось получить резюме сообщений.';
    }
}

/**
 * Отправка сводки ошибок раз в час (или при нужном интервале).
 */
async function sendErrorSummaryIfNeeded() {
    if (collectedErrors.length === 0) {
        console.log('📭 Нет новых ошибок для сводки.');
        return; // Нет новых ошибок для сводки
    }

    // Формируем сводку
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

    // Отправляем сводку
    try {
        await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, { parse_mode: 'Markdown' });
        console.log('📤 Сводка ошибок отправлена в Telegram.');
        collectedErrors.length = 0; // Очистить собранные ошибки после отправки
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

    const gigachatToken = await getGigaChatToken();
    if (!gigachatToken) {
        console.error('❌ Не удалось получить токен GigaChat.');
        // Можно продолжить работу без суммаризации
    }

    const teamId = process.env.TEAM_ID;
    const channelId = process.env.CHANNEL_ID;

    const messages = await fetchTeamsMessages(msToken, teamId, channelId);
    if (messages.length === 0) {
        console.log('📭 Нет новых сообщений для обработки.');
        return;
    }

    // Фильтрация новых сообщений по ID
    const newMessages = messages.filter(msg => {
        if (!lastProcessedMessageId) return true;
        return msg.id > lastProcessedMessageId;
    });

    if (newMessages.length === 0) {
        console.log('📭 Нет новых сообщений с момента последней проверки.');
        return;
    }

    // Обновляем lastProcessedMessageId
    lastProcessedMessageId = newMessages[newMessages.length - 1].id;
    await saveLastProcessedMessageId(lastProcessedMessageId);

    // (Опционально) "Склеиваем" сообщения, если нужно:
    // const unifiedMessages = unifyMessages(newMessages); 
    // const errors = unifiedMessages.filter(msg => msg.isError);
    // const normalMessages = unifiedMessages.filter(msg => !msg.isError);

    // Без склейки:
    const errors = newMessages.filter(msg => msg.isError);
    const normalMessages = newMessages.filter(msg => !msg.isError);

    // Обработка ошибок
    if (errors.length > 0) {
        for (const errorMsg of errors) {
            const errorSubject = errorMsg.subject;

            // Проверяем, не отправляли ли мы уже эту тему
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
                // Если тема уже встречалась, добавляем её в сводку
                collectedErrors.push(errorMsg);
                console.log(`📥 Ошибка с темой "${errorSubject}" добавлена в сводку.`);
            }
        }
    }

    // Обработка "нормальных" сообщений (суммаризация)
    if (normalMessages.length > 0 && gigachatToken) {
        const summary = await summarizeMessages(normalMessages, gigachatToken, lastProcessedMessageId);
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

// Запускаем задачу cron для обработки каждую минуту
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
