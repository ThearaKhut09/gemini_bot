import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';
import express from 'express';
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
    writer.on('finish', () => resolve(tempFilePath));
    writer.on('error', (err) => {
      fs.unlink(tempFilePath, () => { });
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

async function sendToITGroup(alertMessage, photos = []) {
  if (!IT_GROUP_ID) return;

  async function executeSend(targetId) {
    if (photos.length > 0) {
      try {
        const mediaGroup = photos.map((filePath, idx) => ({
          type: 'photo',
          media: { source: filePath },
          caption: idx === 0 ? '📸 Attached issue screenshot(s)' : undefined
        }));
        await bot.telegram.sendMediaGroup(targetId, mediaGroup);
      } catch (mediaErr) {
        console.warn('Could not send media group to IT group:', mediaErr.message);
      }
    }

    await bot.telegram.sendMessage(targetId, alertMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  }

  try {
    await executeSend(IT_GROUP_ID);
    console.log(`🚀 Unified Ticket forwarded to IT Group (${IT_GROUP_ID})`);
  } catch (sendErr) {
    if (sendErr.response?.parameters?.migrate_to_chat_id) {
      const newChatId = sendErr.response.parameters.migrate_to_chat_id;
      console.log(`🔄 Group upgraded to Supergroup! Retrying with new ID: ${newChatId}`);
      await executeSend(newChatId);
      console.log(`🚀 Unified Ticket sent to new Supergroup ID (${newChatId})`);
    } else {
      throw sendErr;
    }
  }
}

// ==========================================
// 5. Dual Engine Processors (OpenAI & Gemini)
// ==========================================

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
  "ocr_text": "Error codes / text found in photos or 'None'",
  "issue_summary": "1-2 sentence clear issue summary in the SAME detected language (Khmer if Khmer, English if English)",
  "urgency": "Low" | "Medium" | "High",
  "recommended_action": "Suggested troubleshooting step in the SAME language (Khmer if Khmer, English if English)",
  "casual_reply": "Short polite greeting reply if is_problem is false, otherwise empty"
}
`;

  generativeParts.push(prompt);

  const fallbackModels = ['gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash'];
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
  parsed.engineUsed = 'Google Gemini AI';
  return parsed;
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
    if (ctx.react) ctx.react('✍️');
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

      const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
      const defaultReply = isKhmer
        ? `👋 សួស្តី <b>${fullName}</b>! តើខ្ញុំអាចជួយអ្វីអ្នកទាក់ទងនឹងបច្ចេកទេស/IT ដែរឬទេ? 😊\n\n👉 <i>អ្នកអាចផ្ញើសារជាសំឡេង 🎙️ រូបភាព 📸 ឬអក្សរ 💬 ដើម្បីរាយការណ៍បញ្ហាបានភ្លាមៗ។</i>`
        : `👋 Hello <b>${fullName}</b>! How can I help you with your IT needs today? 😊\n\n👉 <i>Feel free to send a voice note 🎙️, photo 📸, or text 💬 to report an issue.</i>`;

      const replyText = parsed.casual_reply ? `👋 ${parsed.casual_reply}` : defaultReply;

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

    const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
    const urgencyEmoji = parsed.urgency === 'High' ? '🔴' : parsed.urgency === 'Medium' ? '🟡' : '🟢';

    let alertMessage = `🚨 <b>NEW IT SUPPORT MASTER TICKET</b>\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
    alertMessage += `👤 <b>Reporter:</b> ${fullName} (${username})\n`;
    alertMessage += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    alertMessage += `🏢 <b>Source:</b> ${groupTitle}\n`;
    alertMessage += `📦 <b>Bundle:</b> ${voiceCount} 🎙️ (${formatDuration(totalDuration)}) | ${photoCount} 📸 | ${textCount} 💬\n`;
    alertMessage += `${urgencyEmoji} <b>Urgency:</b> <b>${parsed.urgency || 'Normal'}</b>\n`;
    alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    if (messageLink) {
      alertMessage += `🔗 <b>Original Message:</b> <a href="${messageLink}">View in Group</a>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (parsed.ocr_text && parsed.ocr_text !== 'None' && parsed.ocr_text !== 'គ្មាន') {
      alertMessage += `🔍 <b>Visual Screen OCR / Error:</b>\n<code>${parsed.ocr_text}</code>\n\n`;
    }

    if (isKhmer) {
      alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${parsed.issue_summary}\n\n`;
    } else {
      alertMessage += `📌 <b>Issue Summary:</b>\n${parsed.issue_summary}\n\n`;
    }

    if (parsed.voice_transcriptions && parsed.voice_transcriptions.length > 0) {
      alertMessage += isKhmer ? `📝 <b>អត្ថបទសំឡេង (Voice Transcriptions):</b>\n` : `📝 <b>Voice Transcriptions:</b>\n`;
      parsed.voice_transcriptions.forEach((trans, idx) => {
        alertMessage += `<i>${idx + 1}. ${trans}</i>\n`;
      });
      alertMessage += `\n`;
    }

    if (userTexts) {
      alertMessage += `💬 <b>សារអក្សរ (Text Content):</b>\n<i>${userTexts}</i>\n\n`;
    }

    if (parsed.recommended_action) {
      alertMessage += `💡 <b>ដំណោះស្រាយបឋម (Suggested Action):</b>\n${parsed.recommended_action}\n`;
    }

    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(alertMessage, photoPaths);

  } catch (err) {
    console.error('❌ Error processing ticket:', err.message || err);

    const errorMessage = `⚠️ <b>TICKET PROCESSING ERROR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Reporter:</b> ${fullName} (${username})\n` +
      `🏢 <b>Source:</b> ${groupTitle}\n` +
      `❌ <b>Error:</b> <code>${err.message || 'Error occurred during AI processing'}</code>\n` +
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

  ctx.reply(welcomeText, { parse_mode: 'HTML', reply_markup: keyboard });
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

  ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: keyboard });
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
    `• <b>Ticket Bundling:</b> Active (5s buffer)\n` +
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
    `• <b>Ticket Bundling:</b> Active (5s buffer)\n` +
    `• <b>Uptime:</b> ${hours}h ${minutes}m\n` +
    `• <b>Auto IT Forwarding:</b> Active ✅`;

  ctx.reply(statusText, { parse_mode: 'HTML' });
});

bot.command('getid', (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  console.log(`📌 Chat ID for "${chatTitle}": ${chatId}`);
  ctx.reply(`ℹ️ <b>Chat Details:</b>\n• <b>Title:</b> ${chatTitle}\n• <b>Type:</b> ${chatType}\n• <b>Chat ID:</b> <code>${chatId}</code>\n\n<i>Copy this Chat ID into your .env for IT_GROUP_ID</i>`, {
    parse_mode: 'HTML'
  });
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
        `👤 <b>${fullName}</b>, ការផ្ញើឯកសារប្រភេទ <code>.${fileExt}</code> ត្រូវបានហាមឃាត់ដើម្បីការពារមេរោគ និង Scam។\n` +
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
    securityAlert += `👤 <b>Sender:</b> ${fullName} (${username})\n`;
    securityAlert += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    securityAlert += `🏢 <b>Source:</b> ${groupTitle}\n`;
    securityAlert += `📁 <b>File Name:</b> <code>${fileName}</code>\n`;
    securityAlert += `⚠️ <b>Detected Extension:</b> <code>.${fileExt}</code>\n`;
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
