# פריסה: מהקוד הזה עד הבוט על pingwin.co.il

GTM הוא הצעד האחרון ולוקח חמש דקות. לפניו צריך שהבוט ירוץ על שרת עם כתובת
HTTPS קבועה — GTM רק מזריק שורת סקריפט לדף, הוא לא מריץ שרתים.

```
[הקוד ב-GitHub] → (1) שרת עם HTTPS → (2) .env → (3) בדיקה → (4) תג ב-GTM → (5) GA4 → (6) פיילוט
```

---

## 1. שרת

צריך מקום שמריץ Node 18+ ברציפות. שלוש אפשרויות, מהקלה ליקרה בזמן:

| איפה | מתאים כש | איך |
|---|---|---|
| **Railway / Render** | אין לכם sysadmin — הכי מהיר | מחברים את ריפו GitHub, הם בונים ומריצים `npm start` לבד, HTTPS אוטומטי |
| **VPS** (Hetzner/DigitalOcean) | רוצים שליטה מלאה | `git clone`, `npm ci`, `pm2 start server/server.js`, nginx + certbot |
| **שרת קיים של פינגווין** | כבר יש תשתית | אותו דבר, מול מי שמנהל אותה |

בכל מקרה: תת-דומיין ייעודי, למשל `bot.pingwin.co.il` (רשומת DNS מסוג A/CNAME
לשרת). מומלץ מאחורי Cloudflare — אז גם `TRUST_PROXY=1` ב-.env.

הפעלה מחדש אחרי עדכון: `git pull && npm ci && pm2 restart` (או deploy אוטומטי
ב-Railway/Render בכל push).

## 2. `.env` בשרת

```bash
PORT=8787
ALLOWED_ORIGINS=https://www.pingwin.co.il,https://pingwin.co.il   # חובה בפרודקשן
TRUST_PROXY=1                     # רק אם מאחורי Cloudflare/nginx

OPENAI_API_KEY=sk-...             # אופציונלי: בלי מפתח הבוט עובד במצב offline
OPENAI_MODEL=gpt-5.6-luna
DAILY_BUDGET_USD=5                # מעל זה ממשיך לענות בחינם עד חצות

TURNSTILE_SITEKEY=0x...           # אופציונלי, חינם — חוסם בוטים
TURNSTILE_SECRET=0x...
LEAD_WEBHOOK_URL=https://...      # אופציונלי: לידים למערכת של פינגווין
LEAD_WEBHOOK_SECRET=...
```

## 3. בדיקה לפני GTM

```
https://bot.pingwin.co.il/healthz     → {"ok":true,"mode":"openai","version":"0.2.0"}
https://bot.pingwin.co.il/            → דף הדמו עם הווידג'ט
```
אם `/healthz` לא עונה — אין טעם להמשיך ל-GTM.

## 4. התג ב-GTM

1. GTM → **Tags → New → Tag Configuration → Custom HTML**
2. להדביק את בלוק ה-`<script>` מתוך `public/gtm-tag.html`
3. להחליף `BOT_HOST` ל-`https://bot.pingwin.co.il` ולוודא ש-`BOT_VERSION`
   תואם ל-`version` שמופיע ב-`/healthz`
4. **"Support document.write" — לא מסומן**
5. Triggering → **All Pages** (לפיילוט: טריגר Page View עם תנאי URL contains
   על עמוד אחד בלבד)
6. שם התג: `Pingwin Ski Bot` → **Save**
7. **Preview** — נכנסים לאתר דרך חלון ה-preview, מוודאים שהבועה מופיעה ושיחה
   שלמה עובדת → **Submit → Publish**

בכל פריסה עתידית של הווידג'ט: להעלות `BOT_VERSION` בתג ולפרסם מחדש — כך
דפדפנים לא מגישים גרסה ישנה מה-cache.

## 5. GA4 (אופציונלי, מומלץ)

הווידג'ט דוחף אירוע אחד ל-dataLayer, בלי שום מידע אישי:

```js
{ event: 'pw_bot', pw_action: 'open' | 'message' | 'offers' | 'lead' | 'error',
  pw_turn, pw_count, pw_kind, pw_first, pw_has_offer, pw_where }
```

ב-GTM: **Variables** → Data Layer Variables בשם `pw_action`, `pw_count`,
`pw_kind` → **Trigger** → Custom Event בשם `pw_bot` → **Tag** → GA4 Event,
Event Name `{{pw_action}}`, פרמטרים לפי המשתנים. כך רואים בדוחות כמה נפתחו,
כמה קיבלו הצעות וכמה השאירו ליד.

## 6. פיילוט

עמוד אחד (למשל דף יעד אחד) לשבוע. מה בודקים: `npm run review` על הלוג —
כמה תורות לא הובנו ומי ענה על השאר; `server-data/leads.jsonl` — האם לידים
נכנסים; GA4 — יחס פתיחות→לידים. מה שנופל חוזר אלינו כתשובה ב-FAQ או בבדיקה,
ורק אז פותחים לכל האתר.

---

## תקלות נפוצות

| מה רואים | למה | מה עושים |
|---|---|---|
| הבועה לא מופיעה | התג לא פורסם, או הטריגר לא חל על העמוד | GTM Preview → לראות אם התג נורה |
| הבועה מופיעה, השיחה נכשלת | `ALLOWED_ORIGINS` לא כולל את הדומיין המדויק (עם/בלי www) | לתקן ב-.env ולהפעיל מחדש |
| גרסה ישנה של הווידג'ט | cache | להעלות `BOT_VERSION` בתג ולפרסם |
| "קיבלנו הרבה הודעות ברצף" | rate limit | להעלות `RATE_CHAT_PER_MIN`, או `TRUST_PROXY=1` אם כל הגולשים נראים כ-IP אחד |
| הבוט עונה בלי LLM | אין `OPENAI_API_KEY`, או שהתקציב היומי נגמר | `/healthz` מציג `mode` |
