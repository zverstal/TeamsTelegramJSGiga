# README: Telegram-бот для интеграции с Microsoft Teams

Этот проект представляет собой Telegram-бота, который интегрируется с Microsoft Teams и выполняет функции отправки уведомлений об ошибках и суммаризации сообщений. Бот взаимодействует с Microsoft Graph API и GigaChat API для расширенного функционала.

---

## Возможности
- Получение сообщений из канала Microsoft Teams.
- Отправка уведомлений об ошибках в Telegram-чат.
- Суммаризация обычных сообщений и отправка их в Telegram.
- Периодическая отправка сводок ошибок.
- Запланированные задачи (cron):
  - Обработка сообщений каждые 2 минуты.
  - Отправка сводок ошибок каждый час.
  - Сброс счётчиков ошибок ежедневно в полночь.

---

## Установка

### Требования
1. **Операционная система**: Linux.
2. **Node.js и npm**: Убедитесь, что установлены Node.js (v14 или новее) и npm.
   ```bash
   sudo apt update
   sudo apt install -y nodejs npm
   ```
3. **Установка сертификатов**:
   Если вы находитесь в России, вам может потребоваться установить доверенные сертификаты для безопасного доступа к некоторым API. Подробности смотрите в разделе "Установка сертификатов".

---

### Инструкция по установке
1. **Клонирование репозитория**:
   ```bash
   git clone https://github.com/your-username/your-repo-name.git
   cd your-repo-name
   ```

2. **Создание файла переменных окружения**:
   В корне проекта создайте файл `.env` и заполните его следующими данными:
   ```
   BOT_API_KEY=ваш-ключ-telegram-бота
   TELEGRAM_CHAT_ID=id-вашего-telegram-чата
   AZURE_CLIENT_ID=id-клиента-azure
   AZURE_TENANT_ID=id-арендатора-azure
   AZURE_CLIENT_SECRET=секрет-клиента-azure
   TEAM_ID=id-команды-microsoft-teams
   CHANNEL_ID=id-канала-microsoft-teams
   GIGACHAT_API_KEY=ваш-api-ключ-gigachat
   ```

3. **Установка зависимостей**:
   Выполните команду:
   ```bash
   npm install
   ```

4. **Установка прав доступа**:
   Убедитесь, что бот может читать и записывать файлы для хранения состояния:
   ```bash
   chmod 644 lastMessageId.txt processedErrorSubjects.json
   ```

5. **Запуск бота**:
   Запустите бота командой:
   ```bash
   node index.js
   ```

---

## Установка сертификатов (Linux)
Для корректного подключения к API может потребоваться установка корневых и выпускающих сертификатов.

1. **Скачивание сертификатов**:
   Зайдите на портал Госуслуг и скачайте корневой и выпускающий сертификаты для Linux в формате `.crt`. Если сертификаты скачаны в формате `.pem`, конвертируйте их:
   ```bash
   openssl x509 -outform der -in russiantrustedca.pem -out russiantrustedca.crt
   ```

2. **Создание папки для сертификатов**:
   ```bash
   sudo mkdir /usr/local/share/ca-certificates/russian-trusted
   ```

3. **Копирование сертификатов**:
   ```bash
   sudo cp russian_trusted_root_ca_pem.crt russian_trusted_sub_ca_pem.crt /usr/local/share/ca-certificates/russian-trusted
   ```

4. **Обновление хранилища сертификатов**:
   ```bash
   sudo update-ca-certificates -v
   ```

5. **Проверка установки**:
   Убедитесь, что сертификаты успешно установлены:
   ```bash
   trust list | grep Russian
   ```

   В случае успеха вы должны увидеть что-то вроде:
   ```
   label: Russian Trusted Root CA
   label: Russian Trusted Sub CA
   ```

Теперь ваш бот готов к использованию!
