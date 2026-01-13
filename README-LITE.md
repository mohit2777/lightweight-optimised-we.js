# WhatsApp Multi-Automation - LITE Version

Ultra-low RAM version focused on **webhooks and core API only**.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Run lite version
npm run start:lite
```

## 📊 RAM Comparison

| Version | Features | Target RAM |
|---------|----------|------------|
| Full (`index.js`) | AI Chatbot, Flows, Heavy Caching | 300-500MB |
| **Lite (`index.lite.js`)** | Webhooks & API only | **100-200MB** |

## 🔧 Files

| File | Purpose |
|------|---------|
| `index.lite.js` | Ultra-lite Express server |
| `utils/whatsappManager.lite.js` | Minimal WhatsApp manager |
| `config/database.lite.js` | Tiny cache, lazy loading |
| `render.lite.yaml` | Render.com deployment |

## 💡 Features Removed

- ❌ AI Chatbot / Auto-reply
- ❌ Flow Builder / Visual Flows
- ❌ Heavy message caching
- ❌ Typing indicators
- ❌ Read receipts
- ❌ Large media handling (>512KB)

## ✅ Features Kept

- ✅ WhatsApp session persistence (Supabase)
- ✅ Multi-account support
- ✅ Send/receive messages API
- ✅ Webhook delivery with retries
- ✅ QR code authentication
- ✅ Basic message logging

## 🌐 Render.com Deployment

Deploy to Render.com free tier (512MB RAM, 0.1 vCPU):

1. Connect your GitHub repository to Render
2. Create a new Web Service with these settings:
   - **Runtime**: Node
   - **Build Command**: `npm install && npx puppeteer browsers install chrome`
   - **Start Command**: `node --expose-gc --max-old-space-size=300 index.lite.js`
3. Set environment variables (see `.env.example`)

Or use `render.lite.yaml` as a blueprint.

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check + memory stats |
| POST | `/api/accounts` | Create account |
| GET | `/api/accounts` | List accounts |
| GET | `/api/accounts/:id` | Get account |
| DELETE | `/api/accounts/:id` | Delete account |
| GET | `/api/accounts/:id/qr` | Get QR code |
| POST | `/api/accounts/:id/qr` | Request new QR |
| POST | `/api/accounts/:id/reconnect` | Reconnect account |
| POST | `/api/accounts/:id/send` | Send text message |
| POST | `/api/accounts/:id/send-media` | Send media |
| GET | `/api/accounts/:id/webhooks` | List webhooks |
| POST | `/api/accounts/:id/webhooks` | Create webhook |
| PUT | `/api/accounts/:id/webhooks/:wid` | Update webhook |
| DELETE | `/api/accounts/:id/webhooks/:wid` | Delete webhook |
| GET | `/api/accounts/:id/messages` | Message history |

## 📝 Environment Variables

```env
# Required
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Optional
PORT=3000
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=secret
SESSION_SECRET=your-secret-key
DISABLE_MESSAGE_LOGGING=false
```

## 🔄 Session Persistence

Sessions are automatically:
1. **Saved to Supabase** after successful QR scan (60s delay)
2. **Restored from Supabase** on app restart
3. **Periodically saved** every 15 minutes

No more lost sessions on container restarts!
