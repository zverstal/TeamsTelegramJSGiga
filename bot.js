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
let lastProcessedMessageId = null;
const collectedErrors = []; // Для хранения ошибок для сводки
const processedErrorSubjects = new Set(); // Для хранения уникальных тем ошибок

// Пути к файлам состояния
const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
const processedSubjectsFile = path.join(__dirname, 'processedErrorSubjects.json');

// Функция для сохранения lastProcessedMessageId в файл (постоянное хранение)
async function saveLastProcessedMessageId(id) {
    try {
        await fs.promises.writeFile(lastMessageIdFile, id, 'utf8');
        console.log(`✅ Сохранен последний ID сообщения: ${id}`);
    } catch (error) {
        console.error('❌ Ошибка при сохранении lastMessageId.txt:', error);
    }
}

// Функция для загрузки lastProcessedMessageId из файла при старте
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

// Функция для загрузки processedErrorSubjects из JSON-файла при старте
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

// Функция для получения токена Microsoft Graph
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

// Функция для получения токена GigaChat (оставим только для суммаризации нормальных сообщений)
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

// ✅ Обновленная функция для извлечения данных из текстового сообщения
function extractTextContent(message) {
    const text = message.body?.content || '';
    const lines = text.split('\n');

    let sender = 'Неизвестно';
    let subject = 'Без темы';
    let body = '';

    let isBody = false;

    for (let line of lines) {
        line = line.trim();

        if (line.startsWith('Отправитель:')) {
            sender = line.replace(/Отправитель:/i, '').trim();
        } else if (line.startsWith('Тема:')) {
            subject = line.replace(/Тема:/i, '').trim();
        } else if (line.startsWith('Текст сообщения:')) {
            isBody = true;
            // Начало тела сообщения, пропускаем эту строку
            continue;
        }

        if (isBody) {
            // Прекращаем добавление к телу, если достигли подписи или другого раздела
            if (/^\w+\/\w+/.test(line)) { // Например: Дмитрий Селиванов/Dmitry Selivanov
                break;
            }
            body += line + '\n';
        }
    }

    body = body.trim();

    // ✅ Обновленная проверка ошибки: только от отправителя noreply@winline.kz
    const isError = sender.toLowerCase() === 'noreply@winline.kz';
    if (isError) {
        console.log('⚠️ Выявлено сообщение об ошибке от noreply@winline.kz.');
    }

    // Лог извлечённой информации
    console.log(`🗣️ Отправитель: ${sender}`);
    console.log(`📌 Тема: ${subject}`);
    console.log(`📩 Текст сообщения:\n${body}`);

    // Возвращаем структуру данных с нужными полями
    return {
        id: message.id,
        sender,
        subject,
        body,
        isError,
        createdDateTime: message.createdDateTime,
    };
}

// Функция для чтения сообщений из канала Microsoft Teams
async function fetchTeamsMessages(token, teamId, channelId) {
    const url = `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;

    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        console.log(`📥 Найдено ${response.data.value.length} сообщений в канале.`);
        return response.data.value
            .map((msg) => extractTextContent(msg)) // Используем обновлённую функцию
            .sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
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

// Функция для суммаризации нормальных сообщений через GigaChat
async function summarizeMessages(messages, token) {
    try {
        const formattedMessages = messages.map(({ sender, subject, body }) => {
            return `Отправитель: ${sender}\nТема: ${subject}\nСообщение: ${body}`;
        });

        const requestData = {
            model: "GigaChat:latest",
            temperature: 0.7,
            n: 1,
            max_tokens: 512,
            repetition_penalty: 1.05,
            stream: false,
            messages: [
                {
                    role: 'user',
                    content: `Проанализируй следующие сообщения и дай краткое резюме для каждого сообщения в одном предложении. Определи отправителя по подписи и @, укажи его, определи компанию. Игнорируй вложения и технические детали:\n\n${formattedMessages.join('\n\n')}`
                }
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

// Функция для отправки сводки ошибок раз в час
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

    // Отправляем сводку в Telegram
    try {
        await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, summary, { parse_mode: 'Markdown' });
        console.log('📤 Сводка ошибок отправлена в Telegram.');
        collectedErrors.length = 0; // Очистить собранные ошибки после отправки
    } catch (err) {
        console.error('❌ Ошибка при отправке сводки ошибок в Telegram:', err.message);
    }
}

// Основная функция для обработки сообщений из заданного канала
async function processTeamsMessages() {
    const msToken = await getMicrosoftToken();
    if (!msToken) {
        console.error('❌ Не удалось получить токен Microsoft.');
        return;
    }

    // Получаем токен GigaChat только для суммаризации нормальных сообщений
    const gigachatToken = await getGigaChatToken();
    if (!gigachatToken) {
        console.error('❌ Не удалось получить токен GigaChat.');
        // Решение: можно продолжить обработку ошибок без GigaChat
    }

    const teamId = process.env.TEAM_ID;
    const channelId = process.env.CHANNEL_ID;

    const messages = await fetchTeamsMessages(msToken, teamId, channelId);
    if (messages.length === 0) {
        console.log('📭 Нет новых сообщений для обработки.');
        return;
    }

    // Фильтрация только новых сообщений
    const newMessages = messages.filter(msg => {
        if (!lastProcessedMessageId) return true;
        return msg.id > lastProcessedMessageId;
    });

    if (newMessages.length === 0) {
        console.log('📭 Нет новых сообщений с момента последней проверки.');
        return;
    }

    // Обновление lastProcessedMessageId до ID последнего сообщения
    lastProcessedMessageId = newMessages[newMessages.length - 1].id;
    await saveLastProcessedMessageId(lastProcessedMessageId); // Сохранение ID

    // Разделение сообщений на ошибки и нормальные
    const errors = newMessages.filter(msg => msg.isError);
    const normalMessages = newMessages.filter(msg => !msg.isError);

    // Обработка ошибок
    if (errors.length > 0) {
        for (const errorMsg of errors) {
            const errorSubject = errorMsg.subject;

            // Если тема ошибки не была отправлена ранее, отправляем её и добавляем в Set
            if (!processedErrorSubjects.has(errorSubject)) {
                // Формируем сообщение для Telegram
                const errorMessage = `❗ *Новая ошибка обнаружена:*\n\n📌 *Тема:* ${errorMsg.subject}\n🗣️ *Отправитель:* ${errorMsg.sender}\n📩 *Текст сообщения:*\n${errorMsg.body}`;

                try {
                    await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, errorMessage, { parse_mode: 'Markdown' });
                    console.log('📤 Ошибка отправлена в Telegram.');

                    // Добавляем тему в Set и сохраняем состояние
                    processedErrorSubjects.add(errorSubject);
                    await saveProcessedErrorSubjects();
                } catch (err) {
                    console.error('❌ Ошибка при отправке сообщения об ошибке в Telegram:', err.message);
                }
            } else {
                // Если тема уже встречалась, добавляем ошибку в сводку
                collectedErrors.push(errorMsg);
                console.log(`📥 Ошибка с темой "${errorSubject}" добавлена в сводку.`);
            }
        }
    }

    // Обработка нормальных сообщений
    if (normalMessages.length > 0 && gigachatToken) { // Проверяем наличие токена GigaChat
        const summary = await summarizeMessages(normalMessages, gigachatToken);
        if (summary) {
            await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, `📝 *Суммаризация сообщений:*\n\n${summary}`, { parse_mode: 'Markdown' });
            console.log('📤 Суммаризация сообщений отправлена в Telegram.');
        }
    }
}

// Задача cron для обработки сообщений каждые 2 минуты
cron.schedule('*/2 * * * *', () => { // Изменено расписание на каждые 2 минуты
    console.log('🔄 Запуск обработки сообщений Teams...');
    processTeamsMessages();
});

// Задача cron для отправки сводки ошибок раз в час
cron.schedule('0 * * * *', async () => {
    console.log('🕒 Проверка необходимости отправки сводки ошибок...');
    await sendErrorSummaryIfNeeded();
});

// Задача cron для сброса счётчика тем ошибок в 00:05 по московскому времени
cron.schedule('5 0 * * *', async () => {
    console.log('🧹 Запуск сброса processedErrorSubjects...');
    await resetProcessedErrorSubjects();
}, {
    timezone: "Europe/Moscow" // Указываем часовой пояс явно
});

// Команда /start для запуска бота
bot.command('start', (ctx) => {
    ctx.reply('✅ Бот запущен. Обработка сообщений Teams включена.');
});

// Обработчик ошибок
bot.catch((err) => {
    console.error('❌ Ошибка бота:', err);
});

// Запуск бота
bot.start();
