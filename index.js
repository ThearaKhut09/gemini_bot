import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';
import express from 'express';
import { Telegraf } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env explicitly from the bot directory
dotenv.config({ path: path.join(__dirname, '.env') });

const {
  BOT_TOKEN,
  GEMINI_API_KEY,
  IT_GROUP_ID,
  MONITORED_GROUP_ID,
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in environment variables!');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in environment variables!');
  process.exit(1);
}

if (!IT_GROUP_ID) {
  console.warn('⚠️ Warning: IT_GROUP_ID is not configured. Alerts will only be logged to console.');
}

// ==========================================
// 2. Initialize Clients
// ==========================================
const bot = new Telegraf(BOT_TOKEN);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// ==========================================
// 3. Lightweight Health Check Web Server
// ==========================================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Telegram IT Support Smart Bundler Bot (Google Gemini AI)',
    model: 'gemini-3.6-flash',
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

// In-memory buffer for grouping user messages (15-second window)
// Key: `${chatId}_${userId}`
const reportSessions = new Map();
const BUFFER_WINDOW_MS = 15000; // 15 seconds

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

/**
 * Sends messages to IT Group with automatic supergroup migration support
 */
async function sendToITGroup(alertMessage, photos = []) {
  if (!IT_GROUP_ID) return;

  async function executeSend(targetId) {
    // If photos are attached, send them as a media group first
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
    console.log(`🚀 Unified Ticket successfully forwarded to IT Group (${IT_GROUP_ID})`);
  } catch (sendErr) {
    if (sendErr.response?.parameters?.migrate_to_chat_id) {
      const newChatId = sendErr.response.parameters.migrate_to_chat_id;
      console.log(`🔄 Group upgraded to Supergroup! Retrying with new ID: ${newChatId}`);
      await executeSend(newChatId);
      console.log(`🚀 Unified Ticket successfully sent to new Supergroup ID (${newChatId})`);
    } else {
      throw sendErr;
    }
  }
}

// ==========================================
// 5. Smart Ticket Bundling & Processing Engine
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
    // Clear previous timer to extend buffer window
    clearTimeout(session.timer);
    session.lastMessageId = ctx.message.message_id;
  }

  session.items.push(item);

  // Acknowledge receipt quietly in chat
  try {
    if (ctx.react) ctx.react('👍');
  } catch (e) { }

  // Set debounce timer (15 seconds)
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

  console.log(`⚡ Processing unified ticket for [${fullName}] in [${groupTitle}] (${voiceCount} voice, ${photoCount} photos, ${textCount} text)`);

  const downloadedFiles = [];
  const photoPaths = [];

  try {
    const generativeParts = [];

    // 1. Download and convert all media items
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

    // 2. Prepare text descriptions
    const userTexts = items.filter(i => i.type === 'text').map(t => t.text).join('\n');

    // 3. Multimodal Prompt for Gemini
    const prompt = `
You are an expert IT Support Engineer and linguist. Analyze this complete issue report bundle from an employee.
The bundle may contain:
- Images/photos of broken screens, error codes, hardware.
- Audio voice notes in Khmer or English.
- Text messages written by the user: "${userTexts || '(None)'}".

Perform the following:
1. Detect the primary language used (Khmer or English).
2. OCR: Read and extract any visible error codes, dialog texts, or screen details from attached images.
3. Transcribe all voice notes sequentially in their original language.
4. Summarize the overall issue in 1-2 clear sentences in the SAME primary language (if Khmer -> Khmer; if English -> English).
5. Suggest the Urgency level: "Low", "Medium", or "High".
6. Suggest a 1-sentence recommended action / troubleshooting step for the IT technician.

Return ONLY a valid JSON object matching this schema without markdown code blocks:
{
  "language": "Khmer" | "English",
  "ocr_text": "Error codes / text found in photos or 'None'",
  "voice_transcriptions": ["Voice note 1 transcription...", "Voice note 2 transcription..."],
  "issue_summary": "1-2 sentence issue summary in primary language",
  "urgency": "Low" | "Medium" | "High",
  "recommended_action": "Suggested troubleshooting step for IT team"
}
`;

    generativeParts.push(prompt);

    // 4. Send combined bundle to Gemini
    const result = await geminiModel.generateContent(generativeParts);
    const responseText = result.response.text();

    let parsed = {
      language: 'Khmer',
      ocr_text: 'None',
      voice_transcriptions: [],
      issue_summary: userTexts || 'សូមពិនិត្យមើលសារ និងរូបភាពភ្ជាប់',
      urgency: 'Medium',
      recommended_action: 'ពិនិត្យមើលឧបករណ៍ និងប្រព័ន្ធផ្ទាល់'
    };

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('Could not parse JSON from Gemini response, using fallback');
    }

    console.log(`✅ Gemini Unified Ticket Analysis:`, parsed);

    // 5. Construct Master Ticket Message
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
    alertMessage += `${urgencyEmoji} <b>Urgency:</b> <b>${parsed.urgency}</b>\n`;
    alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    if (messageLink) {
      alertMessage += `🔗 <b>Original Message:</b> <a href="${messageLink}">View in Group</a>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;

    // OCR Information
    if (parsed.ocr_text && parsed.ocr_text !== 'None' && parsed.ocr_text !== 'គ្មាន') {
      alertMessage += `🔍 <b>Visual Screen OCR / Error:</b>\n<code>${parsed.ocr_text}</code>\n\n`;
    }

    // Issue Summary
    if (isKhmer) {
      alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${parsed.issue_summary}\n\n`;
    } else {
      alertMessage += `📌 <b>Issue Summary:</b>\n${parsed.issue_summary}\n\n`;
    }

    // Voice Transcriptions
    if (parsed.voice_transcriptions && parsed.voice_transcriptions.length > 0) {
      alertMessage += isKhmer ? `📝 <b>អត្ថបទសំឡេង (Voice Transcriptions):</b>\n` : `📝 <b>Voice Transcriptions:</b>\n`;
      parsed.voice_transcriptions.forEach((trans, idx) => {
        alertMessage += `<i>${idx + 1}. ${trans}</i>\n`;
      });
      alertMessage += `\n`;
    }

    // Original Text
    if (userTexts) {
      alertMessage += `💬 <b>សារអក្សរ (Text Content):</b>\n<i>${userTexts}</i>\n\n`;
    }

    // Recommended Action
    alertMessage += `💡 <b>ដំណោះស្រាយបឋម (Suggested Action):</b>\n${parsed.recommended_action}\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    // 6. Forward Unified Ticket to IT Group
    await sendToITGroup(alertMessage, photoPaths);

  } catch (err) {
    console.error('❌ Error processing unified ticket with Gemini:', err.message || err);

    const errorMessage = `⚠️ <b>TICKET PROCESSING ERROR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Reporter:</b> ${fullName} (${username})\n` +
      `🏢 <b>Source:</b> ${groupTitle}\n` +
      `❌ <b>Error:</b> <code>${err.message || 'Error occurred during AI analysis'}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(errorMessage).catch(() => { });
  } finally {
    // 7. Cleanup temp files
    downloadedFiles.forEach(file => {
      if (fs.existsSync(file)) {
        fs.promises.unlink(file).catch(() => { });
      }
    });
  }
}

// ==========================================
// 6. Telegram Bot Commands & Listeners
// ==========================================

bot.start((ctx) => {
  ctx.reply('👋 Hello! I am the Voice Report Tracker Bot.\n\nSend or forward voice messages in this group to transcribe Khmer speech and alert IT Support.');
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
    `✨ <i>អ្នកអាចផ្ញើរូបភាព + សារសំឡេងច្រើនរួមគ្នាបាន! Bot នឹងចងក្រងជាសំបុត្រ IT តែមួយយ៉ាងមានរបៀប។</i>\n\n` +
    `⚡ <b>បញ្ជី Commands:</b>\n` +
    `• /report - ការណែនាំរបៀបរាយការណ៍\n` +
    `• /urgent - រាយការណ៍បញ្ហាបន្ទាន់\n` +
    `• /contact - ព័ត៌មានទំនាក់ទំនងផ្នែក IT\n` +
    `• /status - ស្ថានភាពប្រព័ន្ធ Bot\n` +
    `• /getid - បង្ហាញ Chat ID នៃ Group`;

  ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command('report', (ctx) => {
  const reportGuide = `📝 <b>របៀបស្នើសុំជំនួយបច្ចេកទេស (IT Ticket Guide)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `ដើម្បីឱ្យក្រុមការងារ IT ជួយដោះស្រាយបានលឿន សូមបញ្ជាក់៖\n\n` +
    `1️⃣ <b>ឧបករណ៍ (Device):</b> កុំព្យូទ័រ / Printer / Internet / Network\n` +
    `2️⃣ <b>បញ្ហាជួបប្រទះ (Issue):</b> បើកមិនចេញ / គាំង / Error code...\n` +
    `3️⃣ <b>រូបភាព (Photo):</b> ថតរូប Error screen បើមាន 📸\n` +
    `4️⃣ <b>ទីតាំង (Location):</b> បន្ទប់ / ជាន់ / ផ្នែក\n\n` +
    `👉 <i>ផ្ញើសារសំឡេង 🎙️ រូបភាព 📸 ឬអក្សរ 💬 ក្នុង Group នេះបានភ្លាមៗ!</i>`;

  ctx.reply(reportGuide, { parse_mode: 'HTML' });
});

bot.command('urgent', (ctx) => {
  const urgentText = `🚨 <b>ការរាយការណ៍បញ្ហាបន្ទាន់ (Urgent IT Report)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `សម្រាប់បញ្ហាគាំងប្រព័ន្ធទាំងមូល, ដាច់អ៊ីនធឺណិតទូទាំងក្រុមហ៊ុន, ឬ Server Error:\n\n` +
    `1. ផ្ញើសារសំឡេង ឬអក្សរដោយដាក់ពាក្យ <b>"URGENT / បន្ទាន់"</b> នៅខាងដើម។\n` +
    `2. AI នឹងកំណត់កម្រិតជា 🔴 <b>High Urgency</b> ដោយស្វ័យប្រវត្តិ។\n` +
    `3. ក្រុមការងារ IT Support នឹងទទួលបានការជូនដំណឹងភ្លាមៗ!`;

  ctx.reply(urgentText, { parse_mode: 'HTML' });
});

bot.command('contact', (ctx) => {
  const contactText = `📞 <b>ទំនាក់ទំនងក្រុមការងារ IT (IT Support Contact)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🕒 <b>ម៉ោងធ្វើការ (Working Hours):</b>\n` +
    `• ច័ន្ទ - សុក្រ (Mon - Fri): 8:00 AM - 5:00 PM\n` +
    `• សៅរ៍ (Sat): 8:00 AM - 12:00 PM\n\n` +
    `📧 <b>Email:</b> itsupport@company.com\n` +
    `🏢 <b>Office:</b> IT Department (Floor 2)`;

  ctx.reply(contactText, { parse_mode: 'HTML' });
});

bot.command('status', (ctx) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const statusText = `🟢 <b>IT Bot System Status</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `• <b>Service:</b> Online & Operational\n` +
    `• <b>AI Engine:</b> Gemini 3.6 Flash (Multimodal Audio & Vision)\n` +
    `• <b>Ticket Bundling:</b> Active (15s buffer)\n` +
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
// Media & Message Listeners with 15s Buffer
// ----------------------------------------------------

// 1. Voice Notes & Audio
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

// 2. Photos & Screenshots
bot.on('photo', (ctx) => {
  const chat = ctx.chat;
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  // Grab the highest resolution photo
  const photos = ctx.message.photo;
  const largestPhoto = photos[photos.length - 1];

  bufferUserReport(ctx, {
    type: 'photo',
    fileId: largestPhoto.file_id,
    caption: ctx.message.caption || ''
  });

  // If caption was typed with photo, buffer as text too
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

  if (userText.startsWith('/')) return; // Ignore commands
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  bufferUserReport(ctx, {
    type: 'text',
    text: userText
  });
});

bot.catch((err, ctx) => {
  console.error(`❌ Telegraf uncaught error:`, err);
});

bot.launch()
  .then(() => console.log('🤖 Telegram IT Support Smart Bundler Bot is successfully running!'))
  .catch((err) => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
