// bot.js – Telegram ⇄ Teams bridge
// Версия: 2.1 — кнопка «Подробнее» теперь выгружает CSV‑отчёт за весь день;
// старый показ‑текста удалён. Логика hourly summary, дубли‑гвард, logging сохраняются.

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

/* ---------------------------------------------------------
   0)  Logger                                               
----------------------------------------------------------*/
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

/* ---------------------------------------------------------
   1)  Telegram bot                                         
----------------------------------------------------------*/
const bot = new Bot(process.env.BOT_API_KEY);

/* ---------------------------------------------------------
   2)  MSAL (Graph)                                         
----------------------------------------------------------*/
const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};

/* ---------------------------------------------------------
   3)  SQLite schemas                                       
----------------------------------------------------------*/
let db;
function initDatabase() {
  db = new sqlite3.Database(path.join(__dirname, 'summaries.db'), (err) => {
    if (err) return logger.error(`SQLite error: ${err}`);

    db.run(`CREATE TABLE IF NOT EXISTS error_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message_id TEXT,
      summary_text TEXT,
      created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      text_hash TEXT,
      created_at TEXT,
      UNIQUE(chat_id, text_hash)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS error_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      type TEXT,
      extracted_id TEXT,
      created_at TEXT
    )`);
  });
}
initDatabase();

/* ---------------------------------------------------------
   4)  Helpers                                              
----------------------------------------------------------*/
function todayStr() { return new Date().toISOString().slice(0, 10); }
function buildCsv(rows) {
  return ['hour,type,count', ...rows.map(r => `${r.hour},${r.type},${r.cnt}`)].join('\n');
}
async function generateCsvForDate(dateIso) {
  return new Promise((resolve) => {
    db.all(`SELECT strftime('%H', created_at, 'localtime') as hour, type, COUNT(*) as cnt
            FROM error_events
            WHERE date(created_at, 'localtime') = ?
            GROUP BY hour, type
            ORDER BY hour, type`, [dateIso], (err, rows) => {
      if (err) { logger.error(err); return resolve(null); }
      const dir = path.join(__dirname, 'reports');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = `errors_${dateIso}_${new Date().toISOString().slice(11,13)}00.csv`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, buildCsv(rows), 'utf8');
      resolve({ filePath, fileName });
    });
  });
}

/* duplicate‑send guard */
async function safeSendMessage(chatId, text, options = {}) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const dup = await new Promise(res => {
    db.get(`SELECT id FROM sent_messages WHERE chat_id=? AND text_hash=?`, [String(chatId), hash], (e,r)=>{ if(e){logger.error(e);return res(true);} res(!!r); });
  });
  if (dup) { logger.debug('[dup] skipped'); return null; }
  const msg = await bot.api.sendMessage(chatId, text, options);
  db.run(`INSERT OR IGNORE INTO sent_messages (chat_id,text_hash,created_at) VALUES(?,?,?)`, [String(chatId), hash, new Date().toISOString()]);
  return msg;
}

/* persistent state */
let lastProcessedMessageId = null;
const lastMessageIdFile = path.join(__dirname, 'lastMessageId.txt');
function loadLastId() { if (fs.existsSync(lastMessageIdFile)) lastProcessedMessageId = fs.readFileSync(lastMessageIdFile,'utf8').trim(); }
async function saveLastId(id){ await fs.promises.writeFile(lastMessageIdFile,id,'utf8'); }
loadLastId();
const processedErrorSubjects = new Set();
const processedFile = path.join(__dirname,'processedErrorSubjects.json');
if(fs.existsSync(processedFile)) JSON.parse(fs.readFileSync(processedFile,'utf8')).forEach(s=>processedErrorSubjects.add(s));
async function persistSubjects(){ await fs.promises.writeFile(processedFile,JSON.stringify([...processedErrorSubjects],null,2),'utf8'); }

/* ---------------------------------------------------------
   5)  Graph + Teams utils                                  
----------------------------------------------------------*/
async function getMicrosoftToken() {
  const cca = new ConfidentialClientApplication(msalConfig);
  try { return (await cca.acquireTokenByClientCredential({ scopes:['https://graph.microsoft.com/.default'] })).accessToken; }
  catch(e){ logger.error(e); return null; }
}
function extractTextContent(m){
  const text=(m.body?.content||'').replace(/<[^>]+>/g,'').trim();
  let sender='Неизвестно',subject='Без темы',isReply=false,body='';
  text.split('\n').forEach(line=>{ line=line.trim(); if(line.startsWith('Отправитель:')) sender=line.replace('Отправитель:','').trim();
  else if(line.startsWith('Тема:')){ subject=line.replace('Тема:','').trim(); if(/^RE:/i.test(subject)){isReply=true;subject=subject.replace(/^RE:/i,'').trim();}}
  else body+=(body?'\n':'')+line;});
  const isError= sender.toLowerCase()==='noreply@winline.kz' && /(ошибка|оповещение|ошибки|error|fail|exception|critical)/i.test(subject+' '+body);
  return {id:m.id,sender,subject,body,isReply,isError,createdDateTime:m.createdDateTime}; }
async function fetchTeamsMessages(token,teamId,channelId){
  try{ const url=`https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`; const res=await axios.get(url,{headers:{Authorization:`Bearer ${token}`}}); return res.data.value.map(extractTextContent);}catch(e){logger.error(e);return[];}}
function classifyError(msg){ const l=msg.body.toLowerCase(); if(msg.subject.includes('STOPAZART')) return {type:'STOPAZART',id:l.match(/id игрока[:\s]*([0-9]+)/i)?.[1]||'не найден'}; if(msg.subject.includes('SmartBridge')) return {type:'SmartBridge',id:l.match(/номер транзакции\s*([0-9]+)/i)?.[1]||'не найден'}; if(msg.subject.includes('реестре должников')) return {type:'Реестр должников',id:l.match(/id игрока[:\s]*([0-9]+)/i)?.[1]||'не найден'}; return{type:'Другое',id:'N/A'}; }

/* ---------------------------------------------------------
   6)  Summarisation prompt                                 
----------------------------------------------------------*/
async function summarizeMessages(messages,lastId){ if(!messages.length)return null; const list=messages.map(m=>{const r=m.isReply?'\nТип: Ответ (тема из контекста предыдущего сообщения)':'';return`ID: ${m.id}\nОтправитель: ${m.sender}\nТема: ${m.subject}${r}\nТекст сообщения: ${m.body}`}).join('\n\n'); const prompt=`(Последний обработанный ID: ${lastId})\n\nПроанализируй следующие сообщения из Teams...\n\n${list}`; try{ const res=await axios.post('https://api.openai.com/v1/chat/completions',{model:'gpt-4o-mini',messages:[{role:'user',content:prompt}],temperature:0,max_tokens:1000},{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},httpsAgent:new https.Agent({rejectUnauthorized:false})}); return res.data.choices[0]?.message?.content||'';}catch(e){logger.error(e);return null;} }

/* ---------------------------------------------------------
   7)  Runtime queues                                       
----------------------------------------------------------*/
const collectedErrors=[];
function logErrorEvent(msg){ db.run(`INSERT INTO error_events(subject,type,extracted_id,created_at) VALUES(?,?,?,?)`,[msg.subject,msg.type,msg.extractedId,msg.createdDateTime]); }

/* ---------------------------------------------------------
   8)  Hourly summary (button 👉 CSV)                        
----------------------------------------------------------*/
async function sendErrorSummaryIfNeeded(){ if(!collectedErrors.length)return; const grouped={}; collectedErrors.forEach(e=>{ if(!grouped[e.subject]) grouped[e.subject]={cnt:0,last:e.createdDateTime}; grouped[e.subject].cnt++; grouped[e.subject].last=e.createdDateTime;}); let txt='🔍 *Сводка ошибок за последний час:*\n'; for(const[s,d] of Object.entries(grouped)){ txt+=`📌 *${s}* — ${d.cnt}\n`; }
  const msg=await safeSendMessage(process.env.TELEGRAM_CHAT_ID,txt,{parse_mode:'Markdown',reply_markup:new InlineKeyboard().text('📥 CSV за день', 'csv_today')});
  if(msg) db.run(`INSERT INTO error_summaries(chat_id,message_id,summary_text,created_at) VALUES(?,?,?,?)`,[String(msg.chat.id),String(msg.message_id),txt,new Date().toISOString()]);
  collectedErrors.length=0;
}

/* ---------------------------------------------------------
   9)  CSV callback                                         
----------------------------------------------------------*/
bot.on('callback_query:data',async ctx=>{
  const data=ctx.callbackQuery.data;
  if(!data.startsWith('csv')) return ctx.answerCallbackQuery({text:'🤔 Неизвестная команда',show_alert:true});
  await ctx.answerCallbackQuery();
  const dateIso = todayStr();
  const res = await generateCsvForDate(dateIso);
  if(!res){ await ctx.reply('Не удалось сформировать CSV'); return; }
  await bot.api.sendDocument(ctx.chat.id, new InputFile(fs.createReadStream(res.filePath), res.fileName), { caption: `📊 CSV‑отчёт за ${dateIso}` });
});

/* ---------------------------------------------------------
   10)  Main processing loop                                
----------------------------------------------------------*/
async function processTeamsMessages(){ const token=await getMicrosoftToken(); if(!token)return; const msgs=await fetchTeamsMessages(token,process.env.TEAM_ID,process.env.CHANNEL_ID); if(!msgs.length)return; const newMsgs=msgs.filter(m=>!lastProcessedMessageId||m.id>lastProcessedMessageId); if(!newMsgs.length)return; lastProcessedMessageId=newMsgs[newMsgs.length-1].id; await saveLastId(lastProcessedMessageId);
  const errors=newMsgs.filter(m=>m.isError); const ordinary=newMsgs.filter(m=>!m.isError);
  for(const m of errors){ const {type,id}=classifyError(m); m.type=type; m.extractedId=id; logErrorEvent(m); if(!processedErrorSubjects.has(m.subject)){ await safeSendMessage(process.env.TELEGRAM_CHAT_ID,`❗ *Новая ошибка:* ${m.subject}`,{parse_mode:'Markdown'}); processedErrorSubjects.add(m.subject); await persistSubjects(); } else { collectedErrors.push(m);} }
  if(ordinary.length){ const sum=await summarizeMessages(ordinary,lastProcessedMessageId); if(sum) await safeSendMessage(process.env.TELEGRAM_CHAT_ID,`📝 *Суммаризация сообщений:*\n\n${sum}`,{parse_mode:'Markdown'}); }
}

/* ---------------------------------------------------------
   11)  Cron tasks                                          
----------------------------------------------------------*/
cron.schedule('* * * * *',()=>processTeamsMessages());
cron.schedule('0 * * * *',()=>sendErrorSummaryIfNeeded());
cron.schedule('0 * * * *',async()=>{ const {filePath,fileName}=await generateCsvForDate(todayStr()); if(filePath) await bot.api.sendDocument(process.env.TELEGRAM_CHAT_ID,new InputFile(fs.createReadStream(filePath),fileName),{caption:`📊 Авто‑CSV за ${todayStr()}`});});

/* ---------------------------------------------------------
   12)  Commands                                            
----------------------------------------------------------*/
bot.command('start',ctx=>ctx.reply('✅ Бот активен.'));

bot.catch(e=>logger.error(e));
bot.start();
logger.info('Bot started – v2.1');
