# WhatsApp Multi-Automation API

> **A self-hosted WhatsApp Business API alternative** - Manage multiple WhatsApp accounts, automate messages with AI-powered chatbots, and integrate with any system via webhooks. Runs 100% free on Render + Supabase.

## 📱 What is this?
<img width="1536" height="1024" alt="best" src="https://github.com/user-attachments/assets/ff8e1643-9a1d-4d1d-90bb-853cb605001d" />

This is a **lightweight WhatsApp automation platform** that lets you:

- **Connect multiple WhatsApp accounts** - Manage all your business numbers from one dashboard
- **AI-Powered Chatbots** - Automatic replies using Claude, GPT-4, Gemini, or Groq with conversation memory
- **Webhook Integrations** - Send incoming messages to your CRM, ticketing system, or any API
- **Send Messages via API** - Integrate WhatsApp messaging into your apps and workflows
- **Visual Flow Builder** - Create automated conversation flows without coding
- **No Browser Required** - Uses Baileys (WebSocket) instead of Puppeteer, runs on 512MB RAM

### 💡 Use Cases

| Industry | Use Case |
|----------|----------|
| **E-commerce** | Order confirmations, shipping updates, abandoned cart recovery |
| **Customer Support** | AI chatbot for FAQs, ticket creation via webhook |
| **Marketing** | Broadcast campaigns, lead capture bots |
| **Healthcare** | Appointment reminders, patient follow-ups |
| **Education** | Class notifications, assignment reminders |

### 🆚 vs Official WhatsApp Business API

| Feature | Official API | This Platform |
|---------|-------------|---------------|
| Cost | $50-200+/month | **$0/month** |
| Setup | Meta approval process | Scan QR, done |
| Messages | Pay per conversation | Unlimited |
| AI Chatbot | Not included | ✅ Built-in |
| Self-hosted | No | ✅ Yes |

---

## 🚀 Quick Deploy (Free)

**[📖 Complete Setup Guide](SETUP-GUIDE.md)** - Deploy in 15 minutes using:
- **Render** (Free hosting)
- **Supabase** (Free database)
- **UptimeRobot** (100% uptime)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

---

## Features

- ✅ Multiple WhatsApp accounts
- ✅ No browser/Chromium needed (uses Baileys WebSocket)
- ✅ Low memory usage (~15-25MB per account)
- ✅ QR code authentication
- ✅ Webhook notifications for incoming messages
- ✅ AI Chatbot integration (OpenAI, Anthropic, Gemini, Groq, OpenRouter)
- ✅ Session persistence in PostgreSQL/Supabase
- ✅ Real-time updates via Socket.IO
- ✅ Typing indicator before sending messages (configurable delay)

## Requirements

- Node.js 18+
- PostgreSQL database (or Supabase)

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname
# OR Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key

# Server
PORT=3000
NODE_ENV=production

# Authentication
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
SESSION_SECRET=random-secret-string

# Typing Indicator (milliseconds, 0 to disable)
TYPING_DELAY_MS=1500

# Optional: AI Providers
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GEMINI_API_KEY=xxx
GROQ_API_KEY=xxx
OPENROUTER_API_KEY=xxx
```

## Installation

```bash
npm install
npm start
```

## API Endpoints

### Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create new account |
| GET | `/api/accounts/:id` | Get account details |
| DELETE | `/api/accounts/:id` | Delete account |
| GET | `/api/accounts/:id/qr` | Get QR code |
| POST | `/api/accounts/:id/reconnect` | Reconnect account |

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/accounts/:id/send` | Send text message |
| POST | `/api/accounts/:id/send-media` | Send media message |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/webhooks/:accountId` | List webhooks |
| POST | `/api/webhooks` | Create webhook |
| PUT | `/api/webhooks/:id` | Update webhook |
| DELETE | `/api/webhooks/:id` | Delete webhook |

---

## Exact curl Commands

### Login (get session cookie)
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-password"}' \
  -c cookies.txt
```

### Create Account
```bash
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"name": "My WhatsApp"}'
```

### List Accounts
```bash
curl -X GET http://localhost:3000/api/accounts \
  -b cookies.txt
```

### Get QR Code
```bash
curl -X GET http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID/qr \
  -b cookies.txt
```

### Send Text Message
```bash
curl -X POST http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID/send \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "number": "919876543210",
    "message": "Hello from API!"
  }'
```

### Send Media (URL)
```bash
curl -X POST http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID/send-media \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "number": "919876543210",
    "caption": "Check this image!",
    "media": {
      "url": "https://example.com/image.jpg",
      "mimetype": "image/jpeg",
      "filename": "image.jpg"
    }
  }'
```

### Send Media (Base64)
```bash
curl -X POST http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID/send-media \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "number": "919876543210",
    "caption": "PDF Document",
    "media": {
      "data": "JVBERi0xLjQKJeLjz9...",
      "mimetype": "application/pdf",
      "filename": "document.pdf"
    }
  }'
```

### Create Webhook (Messages Only)
```bash
curl -X POST http://localhost:3000/api/webhooks \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "account_id": "YOUR_ACCOUNT_ID",
    "url": "https://your-n8n.com/webhook/messages",
    "events": ["message"],
    "is_active": true
  }'
```

### Create Webhook (Read Receipts Only)
```bash
curl -X POST http://localhost:3000/api/webhooks \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "account_id": "YOUR_ACCOUNT_ID",
    "url": "https://your-n8n.com/webhook/receipts",
    "events": ["message_ack"],
    "is_active": true
  }'
```

### Create Webhook (All Events)
```bash
curl -X POST http://localhost:3000/api/webhooks \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "account_id": "YOUR_ACCOUNT_ID",
    "url": "https://your-n8n.com/webhook/all",
    "events": ["message", "message_ack"],
    "is_active": true
  }'
```

### List Webhooks
```bash
curl -X GET http://localhost:3000/api/webhooks/YOUR_ACCOUNT_ID \
  -b cookies.txt
```

### Delete Account
```bash
curl -X DELETE http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID \
  -b cookies.txt
```

### Reconnect Account
```bash
curl -X POST http://localhost:3000/api/accounts/YOUR_ACCOUNT_ID/reconnect \
  -b cookies.txt
```

---

## n8n Integration

### Send Message (HTTP Request Node)

**Method:** `POST`  
**URL:** `https://your-server.com/api/accounts/{{$json.accountId}}/send`

**Authentication:** Header Auth
```
Cookie: connect.sid={{$credentials.sessionCookie}}
```

**Headers:**
```json
{
  "Content-Type": "application/json"
}
```

**Body (JSON):**
```json
{
  "number": "{{$json.phoneNumber}}",
  "message": "{{$json.message}}"
}
```

**Example with static values:**
```json
{
  "number": "919876543210",
  "message": "Hello from n8n!"
}
```

---

### Send Media (HTTP Request Node)

**Method:** `POST`  
**URL:** `https://your-server.com/api/accounts/{{$json.accountId}}/send-media`

**Headers:**
```json
{
  "Content-Type": "application/json"
}
```

**Body (JSON) - From URL:**
```json
{
  "number": "{{$json.phoneNumber}}",
  "caption": "Check this out!",
  "media": {
    "url": "https://example.com/image.jpg",
    "mimetype": "image/jpeg",
    "filename": "image.jpg"
  }
}
```

**Body (JSON) - Base64:**
```json
{
  "number": "{{$json.phoneNumber}}",
  "caption": "Document attached",
  "media": {
    "data": "{{$json.base64Data}}",
    "mimetype": "application/pdf",
    "filename": "document.pdf"
  }
}
```

---

### Receive Messages (Webhook Trigger Node)

1. Create a Webhook node in n8n
2. Copy the webhook URL (e.g., `https://your-n8n.com/webhook/xxx`)
3. Add it to your WhatsApp account via the dashboard or API:

**Create Webhook:**
```
POST /api/webhooks
{
  "account_id": "your-account-uuid",
  "url": "https://your-n8n.com/webhook/xxx",
  "events": ["message"],
  "is_active": true
}
```

**Webhook Payload (incoming message):**
```json
{
  "event": "message",
  "account_id": "uuid",
  "direction": "incoming",
  "message_id": "xxx",
  "sender": "919876543210@s.whatsapp.net",
  "recipient": "your-number@s.whatsapp.net",
  "message": "Hello!",
  "timestamp": 1705234567,
  "type": "text",
  "chat_id": "919876543210@s.whatsapp.net",
  "is_group": false,
  "optimized": true
}
```

**Webhook Payload (read receipt):**
```json
{
  "event": "message_ack",
  "account_id": "uuid",
  "message_id": "xxx",
  "recipient": "919876543210@s.whatsapp.net",
  "status": "read",
  "status_code": 4,
  "timestamp": 1705234590,
  "optimized": true
}
```

**Status Codes:**
| Code | Status |
|------|--------|
| 2 | sent |
| 3 | delivered |
| 4 | read |

---

### Get Account Status (HTTP Request Node)

**Method:** `GET`  
**URL:** `https://your-server.com/api/accounts/{{$json.accountId}}`

**Response:**
```json
{
  "id": "uuid",
  "name": "My Account",
  "status": "ready",
  "phone_number": "919876543210",
  "last_active_at": "2026-01-14T12:00:00.000Z"
}
```

---

### List All Accounts (HTTP Request Node)

**Method:** `GET`  
**URL:** `https://your-server.com/api/accounts`

**Response:**
```json
[
  {
    "id": "uuid-1",
    "name": "Account 1",
    "status": "ready",
    "phone_number": "919876543210"
  },
  {
    "id": "uuid-2", 
    "name": "Account 2",
    "status": "qr_ready",
    "phone_number": null
  }
}
```

---

## n8n Workflow Example

```
[Webhook Trigger] → [Switch by sender] → [HTTP Request: Send Reply]
```

1. **Webhook Trigger**: Receives incoming WhatsApp message
2. **Switch Node**: Route based on `{{$json.sender}}` or `{{$json.message}}`
3. **HTTP Request**: Send response back via `/api/accounts/:id/send`

---

## Phone Number Format

- Include country code without `+` or `00`
- No spaces or dashes
- Examples:
  - India: `919876543210`
  - US: `14155551234`
  - UK: `447911123456`

---

## Memory Usage

| Accounts | RAM |
|----------|-----|
| 1 | ~50-75 MB |
| 5 | ~100-150 MB |
| 10 | ~180-280 MB |
| 20 | ~350-500 MB |

Perfect for free-tier hosting (512MB).

---

## License

MIT
