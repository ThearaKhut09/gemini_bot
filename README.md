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
BOT_TOKEN=
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

---

## 📱 Telegram Mini App

An optional web app served by the same process at `/app` — employees can report IT issues
with a form (text + urgency + photo) instead of typing in the group. Tickets arrive in the
IT group in the same format as group reports.

- **Page:** `http://localhost:3000/app` (served by the bot's Express server)
- **API:** `POST /api/tickets`, `GET /api/tickets` — authenticated via Telegram `initData`
- **Setup:** set `MINIAPP_URL` in `.env` (must be HTTPS — use a tunnel like `ngrok`/`cloudflared`
  for local testing), then register the URL in @BotFather via `/newapp` or `/setmenubutton`
- **Dev mode:** set `MINIAPP_DEV_MODE=1` (and keep `NODE_ENV` unset) to test the form in a
  normal browser as a fake user. **Never enable in production.**
- Tickets are stored locally in `data/tickets.json` (git-ignored).

---

## ☁️ Deploy to Render (free)

The repo includes a [render.yaml](render.yaml) blueprint that deploys the bot + mini app as one web service.

1. `git push` so GitHub has the latest code.
2. [render.com](https://render.com) → sign in with GitHub → **New + → Blueprint** → select this repo.
3. Fill in the prompted values (copy from your local `.env`): `BOT_TOKEN`, `GEMINI_API_KEY`, `IT_GROUP_ID`, `MONITORED_GROUP_ID`, `IT_SUPPORT_USERNAME`. Leave `OPENAI_API_KEY` empty if unused, and **never set `MINIAPP_DEV_MODE`**.
4. After deploy, set `MINIAPP_URL` to `https://<your-service>.onrender.com/app` (Environment tab — the service restarts automatically), then register that URL in @BotFather via `/newapp` or `/setmenubutton`.
5. Keep-alive: the free plan sleeps after 15 min without HTTP traffic. Add a free [UptimeRobot](https://uptimerobot.com) monitor pinging `https://<your-service>.onrender.com/health` every 5 minutes.

Notes: the free plan gives ~750 instance-hours/month (enough for one always-on service); the disk is ephemeral so `data/tickets.json` resets on restart/redeploy; every `git push` auto-deploys.
