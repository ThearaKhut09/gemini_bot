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

// Use high-performance Flash model
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// ==========================================
// 3. Lightweight Health Check Web Server
// ==========================================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Telegram Voice & Text Tracker Bot (Google Gemini AI)',
    model: 'gemini-3.6-flash',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const server = app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// ==========================================
// 4. Utility Functions
// ==========================================

function formatUserInfo(user) {
  const nameParts = [user.first_name, user.last_name].filter(Boolean);
  const fullName = nameParts.join(' ') || 'Unknown User';
  const username = user.username ? `@${user.username}` : 'No username';
  return { fullName, username, id: user.id };
}

function getMessageLink(chat, messageId) {
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

async function downloadTelegramAudio(fileUrl, fileExt = 'ogg') {
  const tempFilePath = path.join(os.tmpdir(), `gemini_tg_voice_${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`);
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
 * Sends structured alert to IT Group with automatic supergroup migration support
 */
async function sendToITGroup(alertMessage) {
  if (!IT_GROUP_ID) return;

  try {
    await bot.telegram.sendMessage(IT_GROUP_ID, alertMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log(`🚀 Alert successfully forwarded to IT Group (${IT_GROUP_ID})`);
  } catch (sendErr) {
    if (sendErr.response?.parameters?.migrate_to_chat_id) {
      const newChatId = sendErr.response.parameters.migrate_to_chat_id;
      console.log(`🔄 Group upgraded to Supergroup! Retrying with new ID: ${newChatId}`);
      await bot.telegram.sendMessage(newChatId, alertMessage, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      console.log(`🚀 Alert successfully sent to new Supergroup ID (${newChatId})`);
    } else {
      throw sendErr;
    }
  }
}

// ==========================================
// 5. Telegram Bot Handlers
// ==========================================

bot.start((ctx) => {
  ctx.reply('👋 Hello! I am the Voice Report Tracker Bot.\n\nSend or forward voice messages in this group to transcribe Khmer speech and alert IT Support.');
});

bot.command('help', (ctx) => {
  const helpText = `🛠️ <b>IT Support Help & Guide</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>របៀបរាយការណ៍បញ្ហា (How to Report):</b>\n\n` +
    `🎙️ <b>ផ្ញើសារសំឡេង (Voice Note):</b>\n` +
    `• ចុច icon មេក្រូហ្វូន 🎙️ រួចនិយាយរៀបរាប់ពីបញ្ហាជាភាសាខ្មែរ ឬអង់គ្លេស។\n` +
    `• Bot នឹងបំប្លែងសំឡេងជាអក្សរ និងបញ្ជូនទៅក្រុម IT ដោយស្វ័យប្រវត្តិ។\n\n` +
    `💬 <b>ផ្ញើសារអក្សរ (Text Message):</b>\n` +
    `• សរសេរសាររៀបរាប់ពីបញ្ហាធម្មតានៅក្នុង Group នេះ។\n\n` +
    `⚡ <b>បញ្ជី Commands ផ្សេងៗ:</b>\n` +
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
    `ដើម្បីឱ្យក្រុមការងារ IT ជួយដោះស្រាយបានលឿន សូមបញ្ជាក់ព័ត៌មានដូចខាងក្រោម៖\n\n` +
    `1️⃣ <b>ឧបករណ៍ (Device):</b> កុំព្យូទ័រ / Printer / Internet / Network\n` +
    `2️⃣ <b>បញ្ហាជួបប្រទះ (Issue):</b> បើកមិនចេញ / គាំង / អត់ដើរ...\n` +
    `3️⃣ <b>ទីតាំង (Location):</b> បន្ទប់ / ជាន់ / ផ្នែក\n\n` +
    `👉 <i>អ្នកអាចនិយាយជាសំឡេង 🎙️ ឬវាយជាអក្សរ 💬 ក្នុង Group នេះបានភ្លាមៗ!</i>`;

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
    `• សៅរ៍ (Sat): 8:00 AM - 3:00 PM\n\n` +
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
    `• <b>AI Model:</b> Gemini 3.6 Flash (Khmer & English)\n` +
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
// A. Voice & Audio Message Handler (Khmer & English)
// ----------------------------------------------------
bot.on(['voice', 'audio'], async (ctx) => {
  const message = ctx.message;
  const chat = ctx.chat;
  const fromUser = ctx.from;
  const isVoice = !!message.voice;
  const audioData = message.voice || message.audio;

  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  const { fullName, username, id: userId } = formatUserInfo(fromUser);
  const groupTitle = chat.title || (chat.type === 'private' ? 'Private Message' : 'Group Chat');
  const duration = audioData.duration || 0;
  const fileId = audioData.file_id;
  const messageId = message.message_id;
  const messageLink = getMessageLink(chat, messageId);

  console.log(`🎙️ Received voice report from [${fullName}] in [${groupTitle}] (${formatDuration(duration)})`);

  try {
    await ctx.sendChatAction('typing');
  } catch (err) { }

  let tempFilePath = null;

  try {
    const fileLinkObj = await ctx.telegram.getFileLink(fileId);
    const mimeType = isVoice ? 'audio/ogg' : 'audio/mp3';
    const fileExt = isVoice ? 'ogg' : 'mp3';

    tempFilePath = await downloadTelegramAudio(fileLinkObj.href, fileExt);
    const audioPart = fileToGenerativePart(tempFilePath, mimeType);

    const prompt = `
You are an expert IT Support Assistant and linguist. Analyze this audio message:
1. Detect whether the speaker spoke in Khmer or English.
2. Transcribe the audio word-for-word in its original language.
3. Write a 1-sentence issue summary in the SAME language as the speaker (if Khmer -> summarize in Khmer; if English -> summarize in English).
4. Suggest the Urgency level: "Low", "Medium", or "High".

Return ONLY a valid JSON object matching this schema:
{
  "language": "Khmer" | "English",
  "transcription": "word-for-word transcription in original language",
  "issue_summary": "1-sentence issue summary in the same language",
  "urgency": "Low" | "Medium" | "High"
}
`;

    const result = await geminiModel.generateContent([prompt, audioPart]);
    const responseText = result.response.text();

    let parsed = {
      language: 'Khmer',
      transcription: responseText,
      issue_summary: 'សូមពិនិត្យមើលសារសំឡេងលម្អិត',
      urgency: 'Medium'
    };

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('Could not parse JSON from Gemini response, using raw response');
    }

    console.log(`✅ Gemini Voice Processing Complete:`, parsed);

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Phnom_Penh',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
    const urgencyEmoji = parsed.urgency === 'High' ? '🔴' : parsed.urgency === 'Medium' ? '🟡' : '🟢';

    let alertMessage = `🚨 <b>NEW IT VOICE REPORT (${parsed.language || 'Audio'})</b>\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
    alertMessage += `👤 <b>Reporter:</b> ${fullName} (${username})\n`;
    alertMessage += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    alertMessage += `🏢 <b>Source:</b> ${groupTitle}\n`;
    alertMessage += `⏱️ <b>Duration:</b> ${formatDuration(duration)} | ${urgencyEmoji} <b>Urgency:</b> ${parsed.urgency}\n`;
    alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    if (messageLink) {
      alertMessage += `🔗 <b>Original Message:</b> <a href="${messageLink}">View in Group</a>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (isKhmer) {
      alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${parsed.issue_summary}\n\n`;
      alertMessage += `📝 <b>អត្ថបទសំឡេង (Khmer Transcription):</b>\n`;
      alertMessage += `<i>${parsed.transcription || '(No speech detected)'}</i>\n`;
    } else {
      alertMessage += `📌 <b>Issue Summary:</b>\n${parsed.issue_summary}\n\n`;
      alertMessage += `📝 <b>Voice Transcription:</b>\n`;
      alertMessage += `<i>${parsed.transcription || '(No speech detected)'}</i>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(alertMessage);

    try {
      if (ctx.react) await ctx.react('👍');
    } catch (rErr) { }

  } catch (error) {
    console.error('❌ Error processing voice with Gemini:', error.message || error);

    const errorMessage = `⚠️ <b>VOICE PROCESSING ERROR</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Reporter:</b> ${fullName} (${username})\n` +
      `🏢 <b>Source:</b> ${groupTitle}\n` +
      `❌ <b>Error:</b> <code>${error.message || 'Error occurred during Gemini transcription'}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(errorMessage).catch(() => { });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.promises.unlink(tempFilePath).catch(() => { });
    }
  }
});

// ----------------------------------------------------
// B. Text Message Handler (Khmer & English)
// ----------------------------------------------------
bot.on('text', async (ctx) => {
  const message = ctx.message;
  const userText = (message.text || '').trim();
  const chat = ctx.chat;
  const fromUser = ctx.from;

  // Ignore bot commands (e.g. /start, /getid)
  if (userText.startsWith('/')) return;

  // Filter specific group if configured
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;

  // Avoid processing messages typed inside the IT Group itself
  if (IT_GROUP_ID && chat.id.toString() === IT_GROUP_ID.toString()) return;

  const { fullName, username, id: userId } = formatUserInfo(fromUser);
  const groupTitle = chat.title || (chat.type === 'private' ? 'Private Message' : 'Group Chat');
  const messageId = message.message_id;
  const messageLink = getMessageLink(chat, messageId);

  console.log(`💬 Received text report from [${fullName}] in [${groupTitle}]: "${userText.substring(0, 50)}..."`);

  try {
    await ctx.sendChatAction('typing');
  } catch (err) { }

  try {
    const prompt = `
You are an expert IT Support Assistant and linguist. Analyze this user message:
Message: "${userText}"

1. Detect whether the message is written in Khmer or English.
2. Provide a 1-sentence issue summary in the SAME language (if Khmer -> summary in Khmer; if English -> summary in English).
3. Suggest the Urgency level: "Low", "Medium", or "High".

Return ONLY a valid JSON object matching this schema:
{
  "language": "Khmer" | "English",
  "issue_summary": "1-sentence issue summary in the same language",
  "urgency": "Low" | "Medium" | "High"
}
`;

    const result = await geminiModel.generateContent(prompt);
    const responseText = result.response.text();

    let parsed = {
      language: 'Khmer',
      issue_summary: userText,
      urgency: 'Medium'
    };

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('Could not parse JSON from Gemini response for text, using default');
    }

    console.log(`✅ Gemini Text Processing Complete:`, parsed);

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Phnom_Penh',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    const isKhmer = (parsed.language || '').toLowerCase().includes('khmer');
    const urgencyEmoji = parsed.urgency === 'High' ? '🔴' : parsed.urgency === 'Medium' ? '🟡' : '🟢';

    let alertMessage = `🚨 <b>NEW IT TEXT REPORT (${parsed.language || 'Text'})</b>\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;
    alertMessage += `👤 <b>Reporter:</b> ${fullName} (${username})\n`;
    alertMessage += `🆔 <b>User ID:</b> <code>${userId}</code>\n`;
    alertMessage += `🏢 <b>Source:</b> ${groupTitle}\n`;
    alertMessage += `${urgencyEmoji} <b>Urgency:</b> ${parsed.urgency}\n`;
    alertMessage += `📅 <b>Time:</b> ${timestamp} (GMT+7)\n`;
    if (messageLink) {
      alertMessage += `🔗 <b>Original Message:</b> <a href="${messageLink}">View in Group</a>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━\n`;

    if (isKhmer) {
      alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${parsed.issue_summary}\n\n`;
      alertMessage += `💬 <b>អត្ថបទសារ (Message Content):</b>\n`;
      alertMessage += `<i>${userText}</i>\n`;
    } else {
      alertMessage += `📌 <b>Issue Summary:</b>\n${parsed.issue_summary}\n\n`;
      alertMessage += `💬 <b>Message Content:</b>\n`;
      alertMessage += `<i>${userText}</i>\n`;
    }
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    await sendToITGroup(alertMessage);

    try {
      if (ctx.react) await ctx.react('👍');
    } catch (rErr) { }

  } catch (error) {
    console.error('❌ Error processing text with Gemini:', error.message || error);
  }
});

bot.catch((err, ctx) => {
  console.error(`❌ Telegraf uncaught error:`, err);
});

bot.launch()
  .then(() => console.log('🤖 Telegram Voice & Text Tracker Bot (Google Gemini) is successfully running!'))
  .catch((err) => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
