# IT Support Telegram Bot & Mini App — Management Summary

**Prepared:** October 2026 · **Status:** Live in production (Render free tier)

---

## 1. What the system does

The system lets employees report IT problems in two ways, and delivers every report to the IT support team as a structured ticket:

1. **Group reporting** — the employee sends a **voice message (Khmer or English), photo, or text** in the company Telegram group. The bot automatically transcribes the voice, understands the problem, rewrites it clearly, and forwards a formatted ticket to the IT support group.
2. **Mini App** — the employee opens the **IT Support app inside Telegram** (button in the bot chat, pinned in groups, or the 📎 menu) and fills a short form: issue description, urgency level (Low/Medium/High), and an optional photo. The ticket arrives in the IT group in the same format.

Both channels produce the **same ticket**, containing: reporter name, time, source, urgency (🟢/🟡/🔴 with AI-estimated priority), issue summary, voice transcription, and suggested first troubleshooting step.

Extra built-in protection: the bot **automatically deletes dangerous file types** (.exe, .bat, .zip, etc.) posted in the group and sends a security alert to IT — basic anti-scam/anti-malware protection for staff.

## 2. How it works (simplified)

```
Employee (voice 🎙️ / photo 📸 / text 💬 in group, or Mini App form)
        │
        ▼
Telegram Bot (24/7, hosted on Render.com)
        │  sends audio/photo/text to AI for:
        │   • Khmer/English transcription
        │   • problem detection & clear rewrite
        │   • urgency estimation
        ▼
IT Support Group receives ONE structured ticket
```

- Voice transcription and analysis use **Google Gemini AI** (with OpenAI as automatic backup engine).
- The AI is used only to **process** the report — it does not answer employees or make decisions; the IT team stays in full control of what happens next.

## 3. Control

| Area | How it is controlled |
|---|---|
| Which group is monitored | Set once in configuration (`MONITORED_GROUP_ID`) — the bot ignores all other chats |
| Where tickets go | Fixed to the IT support group (`IT_GROUP_ID`) — only IT members see tickets |
| Who can report | Anyone in the monitored group / anyone opening the Mini App (identified by their Telegram account) |
| Bot permissions in groups | Only needs **Admin** rights to delete dangerous files and pin the app message; reporting itself needs no rights |
| Security | Mini App requests are cryptographically verified (Telegram `initData`); user content is escaped to prevent message injection; dangerous files auto-deleted with an IT alert |
| Configuration | All settings live in private environment variables on the server — not visible to employees; only the administrator who manages the server can change them |

## 4. Data — what is recorded, where it is kept, can it be reused

| Data | Where it is kept | Who can see it | Retention | Reused? |
|---|---|---|---|---|
| Group messages (voice, photos, text) | **Telegram cloud** (like any normal chat message) | Group members | Until deleted in Telegram | Governed by Telegram's terms |
| Voice & images sent for analysis | **Processed by Google Gemini** (OpenAI only as fallback) | Google (one-time processing) | Not stored on our server — temporary files are deleted seconds after processing | ⚠️ On the **free Gemini tier**, Google may use submitted data to improve its products. If this is a concern, upgrade to the paid API tier, where data is not used for training |
| Ticket text sent to IT group | **Telegram cloud** (IT group) | IT support team members | Until deleted | Searchable in Telegram at any time |
| Mini App tickets | Small file on the Render server (`data/tickets.json`) | IT team (via the app's "My tickets") | **Temporary** — resets when the server restarts/redeploys (free hosting has no permanent disk) | Currently display-only; can be exported |
| Employee identity | Telegram account name/ID attached to tickets | IT team | Same as ticket | Used only to know who reported |

**Summary:** the system deliberately stores **almost nothing itself** — reports live in Telegram (which the company already uses), and only the small Mini App ticket list sits on the server temporarily. The AI providers receive the content **once, to process it**, under their API terms.

**Reusing the data later (if wanted):** today there is no database, so there is no ticket history, statistics, or SLA reporting. The system is designed so a small database can be added later (free options exist) to keep every ticket permanently and produce monthly reports (e.g., number of tickets per department, common problems, response times). This is an extension, not a rebuild.

## 5. Costs

| Item | Current cost | Notes / upgrade path |
|---|---|---|
| Telegram Bot API | **$0** | Free for unlimited use |
| Hosting (Render.com) | **$0** (free tier) | Limitations: sleeps when idle (solved with a free keep-alive ping), server disk is temporary, no uptime guarantee. Upgrade ~**$7/month** for always-on with permanent disk |
| AI (Google Gemini API) | **$0** (free tier) | Enough capacity for hundreds of tickets/month. Paid tier is pay-per-use (a ticket costs a fraction of a cent) and comes with stronger data-guarantee terms |
| Mini App URL | **$0** | Uses Render's free `*.onrender.com` address; a company domain (optional, more professional) costs ~**$10–15/year** |
| Data storage | **$0** | Nothing persistent is stored today. If ticket history/analytics is wanted: free database tiers are sufficient for years of tickets |

**Total current cost: $0/month.** A realistic comfortable production setup (always-on hosting + custom domain + paid AI tier) would be roughly **$10–15/month**.

## 6. Recommendations before wider company rollout

1. **Custom domain** for the Mini App (professional appearance, stable URL).
2. **Decide the AI data policy** — if reports may contain sensitive business information, use the paid Gemini tier (data not used for training) or a self-hosted model later.
3. **Add a small database** to keep permanent ticket history and enable monthly IT statistics.
4. **Control group membership** — the bot reports from whatever group it monitors; manage who is in that group like any company channel.
5. **Back up the bot configuration** (the environment variables) — the whole system can be restored on any server in minutes from the Git repository.
