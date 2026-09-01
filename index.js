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
    service: 'Telegram Khmer Voice Tracker Bot (Google Gemini AI)',
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

// ==========================================
// 5. Telegram Bot Handlers
// ==========================================

bot.start((ctx) => {
  ctx.reply('👋 Hello! I am the Voice Report Tracker Bot powered by Google Gemini AI.\n\nSend or forward voice messages in this group to transcribe Khmer speech and alert IT Support.');
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

bot.on(['voice', 'audio'], async (ctx) => {
  const message = ctx.message;
  const chat = ctx.chat;
  const fromUser = ctx.from;
  const isVoice = !!message.voice;
  const audioData = message.voice || message.audio;

  // Filter specific group if configured
  if (MONITORED_GROUP_ID && chat.id.toString() !== MONITORED_GROUP_ID.toString()) return;

  // Avoid processing alerts sent inside the IT Group itself
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
    // 1. Fetch file URL from Telegram
    const fileLinkObj = await ctx.telegram.getFileLink(fileId);
    const mimeType = isVoice ? 'audio/ogg' : 'audio/mp3';
    const fileExt = isVoice ? 'ogg' : 'mp3';

    // 2. Download audio file
    tempFilePath = await downloadTelegramAudio(fileLinkObj.href, fileExt);

    // 3. Prepare payload for Gemini API
    const audioPart = fileToGenerativePart(tempFilePath, mimeType);

    const prompt = `
You are an expert IT Support Assistant and linguist. Analyze this voice audio message (spoken in Khmer or English):
1. Provide the exact word-for-word Khmer transcription.
2. Provide a 1-sentence summary in Khmer describing the technical issue reported.
3. Suggest the Urgency level: "Low", "Medium", or "High".

Return ONLY a valid JSON object in this format without markdown code blocks:
{
  "transcription": "អត្ថបទស្តាប់បានជាភាសាខ្មែរ...",
  "issue_summary": "សង្ខេបបញ្ហាបច្ចេកទេស...",
  "urgency": "High"
}
`;

    // 4. Send to Gemini
    const result = await geminiModel.generateContent([prompt, audioPart]);
    const responseText = result.response.text();

    let parsed = {
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

    console.log(`✅ Gemini Processing Complete:`, parsed);

    // 5. Build Formatted HTML Alert
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Phnom_Penh',
      dateStyle: 'medium',
      timeStyle: 'medium'
    });

    const urgencyEmoji = parsed.urgency === 'High' ? '🔴' : parsed.urgency === 'Medium' ? '🟡' : '🟢';

    let alertMessage = `🚨 <b>NEW IT VOICE REPORT</b>\n`;
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
    alertMessage += `📌 <b>សង្ខេបបញ្ហា (Issue Summary):</b>\n${parsed.issue_summary}\n\n`;
    alertMessage += `📝 <b>អត្ថបទសំឡេង (Khmer Transcription):</b>\n`;
    alertMessage += `<i>${parsed.transcription || '(No speech detected)'}</i>\n`;
    alertMessage += `━━━━━━━━━━━━━━━━━━━━━`;

    // 6. Forward to IT Support Group
    if (IT_GROUP_ID) {
      try {
        await bot.telegram.sendMessage(IT_GROUP_ID, alertMessage, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        console.log(`🚀 Alert successfully forwarded to IT Group (${IT_GROUP_ID})`);
      } catch (sendErr) {
        // If the group was upgraded to supergroup, Telegram provides the new ID
        if (sendErr.response?.parameters?.migrate_to_chat_id) {
          const newChatId = sendErr.response.parameters.migrate_to_chat_id;
          console.log(`🔄 Group was upgraded to Supergroup! Retrying with new ID: ${newChatId}`);
          await bot.telegram.sendMessage(newChatId, alertMessage, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
          console.log(`🚀 Alert successfully sent to new Supergroup ID (${newChatId})`);
          console.log(`💡 Please update IT_GROUP_ID=${newChatId} in your .env file!`);
        } else {
          throw sendErr;
        }
      }
    }

    // Acknowledge in original chat
    try {
      if (ctx.react) await ctx.react('👍');
    } catch (rErr) { }

  } catch (error) {
    console.error('❌ Error processing voice with Gemini:', error.message || error);

    if (IT_GROUP_ID) {
      const errorMessage = `⚠️ <b>VOICE PROCESSING ERROR</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Reporter:</b> ${fullName} (${username})\n` +
        `🏢 <b>Source:</b> ${groupTitle}\n` +
        `❌ <b>Error:</b> <code>${error.message || 'Error occurred during Gemini transcription'}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━`;

      await bot.telegram.sendMessage(IT_GROUP_ID, errorMessage, { parse_mode: 'HTML' }).catch(() => { });
    }
  } finally {
    // 7. Cleanup temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.promises.unlink(tempFilePath).catch(() => { });
    }
  }
});

bot.catch((err, ctx) => {
  console.error(`❌ Telegraf uncaught error:`, err);
});

bot.launch()
  .then(() => console.log('🤖 Telegram Voice Tracker Bot (Google Gemini) is successfully running!'))
  .catch((err) => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); server.close(); });
