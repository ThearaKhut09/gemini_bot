import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import axios from 'axios';
import express from 'express';
import multer from 'multer';
import { Telegraf } from 'telegraf';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env explicitly
dotenv.config({ path: path.join(__dirname, '.env') });

const {
  BOT_TOKEN,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  AI_PROVIDER = 'auto', // 'openai' | 'gemini' | 'auto'
  IT_GROUP_ID,
  MONITORED_GROUP_ID,
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in environment variables!');
  process.exit(1);
}

if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
  console.error('❌ Missing both OPENAI_API_KEY and GEMINI_API_KEY! Please provide at least one.');
  process.exit(1);
}

if (!IT_GROUP_ID) {
  console.warn('⚠️ Warning: IT_GROUP_ID is not configured. Alerts will only be logged to console.');
}

// ==========================================
// 2. Initialize Clients
// ==========================================
const bot = new Telegraf(BOT_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

console.log(`🤖 AI Engine Initialized: Provider mode = [${AI_PROVIDER.toUpperCase()}]`);
if (openai) console.log('✅ OpenAI Client ready');
if (genAI) console.log('✅ Google Gemini Client ready');

// ==========================================
// 3. Lightweight Health Check Web Server
// ==========================================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Telegram IT Support Bot (Hybrid OpenAI & Gemini)',
    activeProvider: AI_PROVIDER,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// ==========================================
// 3.5 Telegram Mini App (report an issue without typing in the group)
// ==========================================
const MINIAPP_URL = process.env.MINIAPP_URL || '';
// t.me deep link from BotFather /newapp (e.g. https://t.me/mybot/itsupport).
// Used for the app button in groups, where Telegram rejects web_app buttons.
const MINIAPP_TG_LINK = process.env.MINIAPP_TG_LINK || '';

function miniAppButtonRow(chat) {
  if (!MINIAPP_URL) return null;
  // Telegram only accepts web_app inline buttons in private chats
  if (chat.type === 'private') {
    return [{ text: '📱 បើកកម្មវិធី (Open App)', web_app: { url: MINIAPP_URL } }];
  }
  return MINIAPP_TG_LINK ? [{ text: '🛠️ Open IT App', url: MINIAPP_TG_LINK }] : null;
}
const TICKETS_FILE = path.join(__dirname, 'data', 'tickets.json');
const APP_PINS_FILE = path.join(__dirname, 'data', 'appPins.json');
fs.mkdirSync(path.dirname(TICKETS_FILE), { recursive: true });

app.use('/app', express.static(path.join(__dirname, 'miniapp')));

function validateInitData(initData, botToken, maxAgeSec = 86400) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  if (crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex') !== hash) return null;

  const authAge = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (authAge > maxAgeSec) return null;

  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

function resolveMiniAppUser(initData) {
  // Dev only: lets the form be tested in a plain browser. Blocked when NODE_ENV=production.
  if (initData === 'DEV_FAKE_USER' && process.env.MINIAPP_DEV_MODE === '1' && process.env.NODE_ENV !== 'production') {
    return { id: 900000001, first_name: 'Dev', last_name: 'Tester', username: 'dev_tester' };
  }
  return validateInitData(initData, BOT_TOKEN);
}

app.use('/api', (req, res, next) => {
  const user = resolveMiniAppUser(req.get('X-Init-Data') || '');
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.tgUser = user;
  next();
});

function loadTickets() {
  try {
    return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTickets(tickets) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

function loadAppPins() {
  try {
    return JSON.parse(fs.readFileSync(APP_PINS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAppPins(pins) {
  fs.writeFileSync(APP_PINS_FILE, JSON.stringify(pins, null, 2));
}

// Keeps one pinned app message per group: a new /app unpins the previous one
// instead of stacking pins and "pinned a message" service notices.
async function pinAppMessage(ctx, sent) {
  if (ctx.chat.type === 'private' || !sent) return;

  const pins = loadAppPins();
  const storedMessageId = pins[ctx.chat.id];

  if (storedMessageId) {
    // If our previous app message is still the pinned one, keep it — no need
    // to unpin/repin (and generate service notices) on every /app.
    const stillPinned = await ctx.getChat().then(function (info) {
      return !!(info && info.pinned_message && info.pinned_message.message_id === storedMessageId);
    }).catch(function () { return false; });
    if (stillPinned) return;
    // may fail if it was already unpinned or deleted — that's fine
    await ctx.unpinChatMessage(storedMessageId).catch(() => { });
  }

  await ctx.pinChatMessage(sent.message_id, { disable_notification: true }).catch(() => { });
  pins[ctx.chat.id] = sent.message_id;
  saveAppPins(pins);
}

const miniAppUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `miniapp_${Date.now()}_${Math.random().toString(36).slice(2)}${(path.extname(file.originalname || '') || '.jpg').toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype) || /^audio\//.test(file.mimetype))
});

app.post('/api/tickets', miniAppUpload.fields([
  { name: 'photos', maxCount: 4 },
  { name: 'voices', maxCount: 3 }
]), async (req, res) => {
  const issue = (req.body.issue || '').trim().slice(0, 3000);
  const urgencyInput = ['Low', 'Medium', 'High'].includes(req.body.urgency) ? req.body.urgency : 'Medium';
  const photoPaths = ((req.files && req.files.photos) || []).map(f => f.path);
  const voicePaths = ((req.files && req.files.voices) || []).map(f => f.path);

  if (!issue && !voicePaths.length) {
    photoPaths.forEach(p => fs.promises.unlink(p).catch(() => { }));
    voicePaths.forEach(p => fs.promises.unlink(p).catch(() => { }));
    return res.status(400).json({ ok: false, error: 'Issue text or voice recording is required' });
  }

  const { fullName, username, id: userId } = formatUserInfo(req.tgUser);
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Phnom_Penh',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });

  let transcriptions = [];
  let voiceLanguage = null;
  if (voicePaths.length) {
    try {
      const analysis = await analyzeMiniAppVoices(voicePaths);
      transcriptions = (analysis.transcriptions || []).map(t => String(t || '').trim()).filter(Boolean);
      voiceLanguage = analysis.language || null;
    } catch (err) {
      console.error('❌ Mini App voice transcription failed:', err.message || err);
    }
  }

  const ticketId = `MA-${Date.now().toString(36).toUpperCase()}`;
  const department = (req.body.department || '').trim() || 'General';

  let alertMessage = `🚨 <b>NEW IT SUPPORT TICKET (Mini App)</b>\n`;
  alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
  alertMessage += `🎫 <b>Ticket ID:</b> <code>${ticketId}</code>\n`;
  alertMessage += `👤 <b>Reporter:</b> ${escapeHtml(fullName)} (${escapeHtml(username)})\n`;
  alertMessage += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
  alertMessage += `🏢 <b>Department:</b> <b>${escapeHtml(department)}</b>\n`;
  alertMessage += `📱 <b>Source:</b> Telegram Mini App\n`;
  alertMessage += `${urgencyInput === 'High' ? '🔴' : urgencyInput === 'Medium' ? '🟡' : '🟢'} <b>Urgency:</b> <b>${urgencyInput}</b>\n`;
  alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
  alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
  if (issue) {
    alertMessage += `📌 <b>Issue:</b>\n${escapeHtml(issue)}\n`;
  }
  if (transcriptions.length) {
    if (voiceLanguage) {
      alertMessage += `🗣️ <b>Spoken Language:</b> ${escapeHtml(voiceLanguage)}\n`;
    }
    alertMessage += `🎙️ <b>${transcriptions.length > 1 ? 'Voice Transcriptions' : 'Voice Transcription'}:</b>\n`;
    transcriptions.forEach(function (t, i) {
      alertMessage += `<i>${i + 1}. ${escapeHtml(t)}</i>\n`;
    });
  }
  alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

  let sentMessage = null;
  try {
    sentMessage = await sendToITGroup(alertMessage, photoPaths, ticketActionKeyboard(ticketId, 'open'));
  } catch (err) {
    console.error('❌ Mini App ticket delivery failed:', err.message || err);
    photoPaths.forEach(p => fs.promises.unlink(p).catch(() => { }));
    voicePaths.forEach(p => fs.promises.unlink(p).catch(() => { }));
    return res.status(502).json({ ok: false, error: 'Could not deliver ticket to IT' });
  }

  // Deliver the original clips so IT can also listen to how the issue was described
  for (let i = 0; i < voicePaths.length; i++) {
    try {
      const caption = i === 0 ? '🎙️ Original voice clip(s) from the Mini App ticket' : undefined;
      if (voicePaths[i].endsWith('.ogg')) {
        await bot.telegram.sendVoice(IT_GROUP_ID, { source: voicePaths[i] }, { caption });
      } else {
        await bot.telegram.sendAudio(IT_GROUP_ID, { source: voicePaths[i] }, { caption, title: 'Voice clip ' + (i + 1) });
      }
    } catch (e) {
      console.warn('Could not send mini app voice clip:', e.message);
    }
  }

  photoPaths.forEach(p => fs.promises.unlink(p).catch(() => { }));
  voicePaths.forEach(p => fs.promises.unlink(p).catch(() => { }));

  const tickets = loadTickets();
  const ticket = {
    id: ticketId,
    source: 'miniapp',
    status: 'open',
    department,
    userId,
    fullName,
    username,
    issue,
    urgency: urgencyInput,
    photos: photoPaths.length,
    voices: voicePaths.length,
    transcriptions,
    rawAlertText: alertMessage,
    itMessageId: sentMessage ? sentMessage.message_id : null,
    itChatId: sentMessage ? sentMessage.chat.id : null,
    handledBy: null,
    closedAt: null,
    closedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  tickets.push(ticket);
  saveTickets(tickets);

  console.log(`🚀 Mini App ticket ${ticket.id} (${department}) from [${fullName}] forwarded to IT Group`);
  res.json({ ok: true, id: ticket.id });
});

app.get('/api/tickets', (req, res) => {
  const userTickets = loadTickets()
    .filter(t => t.userId === req.tgUser.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(t => ({
      id: t.id,
      issue: t.issue || (t.transcriptions && t.transcriptions[0]) || 'IT Support Ticket',
      urgency: t.urgency || 'Medium',
      department: t.department || 'General',
      status: t.status || 'open',
      handledBy: t.handledBy || null,
      photos: t.photos || 0,
      voices: t.voices || 0,
      urgencyEmoji: t.urgency === 'High' ? '🔴' : t.urgency === 'Medium' ? '🟡' : '🟢',
      timeText: new Date(t.createdAt).toLocaleString('en-US', {
        timeZone: 'Asia/Phnom_Penh',
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    }));
  res.json({ ok: true, tickets: userTickets });
});

const server = app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// ==========================================
// 4. Utility Functions & Storage
// ==========================================

const reportSessions = new Map();
const BUFFER_WINDOW_MS = 8000; // 8-second bundling window

function formatUserInfo(user) {
  const nameParts = [user.first_name, user.last_name].filter(Boolean);
  const fullName = nameParts.join(' ') || 'Unknown User';
  const username = user.username ? `@${user.username}` : 'No username';
  return { fullName, username, id: user.id };
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getMessageLink(chat, messageId) {
  if (!messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const chatIdStr = chat.id.toString();
  if (chatIdStr.startsWith('-100')) {
    const cleanId = chatIdStr.replace('-100', '');
    return `https://t.me/c/${cleanId}/${messageId}`;
  }
  return null;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

async function downloadTelegramFile(fileUrl, fileExt) {
  const tempFilePath = path.join(os.tmpdir(), `tg_media_${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`);
  const writer = fs.createWriteStream(tempFilePath);

  const response = await axios({
    url: fileUrl,
    method: 'GET',
    responseType: 'stream',
    timeout: 30000
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    const cleanup = () => fs.unlink(tempFilePath, () => { });
    writer.on('finish', () => resolve(tempFilePath));
    writer.on('error', (err) => {
      cleanup();
      reject(err);
    });
    response.data.on('error', (err) => {
      cleanup();
      writer.destroy();
      reject(err);
    });
  });
}

function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType
    },
  };
}

async function setMessageReaction(chatId, messageId, emoji) {
  if (!chatId || !messageId) return;
  const reactionArray = emoji ? [{ type: 'emoji', emoji }] : [];
  try {
    if (typeof bot.telegram.setMessageReaction === 'function') {
      await bot.telegram.setMessageReaction(chatId, messageId, reactionArray);
    } else {
      await bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: reactionArray
      });
    }
    console.log(`👍 Set reaction [${emoji || 'cleared'}] on msg ${messageId} in chat ${chatId}`);
  } catch (err) {
    console.warn(`⚠️ Could not set reaction [${emoji || 'cleared'}] on msg ${messageId}:`, err.message);
  }
}

function ticketActionKeyboard(ticketId, status = 'open') {
  if (status === 'resolved' || status === 'rejected') {
    return {
      inline_keyboard: [
        [
          { text: '🔄 Re-open Ticket', callback_data: `tk_act:${ticketId}:open` }
        ]
      ]
    };
  }

  if (status === 'in_progress') {
    return {
      inline_keyboard: [
        [
          { text: '✅ Resolved', callback_data: `tk_act:${ticketId}:resolved` },
          { text: '❌ Reject', callback_data: `tk_act:${ticketId}:rejected` }
        ],
        [
          { text: '🔄 Re-open (Pending)', callback_data: `tk_act:${ticketId}:open` }
        ]
      ]
    };
  }

  // default 'open'
  return {
    inline_keyboard: [
      [
        { text: '🔧 In Progress', callback_data: `tk_act:${ticketId}:in_progress` },
        { text: '✅ Resolved', callback_data: `tk_act:${ticketId}:resolved` }
      ],
      [
        { text: '❌ Reject', callback_data: `tk_act:${ticketId}:rejected` }
      ]
    ]
  };
}

function formatTicketAlertWithStatus(rawAlertText, ticket) {
  // Strip previous status block if present
  let base = (rawAlertText || '').replace(/\n📊 <b>Status:<\/b>[\s\S]*$/, '').trimEnd();

  const statusConfig = {
    open: { emoji: '⏳', label: 'Open (Pending)' },
    in_progress: { emoji: '🔧', label: 'In Progress' },
    resolved: { emoji: '✅', label: 'Resolved' },
    rejected: { emoji: '❌', label: 'Rejected' }
  }[ticket.status] || { emoji: '⏳', label: 'Open' };

  const updateTime = new Date(ticket.updatedAt || ticket.createdAt).toLocaleString('en-US', {
    timeZone: 'Asia/Phnom_Penh',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  let statusBlock = `\n📊 <b>Status:</b> ${statusConfig.emoji} <b>${statusConfig.label}</b>`;
  if (ticket.handledBy) {
    statusBlock += `\n👨‍💻 <b>IT Staff:</b> ${escapeHtml(ticket.handledBy)}`;
  }
  statusBlock += `\n⏰ <b>Updated:</b> ${updateTime} (GMT+7)`;

  if (base.endsWith('━━━━━━━━━━━━━━━━━━━━━')) {
    return base + statusBlock + `\n━━━━━━━━━━━━━━━━━━━━━`;
  } else {
    return base + `\n━━━━━━━━━━━━━━━━━━━━━` + statusBlock + `\n━━━━━━━━━━━━━━━━━━━━━`;
  }
}

async function sendToITGroup(alertMessage, photos = [], replyMarkup = null) {
  if (!IT_GROUP_ID) return null;

  async function executeSend(targetId) {
    if (photos.length > 0) {
      try {
        if (photos.length === 1) {
          await bot.telegram.sendPhoto(targetId, { source: photos[0] }, {
            caption: '📸 Attached issue screenshot(s)'
          });
        } else {
          const mediaGroup = photos.map((filePath, idx) => ({
            type: 'photo',
            media: { source: filePath },
            caption: idx === 0 ? '📸 Attached issue screenshot(s)' : undefined
          }));
          await bot.telegram.sendMediaGroup(targetId, mediaGroup);
        }
      } catch (mediaErr) {
        console.warn('Could not send photo(s) to IT group:', mediaErr.message);
      }
    }

    return await bot.telegram.sendMessage(targetId, alertMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup || undefined
    });
  }

  try {
    const sent = await executeSend(IT_GROUP_ID);
    console.log(`🚀 Unified Ticket forwarded to IT Group (${IT_GROUP_ID})`);
    return sent;
  } catch (sendErr) {
    if (sendErr.response?.parameters?.migrate_to_chat_id) {
      const newChatId = sendErr.response.parameters.migrate_to_chat_id;
      console.log(`🔄 Group upgraded to Supergroup! Retrying with new ID: ${newChatId}`);
      const sent = await executeSend(newChatId);
      console.log(`🚀 Unified Ticket sent to new Supergroup ID (${newChatId})`);
      return sent;
    } else {
      throw sendErr;
    }
  }
}

// ==========================================
// 5. Dual Engine Processors (OpenAI & Gemini)
// ==========================================
const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'];

async function processWithOpenAI(items, downloadedFiles, photoPaths) {
  if (!openai) throw new Error('OpenAI client not configured (Missing OPENAI_API_KEY)');

  const voiceTranscriptions = [];

  // 1. Transcribe audio with Whisper
  for (const item of items.filter(i => i.type === 'voice')) {
    const fileLink = await bot.telegram.getFileLink(item.fileId);
    const tempPath = await downloadTelegramFile(fileLink.href, item.ext || 'ogg');
    downloadedFiles.push(tempPath);

    console.log(`🎙️ [OpenAI] Transcribing with Whisper...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'km',
      response_format: 'text',
      temperature: 0.2
    });

    const text = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
    if (text) voiceTranscriptions.push(text);
  }

  // 2. Download photos for Vision
  const imagePayloads = [];
  for (const item of items.filter(i => i.type === 'photo')) {
    const fileLink = await bot.telegram.getFileLink(item.fileId);
    const tempPath = await downloadTelegramFile(fileLink.href, 'jpg');
    downloadedFiles.push(tempPath);
    photoPaths.push(tempPath);

    const base64Image = fs.readFileSync(tempPath).toString('base64');
    imagePayloads.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64Image}` }
    });
  }

  const userTexts = items.filter(i => i.type === 'text').map(t => t.text).join('\n');
  const combinedTranscriptions = voiceTranscriptions.join('\n');

  // 3. Reason with GPT-4o-mini
  const promptText = `
You are an expert IT Support Engineer, incident triage specialist, and linguist.
Analyze the user's input:
- User Typed Text: "${userTexts || '(None)'}"
- Voice Transcriptions: "${combinedTranscriptions || '(None)'}"
- Attached Images: ${items.some(i => i.type === 'photo') ? 'See attached images' : 'No images'}

CRITICAL RULES:
1. Intent Classification:
   - Determine whether the user is actually describing a technical problem, error, issue, bug, request for help, or difficulty.
   - If the input is ONLY a casual greeting (e.g., "Hello", "Hi", "Good morning", "សួស្តី", "thanks", "ok", or small talk), set "is_problem": false. Do not assume every message is a problem.
   - Only set "is_problem": true when the user actually reports a technical issue or requests assistance.

2. Problem Processing (when is_problem is true):
   - Correct and rewrite any grammar mistakes, unclear wording, or poor sentence structure while preserving original meaning.
   - Separate unrelated greetings/conversation from the actual problem.
   - If the user explained across multiple messages/voice notes, combine the relevant information into one clear problem statement.
   - Detect primary language (Khmer or English).
   - Write ALL output fields in the SAME detected language (Khmer if Khmer, English if English).
   - Extract OCR text/error codes from photos if present.

Return ONLY a valid JSON object matching this schema without markdown code blocks:
{
  "is_problem": true | false,
  "language": "Khmer" | "English",
  "ocr_text": "Error codes / text found in photos or 'None'",
  "issue_summary": "1-2 sentence clear issue summary in the SAME detected language (Khmer if Khmer, English if English)",
  "urgency": "Low" | "Medium" | "High",
  "recommended_action": "Suggested troubleshooting step in the SAME language (Khmer if Khmer, English if English)",
  "casual_reply": "Short polite greeting reply if is_problem is false, otherwise empty"
}
`;

  console.log(`🤖 [OpenAI] Analyzing issue with GPT-4o Mini...`);
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: [{ type: 'text', text: promptText }, ...imagePayloads] }],
    response_format: { type: 'json_object' },
    temperature: 0.2
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  parsed.engineUsed = 'OpenAI (Whisper + GPT-4o Mini)';
  parsed.voice_transcriptions = voiceTranscriptions;
  return parsed;
}

async function processWithGemini(items, downloadedFiles, photoPaths) {
  if (!genAI) throw new Error('Gemini client not configured (Missing GEMINI_API_KEY)');

  const generativeParts = [];

  for (const item of items) {
    if (item.type === 'voice') {
      const fileLink = await bot.telegram.getFileLink(item.fileId);
      const tempPath = await downloadTelegramFile(fileLink.href, item.ext || 'ogg');
      downloadedFiles.push(tempPath);
      generativeParts.push(fileToGenerativePart(tempPath, item.mimeType || 'audio/ogg'));
    } else if (item.type === 'photo') {
      const fileLink = await bot.telegram.getFileLink(item.fileId);
      const tempPath = await downloadTelegramFile(fileLink.href, 'jpg');
      downloadedFiles.push(tempPath);
      photoPaths.push(tempPath);
      generativeParts.push(fileToGenerativePart(tempPath, 'image/jpeg'));
    }
  }

  const userTexts = items.filter(i => i.type === 'text').map(t => t.text).join('\n');

  const prompt = `
You are an expert IT Support Engineer, incident triage specialist, and linguist.
Analyze the user's input:
- User Typed Text: "${userTexts || '(None)'}"
- Voice Notes: Attached audio file(s) if any. Transcribe each voice note exactly as spoken.
- Images: Attached if any.

CRITICAL RULES:
1. Intent Classification:
   - Determine whether the user is actually describing a technical problem, error, issue, bug, request for help, or difficulty.
   - If the input is ONLY a casual greeting (e.g., "Hello", "Hi", "Good morning", "សួស្តី", "thanks", "ok", or small talk), set "is_problem": false. Do not assume every message is a problem.
   - Only set "is_problem": true when the user actually reports a technical issue or requests assistance.

2. Problem Processing (when is_problem is true):
   - Correct and rewrite any grammar mistakes, unclear wording, or poor sentence structure while preserving original meaning.
   - Separate unrelated greetings/conversation from the actual problem.
   - If the user explained across multiple messages/voice notes, combine the relevant information into one clear problem statement.
   - Detect primary language (Khmer or English).
   - Write ALL output fields in the SAME detected language (Khmer if Khmer, English if English).
   - Extract OCR text/error codes from photos if present.

Return ONLY a valid JSON object matching this schema without markdown code blocks:
{
  "is_problem": true | false,
  "language": "Khmer" | "English",
  "voice_transcriptions": ["Exact transcription of each attached voice note, in order; empty array if there are none"],
  "ocr_text": "Error codes / text found in photos or 'None'",
  "issue_summary": "1-2 sentence clear issue summary in the SAME detected language (Khmer if Khmer, English if English)",
  "urgency": "Low" | "Medium" | "High",
  "recommended_action": "Suggested troubleshooting step in the SAME language (Khmer if Khmer, English if English)",
  "casual_reply": "Short polite greeting reply if is_problem is false, otherwise empty"
}
`;

  generativeParts.push(prompt);

  const fallbackModels = GEMINI_FALLBACK_MODELS;
  let responseText = null;

  for (const modelName of fallbackModels) {
    try {
      console.log(`⚡ [Gemini] Requesting AI analysis with [${modelName}]...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(generativeParts);
      responseText = result.response.text();
      break;
    } catch (e) {
      console.warn(`⚠️ [Gemini] Model ${modelName} busy/failed:`, e.message);
    }
  }

  if (!responseText) throw new Error('All Gemini models failed');

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { issue_summary: responseText, urgency: 'Medium' };
  if (!Array.isArray(parsed.voice_transcriptions)) {
    parsed.voice_transcriptions = parsed.voice_transcriptions ? [String(parsed.voice_transcriptions)] : [];
  }
  parsed.engineUsed = 'Google Gemini AI';
  return parsed;
}

// Transcribe mini app voice clips (local files) with the available AI engine.
// Khmer stays Khmer, English stays English — same behaviour as the group flow.
async function analyzeMiniAppVoices(voicePaths) {
  if (!voicePaths.length) return { transcriptions: [], language: null };

  const prompt = 'You are a transcription assistant. The attached audio clip(s) are IT problem reports ' +
    'spoken by a user in Khmer, English, or a mix of both. Transcribe each clip exactly as spoken, ' +
    'in the language that was spoken. Return ONLY valid JSON without markdown:\n' +
    '{"transcriptions": ["clip 1 text", "clip 2 text"], "language": "Khmer" or "English"}';

  if (genAI) {
    for (const modelName of GEMINI_FALLBACK_MODELS) {
      try {
        console.log(`🎙️ [Gemini] Transcribing ${voicePaths.length} mini app voice clip(s) with [${modelName}]...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const parts = voicePaths.map(function (p) {
          const mime = p.endsWith('.m4a') ? 'audio/mp4' : (p.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
          return fileToGenerativePart(p, mime);
        });
        parts.push(prompt);
        const result = await model.generateContent(parts);
        const text = result.response.text();
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed.transcriptions)) {
            return { transcriptions: parsed.transcriptions, language: parsed.language || null };
          }
        }
      } catch (e) {
        console.warn(`⚠️ [Gemini] ${modelName} transcription failed:`, e.message);
      }
    }
  }

  if (openai) {
    try {
      const transcriptions = [];
      for (const p of voicePaths) {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(p),
          model: 'whisper-1',
          response_format: 'text'
        });
        transcriptions.push((typeof tr === 'string' ? tr : tr.text || '').trim());
      }
      return { transcriptions, language: null };
    } catch (e) {
      console.warn('⚠️ [OpenAI] Whisper transcription failed:', e.message);
    }
  }

  throw new Error('All AI engines failed to transcribe');
}

// ==========================================
// 6. Smart Ticket Bundling & Processing Engine
// ==========================================

function bufferUserReport(ctx, item) {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const sessionKey = `${chatId}_${userId}`;

  let session = reportSessions.get(sessionKey);

  if (!session) {
    session = {
      chat: ctx.chat,
      fromUser: ctx.from,
      firstMessageId: ctx.message.message_id,
      lastMessageId: ctx.message.message_id,
      items: [],
      timer: null
    };
    reportSessions.set(sessionKey, session);
  } else {
    clearTimeout(session.timer);
    session.lastMessageId = ctx.message.message_id;
  }

  session.items.push(item);

  try {
    if (ctx.react) ctx.react('✍️').catch(() => { });
  } catch (e) { }

  session.timer = setTimeout(() => {
    processUnifiedTicket(sessionKey);
  }, BUFFER_WINDOW_MS);
}

async function processUnifiedTicket(sessionKey) {
  const session = reportSessions.get(sessionKey);
  if (!session) return;
  reportSessions.delete(sessionKey);

  const { chat, fromUser, firstMessageId, items } = session;
  const { fullName, username, id: userId } = formatUserInfo(fromUser);
  const groupTitle = chat.title || (chat.type === 'private' ? 'Private Message' : 'Group Chat');
  const messageLink = getMessageLink(chat, firstMessageId);

  const voiceCount = items.filter(i => i.type === 'voice').length;
  const photoCount = items.filter(i => i.type === 'photo').length;
  const textCount = items.filter(i => i.type === 'text').length;
  const totalDuration = items.filter(i => i.type === 'voice').reduce((sum, v) => sum + (v.duration || 0), 0);
  const userTexts = items.filter(i => i.type === 'text').map(t => t.text).join('\n');

  console.log(`⚡ Processing unified ticket for [${fullName}] in [${groupTitle}] (${voiceCount} voice, ${photoCount} photos, ${textCount} text)`);

  const downloadedFiles = [];
  const photoPaths = [];
  let parsed = null;

  try {
    const provider = AI_PROVIDER.toLowerCase();

    if (provider === 'openai') {
      parsed = await processWithOpenAI(items, downloadedFiles, photoPaths);
    } else if (provider === 'gemini') {
      parsed = await processWithGemini(items, downloadedFiles, photoPaths);
    } else {
      // 'auto' mode: Try OpenAI first, if fails or no key, fallback to Gemini!
      try {
        if (openai) {
          parsed = await processWithOpenAI(items, downloadedFiles, photoPaths);
        } else {
          parsed = await processWithGemini(items, downloadedFiles, photoPaths);
        }
      } catch (primaryErr) {
        console.warn('⚠️ Primary AI provider failed, attempting automatic fallback...', primaryErr.message);
        if (openai && genAI) {
          parsed = await processWithGemini(items, downloadedFiles, photoPaths);
        } else {
          throw primaryErr;
        }
      }
    }

    console.log(`✅ AI Processing Complete (${parsed.engineUsed}):`, parsed);

    // 1. If user sent only casual greetings or non-problem messages -> Reply directly in group/chat and skip IT ticket
    if (parsed.is_problem === false) {
      console.log(`ℹ️ [${fullName}] sent a casual/non-problem message. Replying in source chat without creating IT ticket.`);
      await setMessageReaction(chat.id, firstMessageId, null);

      const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
      const defaultReply = isKhmer
        ? `👋 សួស្តី <b>${escapeHtml(fullName)}</b>! តើខ្ញុំអាចជួយអ្វីអ្នកទាក់ទងនឹងបច្ចេកទេស/IT ដែរឬទេ? 😊\n\n👉 <i>អ្នកអាចផ្ញើសារជាសំឡេង 🎙️ រូបភាព 📸 ឬអក្សរ 💬 ដើម្បីរាយការណ៍បញ្ហាបានភ្លាមៗ។</i>`
        : `👋 Hello <b>${escapeHtml(fullName)}</b>! How can I help you with your IT needs today? 😊\n\n👉 <i>Feel free to send a voice note 🎙️, photo 📸, or text 💬 to report an issue.</i>`;

      const replyText = parsed.casual_reply ? `👋 ${escapeHtml(parsed.casual_reply)}` : defaultReply;

      try {
        await bot.telegram.sendMessage(chat.id, replyText, {
          parse_mode: 'HTML',
          reply_parameters: { message_id: firstMessageId }
        });
      } catch (replyErr) {
        await bot.telegram.sendMessage(chat.id, replyText, { parse_mode: 'HTML' }).catch(() => { });
      }
      return;
    }

    // 2. User reported an actual technical problem -> Format structured IT ticket
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Phnom_Penh',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    const ticketId = `TK-${Date.now().toString(36).toUpperCase()}`;
    const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
    const urgencyEmoji = parsed.urgency === 'High' ? '🔴' : parsed.urgency === 'Medium' ? '🟡' : '🟢';

    // Auto-detect department from group title and user text
    let department = 'General';
    const combinedText = `${groupTitle} ${userTexts}`.toLowerCase();
    if (/sale|លក់/.test(combinedText)) department = 'Sales';
    else if (/finance|account|គណនេយ្យ|លុយ|bill|invoice/.test(combinedText)) department = 'Finance';
    else if (/hr|human|admin|រដ្ឋបាល|បុគ្គលិក/.test(combinedText)) department = 'HR & Admin';
    else if (/operation|ប្រតិបត្តិការ/.test(combinedText)) department = 'Operations';
    else if (/warehouse|stock|logistics|ឃ្លាំង|ដឹក/.test(combinedText)) department = 'Warehouse & Logistics';
    else if (/marketing|ទីផ្សារ/.test(combinedText)) department = 'Marketing';
    else if (/manage|boss|director|ថ្នាក់ដឹកនាំ/.test(combinedText)) department = 'Management';

    let alertMessage = `🚨 <b>NEW IT SUPPORT MASTER TICKET</b>\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
    alertMessage += `🎫 <b>Ticket ID:</b> <code>${ticketId}</code>\n`;
    alertMessage += `👤 <b>Reporter:</b> ${escapeHtml(fullName)} (${escapeHtml(username)})\n`;
    alertMessage += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    alertMessage += `🏢 <b>Department:</b> <b>${escapeHtml(department)}</b>\n`;
    alertMessage += `🏢 <b>Source:</b> ${escapeHtml(groupTitle)}\n`;
    alertMessage += `📦 <b>Bundle:</b> ${voiceCount} 🎙️ (${formatDuration(totalDuration)}) | ${photoCount} 📸 | ${textCount} 💬\n`;
    alertMessage += `${urgencyEmoji} <b>Urgency:</b> <b>${escapeHtml(parsed.urgency || 'Normal')}</b>\n`;
    alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    if (messageLink) {
      alertMessage += `🔗 <b>Original Message:</b> <a href="${messageLink}">View in Group</a>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (parsed.ocr_text && parsed.ocr_text !== 'None' && parsed.ocr_text !== 'គ្មាន') {
      alertMessage += `🔍 <b>Visual Screen OCR / Error:</b>\n<code>${escapeHtml(parsed.ocr_text)}</code>\n\n`;
    }

    if (isKhmer) {
      alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${escapeHtml(parsed.issue_summary)}\n\n`;
    } else {
      alertMessage += `📌 <b>Issue Summary:</b>\n${escapeHtml(parsed.issue_summary)}\n\n`;
    }

    if (parsed.voice_transcriptions && parsed.voice_transcriptions.length > 0) {
      alertMessage += isKhmer ? `📝 <b>អត្ថបទសំឡេង (Voice Transcriptions):</b>\n` : `📝 <b>Voice Transcriptions:</b>\n`;
      parsed.voice_transcriptions.forEach((trans, idx) => {
        alertMessage += `<i>${idx + 1}. ${escapeHtml(trans)}</i>\n`;
      });
      alertMessage += `\n`;
    }

    if (userTexts) {
      alertMessage += `💬 <b>សារអក្សរ (Text Content):</b>\n<i>${escapeHtml(userTexts)}</i>\n\n`;
    }

    if (parsed.recommended_action) {
      alertMessage += `💡 <b>ដំណោះស្រាយបឋម (Suggested Action):</b>\n${escapeHtml(parsed.recommended_action)}\n`;
    }

    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    const sentMessage = await sendToITGroup(alertMessage, photoPaths, ticketActionKeyboard(ticketId, 'open'));

    // Save ticket to tickets.json
    const ticket = {
      id: ticketId,
      source: 'group',
      status: 'open',
      department,
      chatId: chat.id,
      groupTitle,
      firstMessageId,
      lastMessageId: session.lastMessageId || firstMessageId,
      messageLink,
      userId,
      fullName,
      username,
      issue: parsed.issue_summary || userTexts || 'Technical issue reported',
      ocrText: parsed.ocr_text || null,
      urgency: parsed.urgency || 'Medium',
      photos: photoCount,
      voices: voiceCount,
      transcriptions: parsed.voice_transcriptions || [],
      recommendedAction: parsed.recommended_action || null,
      rawAlertText: alertMessage,
      itMessageId: sentMessage ? sentMessage.message_id : null,
      itChatId: sentMessage ? sentMessage.chat.id : null,
      handledBy: null,
      closedAt: null,
      closedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const tickets = loadTickets();
    tickets.push(ticket);
    saveTickets(tickets);
    console.log(`🚀 Master Ticket [${ticketId}] saved to database and sent to IT group`);

    // Confirmation reaction ✅ on the user's report message in the group
    await setMessageReaction(chat.id, firstMessageId, '✅');
    if (session.lastMessageId && session.lastMessageId !== firstMessageId) {
      await setMessageReaction(chat.id, session.lastMessageId, '✅');
    }

  } catch (err) {
    console.error('❌ Error processing ticket:', err.message || err);

    const errorMessage = `⚠️ <b>TICKET PROCESSING ERROR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Reporter:</b> ${escapeHtml(fullName)} (${escapeHtml(username)})\n` +
      `🏢 <b>Source:</b> ${escapeHtml(groupTitle)}\n` +
      `❌ <b>Error:</b> <code>${escapeHtml(err.message || 'Error occurred during AI processing')}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(errorMessage).catch(() => { });
  } finally {
    downloadedFiles.forEach(file => {
      if (fs.existsSync(file)) {
        fs.promises.unlink(file).catch(() => { });
      }
    });
  }
}

// ==========================================
// 7. Telegram Bot Commands & Listeners
// ==========================================

bot.start((ctx) => {
  const welcomeText = `👋 <b>ស្វាគមន៍មកកាន់ IT Support Bot</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `ផ្ញើសារសំឡេង 🎙️ រូបភាព Error 📸 ឬអក្សរ 💬 ក្នុង Group ដើម្បីស្នើសុំជំនួយបច្ចេកទេស។\n\n` +
    `👇 <b>ចុចប៊ូតុងខាងក្រោមដើម្បីជ្រើសរើស (Quick Menu):</b>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📝 Report Guide', callback_data: 'cmd_report' },
        { text: '🚨 Urgent Report', callback_data: 'cmd_urgent' }
      ],
      [
        { text: '📞 Contact IT', callback_data: 'cmd_contact' },
        { text: '🟢 System Status', callback_data: 'cmd_status' }
      ]
    ]
  };

  const startMiniRow = miniAppButtonRow(ctx.chat);
  if (startMiniRow) keyboard.inline_keyboard.push(startMiniRow);

  ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
});

bot.command('help', (ctx) => {
  const helpText = `🛠️ <b>IT Support Help & Guide</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>របៀបរាយការណ៍បញ្ហា (How to Report):</b>\n\n` +
    `🎙️ <b>ផ្ញើសារសំឡេង (Voice Note):</b>\n` +
    `• ចុច icon មេក្រូហ្វូន 🎙️ រួចនិយាយរៀបរាប់ពីបញ្ហាជាភាសាខ្មែរ ឬអង់គ្លេស។\n\n` +
    `📸 <b>ផ្ញើរូបភាព (Screenshots / Photos):</b>\n` +
    `• ថតរូបអេក្រង់ដែលចេញ Error ឬឧបករណ៍ដែលខូច រួចផ្ញើចូល Group។\n\n` +
    `💬 <b>ផ្ញើសារអក្សរ (Text Message):</b>\n` +
    `• សរសេរសាររៀបរាប់ពីបញ្ហាធម្មតា។\n\n` +
    `👇 <b>ចុចប៊ូតុងខាងក្រោមដើម្បីមើលព័ត៌មានបន្ថែម៖</b>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📝 Report Guide', callback_data: 'cmd_report' },
        { text: '🚨 Urgent Report', callback_data: 'cmd_urgent' }
      ],
      [
        { text: '📞 Contact IT', callback_data: 'cmd_contact' },
        { text: '🟢 System Status', callback_data: 'cmd_status' }
      ]
    ]
  };

  const helpMiniRow = miniAppButtonRow(ctx.chat);
  if (helpMiniRow) keyboard.inline_keyboard.push(helpMiniRow);

  ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => { });
});

// Report Handlers
function sendReportGuide(ctx) {
  const reportGuide = `📝 <b>របៀបស្នើសុំជំនួយបច្ចេកទេស (IT Ticket Guide)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `ដើម្បីឱ្យក្រុមការងារ IT ជួយដោះស្រាយបានលឿន សូមបញ្ជាក់៖\n\n` +
    `1️⃣ <b>ឧបករណ៍ (Device):</b> កុំព្យូទ័រ / Printer / Internet / Network\n` +
    `2️⃣ <b>បញ្ហាជួបប្រទះ (Issue):</b> បើកមិនចេញ / គាំង / Error code...\n` +
    `3️⃣ <b>រូបភាព (Photo):</b> ថតរូប Error screen បើមាន 📸\n` +
    `4️⃣ <b>ទីតាំង (Location):</b> បន្ទប់ / ជាន់ / ផ្នែក\n\n` +
    `👉 <i>ផ្ញើសារសំឡេង 🎙️ រូបភាព 📸 ឬអក្សរ 💬 ក្នុង Group នេះបានភ្លាមៗ!</i>`;
  ctx.reply(reportGuide, { parse_mode: 'HTML' });
}

bot.command('report', (ctx) => sendReportGuide(ctx));
bot.action('cmd_report', (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  sendReportGuide(ctx);
});

// Urgent Handlers
function sendUrgentGuide(ctx) {
  const urgentText = `🚨 <b>ការរាយការណ៍បញ្ហាបន្ទាន់ (Urgent IT Report)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `សម្រាប់បញ្ហាគាំងប្រព័ន្ធទាំងមូល, ដាច់អ៊ីនធឺណិតទូទាំងក្រុមហ៊ុន, ឬ Server Error:\n\n` +
    `1. ផ្ញើសារសំឡេង ឬអក្សរដោយដាក់ពាក្យ <b>"URGENT / បន្ទាន់"</b> នៅខាងដើម។\n` +
    `2. AI នឹងកំណត់កម្រិតជា 🔴 <b>High Urgency</b> ដោយស្វ័យប្រវត្តិ។\n` +
    `3. ក្រុមការងារ IT Support នឹងទទួលបានការជូនដំណឹងភ្លាមៗ!`;
  ctx.reply(urgentText, { parse_mode: 'HTML' });
}

bot.command('urgent', (ctx) => sendUrgentGuide(ctx));
bot.action('cmd_urgent', (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  sendUrgentGuide(ctx);
});

bot.action('cmd_contact', (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const rawContacts = process.env.IT_SUPPORT_USERNAME || '@ThearaKhut_1, @IT_Support_2';
  const contactsList = rawContacts
    .split(/[,|]/)
    .map(c => c.trim())
    .filter(Boolean);

  let telegramLines = '';
  if (contactsList.length > 1) {
    telegramLines = '✈️ <b>Telegram Support:</b>\n' + contactsList.map(c => `• ${c}`).join('\n');
  } else {
    telegramLines = `✈️ <b>Telegram:</b> ${contactsList[0] || '@ThearaKhut_1'}`;
  }

  const contactText = `📞 <b>ទំនាក់ទំនងក្រុមការងារ IT (IT Support Contact)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🕒 <b>ម៉ោងធ្វើការ (Working Hours):</b>\n` +
    `• ច័ន្ទ - សុក្រ (Mon - Fri): 8:00 AM - 5:00 PM\n` +
    `• សៅរ៍ (Sat): 8:00 AM - 3:00 PM\n\n` +
    `${telegramLines}\n\n` +
    `📧 <b>Email:</b> itsupport.cam@leesfood.com\n` +
    `🏢 <b>Office:</b> IT Department (Floor 1)`;

  ctx.reply(contactText, { parse_mode: 'HTML' });
});

bot.action('cmd_status', (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const statusText = `🟢 <b>IT Bot System Status</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `• <b>Service:</b> Online & Operational\n` +
    `• <b>Active AI Engine:</b> ${AI_PROVIDER.toUpperCase()}\n` +
    `• <b>Ticket Bundling:</b> Active (8s buffer)\n` +
    `• <b>Anti-Scam Protection:</b> Enabled 🛡️\n` +
    `• <b>Uptime:</b> ${hours}h ${minutes}m`;

  ctx.reply(statusText, { parse_mode: 'HTML' });
});

bot.command('contact', (ctx) => {
  const rawContacts = process.env.IT_SUPPORT_USERNAME || '@ThearaKhut_1, @IT_Support_2';
  const contactsList = rawContacts
    .split(/[,|]/)
    .map(c => c.trim())
    .filter(Boolean);

  let telegramLines = '';
  if (contactsList.length > 1) {
    telegramLines = '✈️ <b>Telegram Support:</b>\n' + contactsList.map(c => `• ${c}`).join('\n');
  } else {
    telegramLines = `✈️ <b>Telegram:</b> ${contactsList[0] || '@ThearaKhut_1'}`;
  }

  const contactText = `📞 <b>ទំនាក់ទំនងក្រុមការងារ IT (IT Support Contact)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🕒 <b>ម៉ោងធ្វើការ (Working Hours):</b>\n` +
    `• ច័ន្ទ - សុក្រ (Mon - Fri): 8:00 AM - 5:00 PM\n` +
    `• សៅរ៍ (Sat): 8:00 AM - 3:00 PM\n\n` +
    `${telegramLines}\n\n` +
    `📧 <b>Email:</b> itsupport.cam@leesfood.com\n` +
    `🏢 <b>Office:</b> IT Department (Floor 1)`;

  ctx.reply(contactText, { parse_mode: 'HTML' });
});

bot.command('status', (ctx) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const statusText = `🟢 <b>IT Bot System Status</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `• <b>Service:</b> Online & Operational\n` +
    `• <b>Active AI Engine:</b> ${AI_PROVIDER.toUpperCase()}\n` +
    `• <b>Ticket Bundling:</b> Active (8s buffer)\n` +
    `• <b>Uptime:</b> ${hours}h ${minutes}m\n` +
    `• <b>Auto IT Forwarding:</b> Active ✅`;

  ctx.reply(statusText, { parse_mode: 'HTML' });
});

bot.command('getid', (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  console.log(`📌 Chat ID for "${chatTitle}": ${chatId}`);
  ctx.reply(`ℹ️ <b>Chat Details:</b>\n• <b>Title:</b> ${escapeHtml(chatTitle)}\n• <b>Type:</b> ${chatType}\n• <b>Chat ID:</b> <code>${chatId}</code>\n\n<i>Copy this Chat ID into your .env for IT_GROUP_ID</i>`, {
    parse_mode: 'HTML'
  });
});

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

bot.command('export', async (ctx) => {
  const isItChat = IT_GROUP_ID && ctx.chat.id.toString() === IT_GROUP_ID.toString();
  if (!isItChat && ctx.chat.type !== 'private') {
    return ctx.reply('⚠️ បញ្ជានេះសម្រាប់តែក្រុមការងារ IT Support ប៉ុណ្ណោះ។ (This command is restricted to the IT Support team.)', { parse_mode: 'HTML' }).catch(() => {});
  }

  const tickets = loadTickets();
  if (!tickets || tickets.length === 0) {
    return ctx.reply('ℹ️ មិនទាន់មានសំបុត្រ IT នៅក្នុងប្រព័ន្ធនៅឡើយទេ។ (No tickets recorded yet.)', { parse_mode: 'HTML' }).catch(() => {});
  }

  const total = tickets.length;
  const openCount = tickets.filter(t => (t.status || 'open') === 'open').length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const resolvedCount = tickets.filter(t => t.status === 'resolved').length;
  const rejectedCount = tickets.filter(t => t.status === 'rejected').length;

  const headers = [
    'Ticket ID',
    'Created Date (GMT+7)',
    'Status',
    'Department',
    'Urgency',
    'Reporter Name',
    'Username',
    'User ID',
    'Source Channel',
    'Handled By',
    'Updated Date (GMT+7)',
    'Closed Date (GMT+7)',
    'Issue Summary',
    'Voice Transcriptions',
    'Screen OCR Text',
    'Suggested Action',
    'Original Message Link'
  ];

  const rows = tickets.map(t => {
    const createdText = t.createdAt
      ? new Date(t.createdAt).toLocaleString('en-US', { timeZone: 'Asia/Phnom_Penh' })
      : '';
    const updatedText = t.updatedAt
      ? new Date(t.updatedAt).toLocaleString('en-US', { timeZone: 'Asia/Phnom_Penh' })
      : '';
    const closedText = t.closedAt
      ? new Date(t.closedAt).toLocaleString('en-US', { timeZone: 'Asia/Phnom_Penh' })
      : '';
    const transcriptText = Array.isArray(t.transcriptions) ? t.transcriptions.join(' | ') : '';

    return [
      escapeCsv(t.id),
      escapeCsv(createdText),
      escapeCsv(t.status || 'open'),
      escapeCsv(t.department || 'General'),
      escapeCsv(t.urgency || 'Normal'),
      escapeCsv(t.fullName || ''),
      escapeCsv(t.username || ''),
      escapeCsv(t.userId || ''),
      escapeCsv(t.groupTitle || (t.source === 'miniapp' ? 'Telegram Mini App' : 'Group Chat')),
      escapeCsv(t.handledBy || ''),
      escapeCsv(updatedText),
      escapeCsv(closedText),
      escapeCsv(t.issue || ''),
      escapeCsv(transcriptText),
      escapeCsv(t.ocrText || ''),
      escapeCsv(t.recommendedAction || ''),
      escapeCsv(t.messageLink || '')
    ].join(',');
  });

  const BOM = '\uFEFF';
  const csvData = BOM + [headers.join(','), ...rows].join('\r\n');

  const nowStr = new Date().toISOString().slice(0, 10);
  const fileName = `IT_Tickets_Report_${nowStr}.csv`;
  const tempPath = path.join(os.tmpdir(), fileName);

  try {
    fs.writeFileSync(tempPath, csvData, 'utf8');

    const caption = `📊 <b>IT SUPPORT TICKETS EXPORT</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📦 <b>Total Tickets:</b> <code>${total}</code>\n` +
      `⏳ <b>Open:</b> <code>${openCount}</code> | 🔧 <b>In Progress:</b> <code>${inProgressCount}</code>\n` +
      `✅ <b>Resolved:</b> <code>${resolvedCount}</code> | ❌ <b>Rejected:</b> <code>${rejectedCount}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📥 <i>Excel-Ready (UTF-8 with Khmer Unicode Support)</i>`;

    await ctx.replyWithDocument(
      { source: tempPath, filename: fileName },
      { caption, parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('❌ /export failed:', err);
    ctx.reply(`❌ Could not generate export: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
});

bot.command('app', async (ctx) => {
  if (!MINIAPP_URL) {
    return ctx.reply('ℹ️ Mini App is not configured yet. Set <code>MINIAPP_URL</code> in .env and restart.', { parse_mode: 'HTML' }).catch(() => { });
  }

  const miniRow = miniAppButtonRow(ctx.chat);
  let text = '📱 <b>IT Support Mini App</b>\nបើកកម្មវិធីដើម្បីរាយការណ៍បញ្ហាដោយផ្ទាល់ (report an issue without typing in the group):';
  if (!miniRow) {
    text += '\n\n👉 បើក private chat ជាមួយ bot រួចចុចប៊ូតុង 🛠️ <b>Open IT App</b> នៅខាងក្រោម។';
  }

  try {
    const sent = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: miniRow ? { inline_keyboard: [miniRow] } : undefined
    });
    await pinAppMessage(ctx, sent);
  } catch (e) {
    console.error('❌ /app reply failed:', e.message);
  }
});

// ==========================================
// 6.5 IT Ticket Action Callback Listener
// ==========================================
bot.action(/^tk_act:([^:]+):([^:]+)$/, async (ctx) => {
  const ticketId = ctx.match[1];
  const newStatus = ctx.match[2]; // 'open' | 'in_progress' | 'resolved' | 'rejected'

  const tickets = loadTickets();
  const ticketIndex = tickets.findIndex(t => t.id === ticketId);
  if (ticketIndex === -1) {
    return ctx.answerCbQuery('⚠️ Ticket not found.', { show_alert: true }).catch(() => {});
  }

  const ticket = tickets[ticketIndex];
  if (ticket.status === newStatus) {
    return ctx.answerCbQuery(`Ticket is already ${newStatus}`).catch(() => {});
  }

  const itUser = ctx.from;
  const { fullName: itFullName, username: itUsername } = formatUserInfo(itUser);
  const itStaffTag = itUsername !== 'No username' ? itUsername : itFullName;

  const prevStatus = ticket.status;
  ticket.status = newStatus;
  ticket.updatedAt = new Date().toISOString();
  ticket.handledBy = itStaffTag;
  ticket.handledByName = itFullName;
  if (newStatus === 'resolved' || newStatus === 'rejected') {
    ticket.closedAt = new Date().toISOString();
    ticket.closedBy = itStaffTag;
  } else if (newStatus === 'open') {
    ticket.closedAt = null;
    ticket.closedBy = null;
  }
  tickets[ticketIndex] = ticket;
  saveTickets(tickets);

  const toastMap = {
    in_progress: '🔧 Ticket marked as In Progress',
    resolved: '✅ Ticket marked as Resolved!',
    rejected: '❌ Ticket marked as Rejected',
    open: '🔄 Ticket re-opened'
  };
  await ctx.answerCbQuery(toastMap[newStatus] || 'Status updated').catch(() => {});

  const rawBase = ticket.rawAlertText || (ctx.callbackQuery.message?.text ? escapeHtml(ctx.callbackQuery.message.text) : '');
  const updatedMessageText = formatTicketAlertWithStatus(rawBase, ticket);
  const newKeyboard = ticketActionKeyboard(ticketId, newStatus);

  try {
    await ctx.editMessageText(updatedMessageText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: newKeyboard
    });
  } catch (editErr) {
    try {
      await ctx.editMessageReplyMarkup(newKeyboard);
    } catch (kmErr) {
      console.warn('Could not edit ticket reply markup:', kmErr.message);
    }
  }

  console.log(`🎯 Ticket [${ticketId}] status changed: ${prevStatus} ➔ ${newStatus} by [${itStaffTag}]`);

  // Notifications for Reporter:
  // 1. If resolved or rejected on a group ticket, optionally post a neat closure note in the original chat
  if (ticket.source === 'group' && ticket.chatId && ticket.firstMessageId) {
    if (newStatus === 'resolved') {
      const resolvedReply = `✅ <b>IT Support Update</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `បញ្ហារបស់ <b>${escapeHtml(ticket.fullName)}</b> ត្រូវបានដោះស្រាយរួចរាល់ហើយ ដោយក្រុមការងារ IT (${escapeHtml(itStaffTag)})! 🎉\n\n` +
        `<i>Ticket #${ticket.id} marked as Resolved. Thank you!</i>`;
      bot.telegram.sendMessage(ticket.chatId, resolvedReply, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: ticket.firstMessageId }
      }).catch(() => {});
    } else if (newStatus === 'rejected') {
      const rejectedReply = `ℹ️ <b>IT Support Notice</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `សំបុត្រ #${ticket.id} របស់ <b>${escapeHtml(ticket.fullName)}</b> ត្រូវបានបដិសេធ ឬមិនមែនជាបញ្ហា IT (${escapeHtml(itStaffTag)})។\n` +
        `<i>Ticket #${ticket.id} closed. Contact IT if you need further assistance.</i>`;
      bot.telegram.sendMessage(ticket.chatId, rejectedReply, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: ticket.firstMessageId }
      }).catch(() => {});
    }
  }

  // 2. If it's a Mini App ticket, send a private notification message to user if available
  if (ticket.source === 'miniapp' && ticket.userId) {
    if (newStatus === 'resolved') {
      const pmMsg = `✅ <b>IT Support Update</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `សំបុត្រជំនួយ <b>#${ticket.id}</b> របស់លោកអ្នក ត្រូវបានដោះស្រាយរួចរាល់ហើយ ដោយ IT (${escapeHtml(itStaffTag)})! 🎉\n\n` +
        `📌 <b>Issue:</b> ${escapeHtml((ticket.issue || '').slice(0, 120))}\n` +
        `<i>អ្នកអាចពិនិត្យមើលក្នុង Mini App គ្រប់ពេលវេលា។</i>`;
      bot.telegram.sendMessage(ticket.userId, pmMsg, { parse_mode: 'HTML' }).catch(() => {});
    } else if (newStatus === 'rejected') {
      const pmMsg = `ℹ️ <b>IT Support Notice</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `សំបុត្រជំនួយ <b>#${ticket.id}</b> ត្រូវបានបដិសេធ ដោយ IT (${escapeHtml(itStaffTag)})។\n` +
        `<i>ប្រសិនបើមានចម្ងល់ សូមទាក់ទងមកកាន់ IT Support ផ្ទាល់។</i>`;
      bot.telegram.sendMessage(ticket.userId, pmMsg, { parse_mode: 'HTML' }).catch(() => {});
    }
  }
});

// ----------------------------------------------------
// Media & Message Listeners
// ----------------------------------------------------

bot.on(['voice', 'audio'], (ctx) => {
  const chat = ctx.chat;
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  const isVoice = !!ctx.message.voice;
  const audioData = ctx.message.voice || ctx.message.audio;

  bufferUserReport(ctx, {
    type: 'voice',
    fileId: audioData.file_id,
    duration: audioData.duration || 0,
    mimeType: isVoice ? 'audio/ogg' : 'audio/mp3',
    ext: isVoice ? 'ogg' : 'mp3'
  });
});

bot.on('photo', (ctx) => {
  const chat = ctx.chat;
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  const photos = ctx.message.photo;
  const largestPhoto = photos[photos.length - 1];

  bufferUserReport(ctx, {
    type: 'photo',
    fileId: largestPhoto.file_id,
    caption: ctx.message.caption || ''
  });

  if (ctx.message.caption) {
    bufferUserReport(ctx, {
      type: 'text',
      text: ctx.message.caption
    });
  }
});

// 3. Text Messages
bot.on('text', (ctx) => {
  const chat = ctx.chat;
  const userText = (ctx.message.text || '').trim();

  if (userText.startsWith('/')) return;
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  bufferUserReport(ctx, {
    type: 'text',
    text: userText
  });
});

// 4. Anti-Scam & Dangerous File Protection (Documents)
const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'ps1', 'vbs', 'scr', 'msi', 'apk', 'com', 'pif', 'lnk',
  'zip', 'rar', '7z', 'iso', 'tar', 'gz', 'docm', 'xlsm', 'wsf', 'hta', 'jar'
]);

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

bot.on('document', async (ctx) => {
  const chat = ctx.chat;
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  const document = ctx.message.document;
  const fromUser = ctx.from;
  const fileName = document.file_name || 'unnamed_file';
  const fileSize = document.file_size || 0;
  const fileExt = fileName.split('.').pop().toLowerCase();
  const { fullName, username, id: userId } = formatUserInfo(fromUser);
  const groupTitle = chat.title || (chat.type === 'private' ? 'Private Message' : 'Group Chat');

  // Check if file extension is in dangerous blacklist
  if (DANGEROUS_EXTENSIONS.has(fileExt)) {
    console.warn(`🚨 BLOCKED DANGEROUS FILE: "${fileName}" from [${fullName}] in [${groupTitle}]`);

    // 1. Delete malicious message immediately from group
    try {
      await ctx.deleteMessage();
      console.log(`🗑️ Dangerous file message deleted successfully.`);
    } catch (delErr) {
      console.error('Could not delete message (ensure bot is Admin with Delete Messages permission):', delErr.message);
    }

    // 2. Warn user in group
    try {
      const warningMsg = `⚠️ <b>ការព្រមានសុវត្ថិភាព (Security Warning)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>${escapeHtml(fullName)}</b>, ការផ្ញើឯកសារប្រភេទ <code>.${escapeHtml(fileExt)}</code> ត្រូវបានហាមឃាត់ដើម្បីការពារមេរោគ និង Scam។\n` +
        `🚫 <i>ឯកសារត្រូវបានលុបចេញដោយស្វ័យប្រវត្តិ។</i>`;
      await ctx.reply(warningMsg, { parse_mode: 'HTML' });
    } catch (warnErr) { }

    // 3. Dispatch High-Priority Security Alert to IT Support Group
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Phnom_Penh',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    let securityAlert = `🛡️ <b>SECURITY ALERT: DANGEROUS FILE BLOCKED</b>\n`;
    securityAlert += `━━━━━━━━━━━━━━━━━━━━━\n`;
    securityAlert += `👤 <b>Sender:</b> ${escapeHtml(fullName)} (${escapeHtml(username)})\n`;
    securityAlert += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    securityAlert += `🏢 <b>Source:</b> ${escapeHtml(groupTitle)}\n`;
    securityAlert += `📁 <b>File Name:</b> <code>${escapeHtml(fileName)}</code>\n`;
    securityAlert += `⚠️ <b>Detected Extension:</b> <code>.${escapeHtml(fileExt)}</code>\n`;
    securityAlert += `📦 <b>File Size:</b> ${formatBytes(fileSize)}\n`;
    securityAlert += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    securityAlert += `━━━━━━━━━━━━━━━━━━━━━\n`;
    securityAlert += `🚫 <b>Status:</b> Dangerous message automatically deleted to protect employees.\n`;
    securityAlert += `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(securityAlert);
    return;
  }

  // If document is an uncompressed image (e.g. image/png, image/jpeg), buffer as photo
  if (document.mime_type && document.mime_type.startsWith('image/')) {
    bufferUserReport(ctx, {
      type: 'photo',
      fileId: document.file_id,
      caption: ctx.message.caption || ''
    });

    if (ctx.message.caption) {
      bufferUserReport(ctx, {
        type: 'text',
        text: ctx.message.caption
      });
    }
  }
});

bot.catch((err, ctx) => {
  console.error(`❌ Telegraf uncaught error:`, err);
});

bot.launch()
  .then(() => console.log(`🤖 Telegram IT Support Bot is running in [${AI_PROVIDER.toUpperCase()}] mode!`))
  .catch((err) => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
