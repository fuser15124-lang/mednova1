# MedNova AI — Cloudflare Workers + Static Assets

این نسخه برای استقرار رایگان در Cloudflare طراحی شده است: رابط کاربری موجود در `public/` و API در `src/index.js` اجرا می‌شوند. API از Groq استفاده می‌کند و اطلاعات کاربران، گفتگوها و اسناد متنی را در Cloudflare D1 ذخیره می‌کند.

> **مهم درباره کلید قبلی:** به درخواست شما، کلید قدیمی فقط در فایل محلی `.dev.vars` حفظ شده تا بتوانید خودتان آن را عوض کنید. این فایل در `.gitignore` قرار دارد و در دارایی‌های عمومی منتشر نمی‌شود. فایل `.dev.vars` را در GitHub بارگذاری نکنید. برای محیط آنلاین، کلید را به‌صورت Secret در Cloudflare تنظیم کنید. اگر کلید قبلی قبلاً عمومی شده، هر زمان آماده بودید آن را در Groq باطل و تعویض کنید.

## امکانات این نسخه
- رابط کاربری MedNova فعلی با زبان‌های فارسی، انگلیسی، اسپانیایی، ایتالیایی، روسی و عبری
- ثبت‌نام و ورود با هش رمز عبور PBKDF2 و توکن امضاشده
- چت پزشکی از طریق Groq API؛ کلید فقط در سمت سرور
- جست‌وجوی PubMed
- ذخیره گفتگوها و اسناد متنی در D1
- پیام خطای واضح‌تر برای خطای 401 و سهمیه 429

## محدودیت‌های شناخته‌شده
- در این نسخه، بارگذاری اسناد فقط برای فایل‌های UTF-8 `.txt` فعال است؛ استخراج متن PDF در نسخه Cloudflare هنوز پیاده‌سازی نشده است.
- این برنامه ابزار آموزشی است، نه وسیله تشخیص پزشکی. اطلاعات هویتی یا داده‌های قابل‌شناسایی بیمار را وارد نکنید.
- برای استفاده واقعی، محدودیت نرخ درخواست، بازیابی حساب، سیاست حفظ حریم خصوصی و بررسی امنیتی مستقل لازم است. این پروژه به‌تنهایی گواهی یا اعتبارسنجی بالینی ندارد.

## استقرار روی Cloudflare

### 1) ساخت D1
1. وارد داشبورد Cloudflare شوید.
2. از **Workers & Pages → D1 SQL Database** یک دیتابیس با نام `mednova-ai-db` بسازید.
3. شناسه دیتابیس (Database ID) را کپی کنید.
4. در `wrangler.jsonc` مقدار `REPLACE_WITH_YOUR_D1_DATABASE_ID` را با شناسه واقعی جایگزین کنید.

یا با CLI (Node.js نصب باشد):
```bash
npm install
npx wrangler login
npx wrangler d1 create mednova-ai-db
```
اگر CLI شناسه را نمایش داد، آن را در `wrangler.jsonc` قرار دهید.

### 2) ساخت جداول
از پوشه پروژه اجرا کنید:
```bash
npm run db:migrate:remote
```
این دستور جداول کاربران، گفتگوها، پیام‌ها و اسناد را در D1 ایجاد می‌کند. اگر دستور با خطای شناسه مواجه شد، ابتدا `wrangler.jsonc` را اصلاح کنید.

### 3) تنظیم Secrets
در ترمینال:
```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put JWT_SECRET
```
برای `GROQ_API_KEY` کلید Groq را وارد کنید. برای `JWT_SECRET` یک رشته تصادفی طولانی و منحصربه‌فرد بگذارید. این مقادیر را در کد یا `public/` قرار ندهید.

همین کار را می‌توانید در Cloudflare Dashboard → Worker → Settings → Variables and Secrets انجام دهید و هر دو را به‌عنوان **Secret** اضافه کنید.

### 4) استقرار
```bash
npm install
npm run deploy
```
پس از استقرار، Cloudflare یک آدرس `workers.dev` می‌دهد. صفحه را باز کنید، حساب بسازید و چت را آزمایش کنید.

### 5) تنظیم کلید Groq و مدل
- API Base URL در Worker به `https://api.groq.com/openai/v1/chat/completions` تنظیم شده است.
- مدل پیش‌فرض `llama-3.3-70b-versatile` است. اگر Groq در حساب شما این مدل را ارائه نمی‌کند، مقدار `GROQ_MODEL` را در `wrangler.jsonc` به یک مدل پشتیبانی‌شده تغییر دهید و دوباره deploy کنید.
- کلید API را در JavaScript مرورگر قرار ندهید.

## اجرای محلی
نیازمند Node.js:
```bash
npm install
npx wrangler d1 execute mednova-ai-db --local --file=./schema.sql
npm run dev
```
فایل `.dev.vars` برای اجرای محلی وجود دارد؛ آن را در GitHub commit نکنید. `JWT_SECRET` محلی را پیش از استفاده واقعی با مقدار تصادفی جایگزین کنید.

## اگر خطای 401 دریافت کردید
1. در Cloudflare Worker → Settings → Variables and Secrets بررسی کنید که `GROQ_API_KEY` به‌عنوان Secret تعریف شده باشد.
2. کلید باید متعلق به Groq باشد و از داشبورد Groq ساخته شده باشد.
3. پس از تغییر Secret، دوباره درخواست چت را آزمایش کنید.
4. اگر خطای 429 بود، سهمیه و محدودیت حساب Groq را بررسی کنید.

## منابع رسمی
- Cloudflare Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Groq OpenAI compatibility: https://console.groq.com/docs/openai
