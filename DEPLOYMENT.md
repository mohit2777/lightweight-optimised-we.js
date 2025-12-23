# Deploying WhatsApp Multi-Automation V2 to Render

This guide covers deploying the application to Render, including handling common issues with WhatsApp Web.js on cloud platforms.

## Prerequisites

1. **Supabase Account** - Create a new project at [supabase.com](https://supabase.com)
2. **Render Account** - Sign up at [render.com](https://render.com)
3. **GitHub Repository** - Push your code to GitHub

---

## Step 1: Set Up Supabase Database

### 1.1 Create New Project
- Go to Supabase Dashboard → New Project
- Choose a strong database password (save it!)
- Select a region close to your Render region

### 1.2 Run Database Schema
- Go to SQL Editor in Supabase
- Copy the contents of `schema.sql` 
- Run the SQL to create all tables

### 1.3 Get Connection Details
Save these values for Render:
- **Project URL**: `https://YOUR_PROJECT.supabase.co`
- **Service Role Key**: Settings → API → `service_role` key (secret!)
- **Database URL** (optional): Settings → Database → Connection string → URI

---

## Step 2: Deploy to Render

### Option A: One-Click Deploy (Recommended)
1. Fork this repository to your GitHub
2. Click the "Deploy to Render" button (if available)
3. Configure environment variables

### Option B: Manual Deploy
1. Go to Render Dashboard → New → Web Service
2. Connect your GitHub repository
3. Configure:
   - **Name**: `wa-multi-automation`
   - **Environment**: Docker
   - **Dockerfile Path**: `Dockerfile.render`
   - **Plan**: Free (or Starter for better performance)

### 2.1 Environment Variables
Set these in Render Dashboard → Environment:

```
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SESSION_SECRET=generate-a-random-32-char-string
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=your-secure-password

# HTTPS (Required for Render)
SESSION_COOKIE_SECURE=true

# Chromium Path (Set automatically in Dockerfile.render)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Egress Optimization (Recommended for free tier)
DISABLE_MESSAGE_LOGGING=true
DISABLE_PERIODIC_SESSION_SAVE=true

# Keep Alive (Prevents free tier sleep)
KEEPALIVE_URL=https://your-app.onrender.com/health
KEEPALIVE_INTERVAL_MINUTES=14
```

---

## Step 3: Known Issues & Solutions

### Issue 1: WhatsApp Sessions Lost on Redeploy
**Problem**: Render's filesystem is ephemeral - local files are deleted on deploy.

**Solution**: Sessions are stored in Supabase (`session_data` column). The app automatically:
1. Saves sessions to Supabase on disconnect
2. Restores sessions from Supabase on startup
3. Periodically saves sessions (every 15 minutes by default)

**If sessions keep getting lost:**
- Check Supabase for the `session_data` column in `whatsapp_accounts`
- Ensure `DISABLE_PERIODIC_SESSION_SAVE` is NOT set to `true`
- Check logs for session save/restore errors

### Issue 2: Free Tier Sleeps After 15 Minutes
**Problem**: Render free tier spins down after 15 minutes of inactivity.

**Solutions**:
1. **Built-in Keepalive**: Set `KEEPALIVE_URL` to your health endpoint
2. **External Cron**: Use UptimeRobot or cron-job.org to ping `/health` every 14 minutes
3. **GitHub Actions**: Use the included `.github/workflows/keep-alive.yml`

### Issue 3: Memory Limits (512MB on Free Tier)
**Problem**: Chromium uses significant memory, especially with multiple accounts.

**Solutions**:
1. **Limit Accounts**: Free tier reliably supports 1-2 accounts
2. **Memory Optimization**: Already configured in Dockerfile:
   ```
   NODE_OPTIONS=--max-old-space-size=512
   ```
3. **Upgrade Plan**: Starter tier has 2GB RAM

### Issue 4: Slow Cold Starts
**Problem**: First request after sleep takes 30-60 seconds.

**Solutions**:
1. Use keepalive to prevent sleep
2. Upgrade to paid tier (no sleep)
3. Health endpoint returns quickly even during initialization

### Issue 5: QR Code Not Showing
**Problem**: Puppeteer/Chromium not working correctly.

**Checks**:
1. Verify `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
2. Check Render logs for Chromium errors
3. Ensure using `Dockerfile.render` (not regular Dockerfile)

### Issue 6: Login Session Lost
**Problem**: Dashboard login doesn't persist.

**Solutions**:
1. Set `SESSION_COOKIE_SECURE=true` (required for HTTPS)
2. Optionally set `DATABASE_URL` for PostgreSQL session storage
3. Use the Supabase connection string for persistent sessions

---

## Step 4: Monitoring

### Health Endpoints
- `/health` - Full system health (memory, accounts, queues)
- `/ready` - Database connection check
- `/api/health` - Detailed metrics (requires auth)

### Logs
- View in Render Dashboard → Logs
- Application logs with timestamps and levels

### Metrics
The `/health` endpoint returns:
```json
{
  "status": "ok",
  "uptime": 3600,
  "memory": { "used": 256, "total": 512 },
  "accounts": { "total": 2, "connected": 1 },
  "webhookQueue": { "pending": 0, "failed": 0 }
}
```

---

## Step 5: Scaling Recommendations

### Free Tier Limitations
- 512MB RAM → 1-2 WhatsApp accounts
- 15 minute sleep → Use keepalive
- Slow cold starts → Accept or upgrade
- Ephemeral storage → Sessions in Supabase

### Starter Tier ($7/month)
- 2GB RAM → 3-5 accounts
- No sleep
- Faster performance
- Still ephemeral storage

### Standard Tier ($25/month)
- 4GB RAM → 5-10 accounts
- Persistent disk available
- Better for production

---

## Troubleshooting Commands

### Check Chromium
```bash
# In Render shell
chromium --version
which chromium
```

### Check Memory
```bash
# View current memory
curl https://your-app.onrender.com/health | jq '.memory'
```

### Force Session Save
Visit the dashboard and disconnect/reconnect the account to force a session save.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | - | Supabase service role key |
| `SESSION_SECRET` | Yes | - | Random string for session encryption |
| `DASHBOARD_USERNAME` | Yes | - | Dashboard login username |
| `DASHBOARD_PASSWORD` | Yes | - | Dashboard login password |
| `PORT` | No | 3000 | Server port (Render sets this) |
| `SESSION_COOKIE_SECURE` | No | false | Set `true` for HTTPS |
| `PUPPETEER_EXECUTABLE_PATH` | No | - | Path to Chromium binary |
| `DISABLE_MESSAGE_LOGGING` | No | false | Skip storing messages |
| `DISABLE_PERIODIC_SESSION_SAVE` | No | false | Only save on disconnect |
| `SESSION_SAVE_INTERVAL_MS` | No | 900000 | Session save interval |
| `KEEPALIVE_URL` | No | - | URL to ping for keepalive |
| `KEEPALIVE_INTERVAL_MINUTES` | No | 14 | Keepalive ping interval |
| `DATABASE_URL` | No | - | PostgreSQL URL for sessions |

---

## Support

If you encounter issues:
1. Check Render logs for error messages
2. Verify all environment variables are set
3. Check Supabase logs for database errors
4. Ensure schema.sql was run successfully
