# Telegram Voice Tracker with Google Gemini AI 🎙️✨

A Node.js backend using **Google Gemini 1.5 Flash** to:
1. Transcribe Khmer voice messages directly from Telegram groups.
2. Summarize the IT problem in Khmer.
3. Automatically determine the urgency level (🟢 Low, 🟡 Medium, 🔴 High).
4. Forward the ticket directly to your IT Support Telegram Group.

---

## 🚀 How to Run Locally

### 1. Configure `.env`
Edit `gemini_bot/.env`:
```env
BOT_TOKEN=8651357401:AAEy0ZVxabhvul67WaJZiDv7vOpTrlR5UqE
GEMINI_API_KEY=your_gemini_api_key_here
IT_GROUP_ID=your_it_support_group_id
PORT=3000
```

> **Get a free Gemini API Key**: Visit [Google AI Studio](https://aistudio.google.com/app/apikey) and click **Create API Key**.

### 2. Start the Bot
```bash
cd gemini_bot
npm run dev
```
