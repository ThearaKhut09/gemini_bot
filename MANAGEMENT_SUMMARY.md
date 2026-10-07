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

### 2.1 Detailed reporting flow

**Flow A — Report in the group (voice / photo / text):**

1. The employee sends a voice message, photo, or text in the monitored group. The bot immediately shows a ✍️ reaction so the employee knows it was heard.
2. The bot **waits 8 seconds and bundles everything** the same person sends — e.g. a voice note *plus* a screenshot *plus* a follow-up text all become **one ticket**, not three.
3. The AI checks the content:
   - **Just a greeting or small talk** → the bot replies politely in the group. No ticket is created, IT is not disturbed.
   - **A real problem** → the AI transcribes the voice (Khmer or English), rewrites the issue clearly, estimates urgency (🟢 Low / 🟡 Medium / 🔴 High), and reads error codes from photos (OCR).
4. The bot sends **one structured ticket** to the IT support group: reporter, time, source, urgency, issue summary, original transcription/text, suggested first troubleshooting step, and the attached screenshots.
5. If any step fails (network, AI unavailable), IT receives an **error alert** — a report is never silently lost.

**Flow B — Report through the Mini App:**

1. The employee opens the app (menu button in the bot chat, pinned message in a group, 📎 menu, or the `/app` command).
2. They fill a short form: describe the issue, pick the urgency, optionally attach a photo.
3. The bot verifies the employee's Telegram identity, formats the same structured ticket, and delivers it to the IT group.
4. The employee instantly sees "✅ sent" and their list of previous reports inside the app.

**Flow C — Automatic security protection (always active):**

1. Someone posts a dangerous file type (.exe, .bat, .zip, etc.) in the group.
2. The bot **deletes it immediately**, posts a Khmer warning in the group, and sends a security alert to IT (who sent it, what file, when).
3. No AI is involved — this protection runs even if the AI service is down.

### 2.2 What happens after the ticket

The bot's job ends at delivery. The IT team reads the ticket in the IT group and handles the problem as usual — nothing is automated beyond that, so existing IT workflows stay unchanged.

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

### 4.1 Optional extension: permanent storage, backup and reuse

Today no database exists (by design — simplest and cheapest). If the company wants to keep every ticket permanently, a **small database can be added without rebuilding anything** — the bot already sends every ticket through one central point, so saving a copy there is a small change.

**What would be stored (one record per ticket):**

- Ticket ID, date & time, reporter, source (group or Mini App)
- Urgency level, issue summary, original transcription/text
- Status (open / resolved) and resolution notes filled by IT

**Where it would live:** a small managed cloud database (free tiers — e.g. Supabase, Turso — are enough for **years** of tickets) or a folder on the company's own server if preferred.

**Backup:** yes, easily.

- Daily automated backups (built into managed database services), plus manual export to **CSV/Excel at any time**
- The company owns the data outright — it can be moved to another provider or server whenever wanted (standard formats, no lock-in)
- A retention rule can be set (e.g. keep 12 months, then archive or delete) to match company policy

**How the stored data can be reused:**

1. **Ticket history** — employees see their past reports with real status (open/resolved) in the Mini App; IT sees the full history of any device or user.
2. **Monthly IT statistics** — number of tickets, breakdown by urgency, common problem types, busiest days, average resolution time — useful for management reporting and planning.
3. **Faster solutions** — when a new ticket matches a previously solved one, the AI can suggest the earlier solution to IT (a growing knowledge base built from the company's own history).
4. **Audit trail** — a verified record of what was reported, when, by whom, and how it was resolved.

**Cost of this extension:** a ticket record is tiny (~1–2 KB), so even 1,000 tickets per month take years to fill a free database. Realistic monthly pricing (approximate — providers adjust prices):

| Option | What it includes | ~Cost / month |
|---|---|---|
| Free database tiers (Supabase / Neon / Turso) | 0.5–10 GB — enough for years of tickets | **$0** |
| Render Postgres (basic, hosted next to the bot) | Small managed database, simple setup | ~$6–7 |
| Supabase Pro (business package) | 8 GB database + 100 GB file storage + automatic daily backups + support | ~$25 |
| Cloudflare R2 (only if archiving ticket photos) | 10 GB free, then ~$0.015/GB | $0–2 at this volume |

What paid storage buys is not space (it will never fill up at this volume) — it is **automatic backups, uptime guarantees and support**.

**Recommended option for us:** **Supabase** — one service provides both the database (ticket records) and file storage (voice/photo copies), free tier to start, Pro tier (~$25/month) when guaranteed backups are wanted. Note that text records go in the database while voice/photo files go to file storage — the two are linked by ticket ID. With ~50 reports/day (voice + photo each), data grows ~65 MB/month, so the free tier lasts roughly a year and the paid tier effectively forever.

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
3. **Add a small database** to keep permanent ticket history and enable monthly IT statistics (see section 4.1 — backup, export, and reuse options).
4. **Control group membership** — the bot reports from whatever group it monitors; manage who is in that group like any company channel.
5. **Back up the bot configuration** (the environment variables) — the whole system can be restored on any server in minutes from the Git repository.
