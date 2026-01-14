# 🚀 Complete Setup Guide - Free Tier Deployment

Deploy WhatsApp Multi-Automation for **FREE** using:
- **Render** (Free Web Service)
- **Supabase** (Free PostgreSQL Database)
- **UptimeRobot** (Free Uptime Monitoring - keeps your app awake 24/7)

**Total Cost: $0/month** | **Uptime: 100%** | **Setup Time: ~15 minutes**

---

## 📋 Table of Contents

1. [Prerequisites](#-prerequisites)
2. [Step 1: Fork the Repository](#-step-1-fork-the-repository)
3. [Step 2: Setup Supabase Database](#-step-2-setup-supabase-database)
4. [Step 3: Deploy to Render](#-step-3-deploy-to-render)
5. [Step 4: Configure UptimeRobot](#-step-4-configure-uptimerobot-100-uptime)
6. [Step 5: First Login & Setup](#-step-5-first-login--setup)
7. [Troubleshooting](#-troubleshooting)
8. [Environment Variables Reference](#-environment-variables-reference)

---

## 📝 Prerequisites

Before starting, make sure you have:

- [ ] GitHub account ([sign up free](https://github.com/signup))
- [ ] Supabase account ([sign up free](https://supabase.com))
- [ ] Render account ([sign up free](https://render.com))
- [ ] UptimeRobot account ([sign up free](https://uptimerobot.com))
- [ ] A phone with WhatsApp installed (for QR code scanning)

---

## 📦 Step 1: Fork the Repository

1. Go to the repository: **[github.com/mohit2777/whatsapp-api-free](https://github.com/mohit2777/whatsapp-api-free)**

2. Click the **"Fork"** button (top right)

3. Select your GitHub account

4. Wait for the fork to complete

✅ You now have your own copy of the code!

---

## 🗄️ Step 2: Setup Supabase Database

### 2.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in

2. Click **"New Project"**

3. Fill in the details:
   - **Name:** `whatsapp-automation` (or any name)
   - **Database Password:** Generate a strong password and **SAVE IT** (you'll need it later)
   - **Region:** Choose closest to your users
   - **Plan:** Free tier

4. Click **"Create new project"** and wait ~2 minutes for setup

### 2.2 Get Your API Keys

1. In your project, go to **Settings** → **API**

2. Copy these values (you'll need them for Render):

   | Key | Where to find |
   |-----|---------------|
   | **Project URL** | Under "Project URL" (looks like `https://xxxxx.supabase.co`) |
   | **anon public** | Under "Project API keys" → "anon public" |
   | **service_role** | Under "Project API keys" → "service_role" (click "Reveal") |

3. Go to **Settings** → **Database**

4. Scroll to **"Connection string"** → **"URI"** tab

5. Copy the connection string. It looks like:
   ```
   postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
   
6. Replace `[YOUR-PASSWORD]` with your actual database password

### 2.3 Create Database Tables

1. Go to **SQL Editor** (left sidebar)

2. Click **"New Query"**

3. Copy and paste the entire contents of `schema.sql` from the repository

4. Click **"Run"** (or press Ctrl+Enter)

5. You should see "Success. No rows returned" - this is correct!

✅ Database is ready!

---

## 🌐 Step 3: Deploy to Render

### 3.1 Create Web Service

1. Go to [render.com](https://render.com) and sign in

2. Click **"New +"** → **"Web Service"**

3. Connect your GitHub account if not already connected

4. Find and select your forked repository: `your-username/lightweight-optimised-we.js`

5. Configure the service:

   | Setting | Value |
   |---------|-------|
   | **Name** | `whatsapp-api` (or any name) |
   | **Region** | Choose closest to your Supabase region |
   | **Branch** | `main` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `node index.js` |
   | **Instance Type** | **Free** |

### 3.2 Add Environment Variables

Scroll down to **"Environment Variables"** and add these:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` (your Project URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service_role key |
| `DATABASE_URL` | Your PostgreSQL connection string |
| `DASHBOARD_USERNAME` | `admin` (or choose your own) |
| `DASHBOARD_PASSWORD` | Choose a strong password |
| `SESSION_SECRET` | Generate random string (use: `openssl rand -hex 32`) |
| `SESSION_COOKIE_SECURE` | `true` |

**Optional AI Chatbot Keys** (add if you want AI features):
| Key | Value |
|-----|-------|
| `GEMINI_API_KEY` | Your Google AI API key |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `GROQ_API_KEY` | Your Groq API key |

### 3.3 Deploy

1. Click **"Create Web Service"**

2. Wait for the build to complete (takes 2-5 minutes)

3. Once deployed, you'll see a URL like: `https://whatsapp-api-xxxx.onrender.com`

4. **Copy this URL** - you'll need it for UptimeRobot

5. Click the URL to verify it's working. You should see the login page!

✅ App is deployed!

---

## ⏰ Step 4: Configure UptimeRobot (100% Uptime)

**Why?** Render free tier spins down after 15 minutes of inactivity. UptimeRobot pings your app every 5 minutes to keep it awake 24/7.

### 4.1 Setup UptimeRobot

1. Go to [uptimerobot.com](https://uptimerobot.com) and sign in

2. Click **"Add New Monitor"**

3. Configure:

   | Setting | Value |
   |---------|-------|
   | **Monitor Type** | HTTP(s) |
   | **Friendly Name** | `WhatsApp API` |
   | **URL** | `https://your-render-url.onrender.com/ping` |
   | **Monitoring Interval** | 5 minutes |

4. Click **"Create Monitor"**

### 4.2 Verify It's Working

1. Wait 5 minutes

2. Check the monitor status - it should show **"Up"**

3. The `/ping` endpoint returns `pong` which UptimeRobot recognizes as healthy

✅ Your app will now stay awake 24/7!

---

## 🎉 Step 5: First Login & Setup

### 5.1 Access the Dashboard

1. Go to your Render URL: `https://your-app.onrender.com`

2. Login with:
   - **Username:** The value you set for `DASHBOARD_USERNAME`
   - **Password:** The value you set for `DASHBOARD_PASSWORD`

### 5.2 Create Your First WhatsApp Account

1. Click **"+ Add Account"**

2. Enter a name (e.g., "My WhatsApp")

3. Click **"Create"**

4. A QR code will appear

5. On your phone:
   - Open WhatsApp
   - Go to **Settings** → **Linked Devices** → **Link a Device**
   - Scan the QR code

6. Wait for connection (status changes from "QR Ready" → "Ready")

✅ Your WhatsApp is now connected!

### 5.3 Setup Webhooks (Optional)

To receive incoming messages on your server/n8n:

1. Click the **webhook icon** (plug) on your account

2. Click **"Add Webhook"**

3. Enter your webhook URL (e.g., n8n webhook URL)

4. Select events:
   - **Messages** - Receive incoming messages
   - **Receipts** - Receive read/delivered notifications

5. (Optional) Add a secret for signature verification

6. Click **"Add Webhook"**

### 5.4 Setup AI Chatbot (Optional)

1. Click the **robot icon** on your account

2. Toggle **"Enable AI Chatbot"**

3. Select provider:
   - **Gemini** (Free tier available!)
   - **Groq** (Free tier available!)
   - **OpenAI**
   - **Anthropic**

4. Enter your API key

5. Customize the system prompt

6. Click **"Save Configuration"**

✅ Setup complete!

---

## 🔧 Troubleshooting

### "Application Error" on Render

1. Check Render logs: **Dashboard** → **Your Service** → **Logs**
2. Common issues:
   - Missing environment variables
   - Invalid database connection string
   - Database tables not created

### QR Code Not Appearing

1. Wait 30 seconds and refresh
2. Click the **"Refresh QR"** button
3. Check Render logs for errors

### WhatsApp Disconnects Frequently

1. This is normal if the session isn't saved properly
2. Ensure `DATABASE_URL` is set correctly
3. Check that the `accounts` table has `session_data` column

### "Unable to connect to database"

1. Verify your `DATABASE_URL` is correct
2. Make sure you replaced `[YOUR-PASSWORD]` with actual password
3. Try the "Session Mode" connection string instead of "Transaction Mode"

### UptimeRobot Shows "Down"

1. Make sure URL ends with `/ping` not just `/`
2. Check if Render service is deployed successfully
3. Wait for initial cold start (can take 30-60 seconds)

### Render Free Tier Limits

- **RAM:** 512MB (enough for ~10 WhatsApp accounts)
- **CPU:** Shared
- **Build time:** 400 hours/month
- **Bandwidth:** 100GB/month

---

## 📋 Environment Variables Reference

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Server port | `3000` |
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJhbGci...` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `DASHBOARD_USERNAME` | Login username | `admin` |
| `DASHBOARD_PASSWORD` | Login password | `your-secure-password` |
| `SESSION_SECRET` | Session encryption key | Random 64-char string |
| `SESSION_COOKIE_SECURE` | Use HTTPS cookies | `true` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `TYPING_DELAY_MS` | Delay before sending (simulates typing) | `1500` |
| `DISABLE_MESSAGE_LOGGING` | Don't log messages to DB | `false` |
| `DISABLE_AUTO_INIT` | Don't auto-reconnect on startup | `false` |
| `GEMINI_API_KEY` | Google Gemini API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `GROQ_API_KEY` | Groq API key | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |

---

## 🆘 Need Help?

- **Issues:** Create an issue on GitHub
- **Documentation:** Check the [README.md](README.md)
- **API Reference:** See the API section in README

---

## 🎊 Congratulations!

You now have a fully functional WhatsApp automation system running for **FREE** with:

- ✅ Unlimited WhatsApp messages
- ✅ Webhook notifications
- ✅ AI chatbot support
- ✅ 100% uptime
- ✅ No credit card required

**Star ⭐ the repo if this helped you!**
