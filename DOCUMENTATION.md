# WhatsApp Multi-Automation V2 - Complete Documentation

## 📋 Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Authentication & Security](#authentication--security)
5. [Dashboard Interface](#dashboard-interface)
6. [Account Management](#account-management)
7. [Webhook System](#webhook-system)
8. [AI Chatbot System](#ai-chatbot-system)
9. [Visual Flow Builder](#visual-flow-builder)
10. [Message Management](#message-management)
11. [Analytics & Monitoring](#analytics--monitoring)
12. [API Reference](#api-reference)
13. [Database Schema](#database-schema)
14. [Configuration](#configuration)
15. [Deployment](#deployment)

---

## Overview

**WhatsApp Multi-Automation V2** is a comprehensive WhatsApp Business automation platform that enables:
- Managing multiple WhatsApp accounts from a single dashboard
- Automated messaging and responses
- AI-powered chatbots with multiple LLM providers
- Visual flow builder for creating conversation flows
- Webhook integrations for external systems
- Real-time analytics and monitoring

### Tech Stack
- **Backend**: Node.js + Express.js
- **Database**: Supabase (PostgreSQL)
- **WhatsApp**: whatsapp-web.js v1.34.2
- **Real-time**: Socket.IO v4.7.4
- **Session Storage**: PostgreSQL (connect-pg-simple)
- **AI Providers**: OpenAI, Google Gemini, Anthropic, Groq, OpenRouter

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│  ┌────────────┐  ┌────────────────┐  ┌─────────────────────────┐   │
│  │ Login Page │  │   Dashboard    │  │   Flow Builder (Visual) │   │
│  └────────────┘  └────────────────┘  └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Express.js Server                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │  Auth Middleware │  │  Rate Limiters   │  │   Validators    │   │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │  Account Routes  │  │  Webhook Routes  │  │   Flow Routes   │   │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ WhatsApp Manager │ │ AI Auto Reply    │ │  Flow Engine     │
│  (whatsapp-web.js)│ │  Service         │ │  (Node executor) │
└──────────────────┘ └──────────────────┘ └──────────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Supabase Database                            │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  ┌───────────┐  │
│  │   Accounts   │  │ Webhooks │  │ Message Logs  │  │   Flows   │  │
│  └──────────────┘  └──────────┘  └───────────────┘  └───────────┘  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐                  │
│  │ AI Configs   │  │ Sessions │  │ Conversations │                  │
│  └──────────────┘  └──────────┘  └───────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Features

### Core Features

| Feature | Description |
|---------|-------------|
| **Multi-Account Management** | Connect and manage unlimited WhatsApp accounts |
| **QR Code Authentication** | Scan QR codes to link WhatsApp Web sessions |
| **Session Persistence** | Sessions saved to database, survives server restarts |
| **Real-time Updates** | Socket.IO for live QR codes, status, and messages |
| **Webhook Integration** | Forward messages to external systems |
| **AI Chatbot** | Multiple LLM providers for intelligent auto-replies |
| **Visual Flow Builder** | Drag-and-drop conversation flow designer |
| **Message Logging** | Complete history of all messages |
| **Analytics Dashboard** | Charts and statistics for all accounts |

### AI Providers Supported

| Provider | Free Tier | Models |
|----------|-----------|--------|
| **Groq** | 14,400 RPD | Llama 3.3/3.1 70B, Mixtral 8x7B, Gemma 2 |
| **Google Gemini** | 1,500 RPD | Gemini 2.5 Flash, 2.0 Flash, Gemma |
| **OpenRouter** | Free models available | Meta Llama, DeepSeek, Qwen |
| **Mistral AI** | 60 RPM | Mistral models |
| **SambaNova** | 30 RPM | Fast inference |
| **HuggingFace** | 300 RPH | Open-source models |
| **OpenAI** | Paid | GPT-4, GPT-3.5 |
| **Anthropic** | Paid | Claude 3.5, Claude 3 |

---

## Authentication & Security

### Session Management
- **Cookie-based sessions** stored in PostgreSQL
- **24-hour session timeout** with activity-based renewal
- **Rolling cookies** - expiration resets on each request
- **Custom cookie name** (`wa.sid`) for security
- **Session pruning** - expired sessions cleaned every 15 minutes

### Login System
- Username/password authentication
- Environment variable credentials:
  - `DASHBOARD_USERNAME` (default: `admin`)
  - `DASHBOARD_PASSWORD` (default: `admin123`)
- Rate limiting: 5 login attempts per 15 minutes per IP
- Session integrity verification (user-agent checking)

### Security Middleware
- **Helmet.js** - HTTP security headers
- **CORS** - Configurable cross-origin requests
- **Rate Limiting** - Per-endpoint limits
- **Input Validation** - Joi schema validation

---

## Dashboard Interface

### Main Views

1. **Dashboard Home**
   - System statistics (total accounts, messages, webhooks)
   - Quick status overview
   - Recent activity

2. **Accounts View**
   - List all WhatsApp accounts
   - **Feature Indicators** per account:
     - 🔌 Webhooks (active/total count)
     - 🤖 AI Chatbot (ON/OFF)
     - 📊 Flows (active/total count)
   - Actions: QR Code, Reconnect, Webhooks, Chatbot, Flows, Delete

3. **Webhooks View**
   - Global webhook management
   - Create, edit, toggle, delete webhooks

4. **Messages View**
   - Send messages to any number
   - View message history
   - Support for text, media, buttons, polls

5. **Analytics View**
   - Message statistics charts
   - Incoming vs outgoing breakdown
   - Success/failure rates
   - Daily trends

6. **System View**
   - Server health status
   - Memory usage
   - Queue statistics
   - System logs

### Navigation

```
📊 Dashboard     - Overview and stats
👥 Accounts      - WhatsApp account management
🔗 Webhooks      - Webhook configuration
💬 Messages      - Message history and sending
📈 Analytics     - Charts and statistics  
🧠 Flow Builder  - Visual flow designer (AI badge)
⚙️  System       - Health and logs
```

---

## Account Management

### Creating an Account
1. Click "Create Account" button
2. Enter account name and optional description
3. System generates QR code
4. Scan QR with WhatsApp mobile app
5. Account connects automatically

### Account Statuses

| Status | Description |
|--------|-------------|
| `initializing` | Client being created |
| `qr_ready` | QR code available for scanning |
| `ready` | Connected and operational |
| `disconnected` | Session ended or lost |
| `auth_failed` | Authentication failed |
| `error` | Fatal error occurred |

### Session Persistence
- Sessions stored in database (`whatsapp_accounts.session_data`)
- Automatic restoration on server restart
- Sessions survive container restarts in Docker/Railway

### Account Actions

| Action | Description |
|--------|-------------|
| **Show QR** | Display QR code for scanning |
| **Reconnect** | Force reconnection attempt |
| **Webhooks** | Manage account webhooks |
| **Chatbot** | Configure AI auto-reply |
| **Flows** | Open flow builder for account |
| **Delete** | Remove account (cascades to related data) |

---

## Webhook System

### How Webhooks Work

1. **Incoming message** received on WhatsApp account
2. System checks for active webhooks on that account
3. **Payload constructed** with message data
4. **HTTP POST** sent to webhook URL
5. **Retry logic** on failure (exponential backoff)

### Webhook Payload Structure

```json
{
  "event": "message",
  "account_id": "uuid",
  "account_name": "Account Name",
  "account_phone": "+1234567890",
  "timestamp": 1703123456789,
  "data": {
    "message_id": "ABCD1234",
    "from": "15551234567@c.us",
    "from_name": "John Doe",
    "to": "15559876543@c.us",
    "body": "Hello!",
    "type": "chat",
    "is_group": false,
    "group_name": null,
    "has_media": false,
    "media": null
  }
}
```

### Webhook Configuration

| Field | Description |
|-------|-------------|
| `url` | HTTPS endpoint to receive webhooks |
| `secret` | Optional secret for payload signing |
| `is_active` | Toggle webhook on/off |

### Webhook Security
- Optional HMAC signature in `X-Webhook-Signature` header
- Signature: `sha256=HMAC(payload, secret)`

### Retry Policy
- Maximum 5 retry attempts
- Exponential backoff: 30s, 60s, 120s, 240s, 480s
- Dead letter queue for permanent failures

---

## AI Chatbot System

### Configuration Options

| Setting | Description |
|---------|-------------|
| **Provider** | LLM provider (Groq, Gemini, OpenAI, etc.) |
| **API Key** | Provider API key |
| **Model** | Specific model to use |
| **System Prompt** | Personality and instructions |
| **Temperature** | Creativity (0.0 - 1.0) |
| **History Limit** | Past messages for context (default: 10) |

### How AI Replies Work

1. Incoming message triggers AI processing
2. System retrieves conversation history from database
3. Builds message array with system prompt
4. Calls LLM provider API
5. Response sent back to WhatsApp user

### Provider-Specific Details

#### Groq (Recommended - Free)
```javascript
Models: 
- llama-3.3-70b-versatile (Best)
- llama-3.1-70b-versatile
- llama-3.1-8b-instant (Fastest)
- mixtral-8x7b-32768
- gemma2-9b-it
```

#### Google Gemini
```javascript
Models:
- models/gemini-2.5-flash (Recommended)
- models/gemini-2.0-flash
- models/gemini-2.0-flash-lite (Fastest)
```

#### OpenRouter (Free Models)
```javascript
Models:
- meta-llama/llama-3.3-70b-instruct:free
- google/gemini-2.0-flash-exp:free
- deepseek/deepseek-r1-0528:free
```

### Chatbot vs Flows Priority
- **Active Flow** takes priority over AI chatbot
- When user is in a flow, chatbot is "sleeping"
- After flow completes, chatbot becomes active again

---

## Visual Flow Builder

### Accessing Flow Builder
1. Click "Flow Builder" in sidebar navigation
2. Or click the flows button (📊) on any account row

### Node Types

| Node | Icon | Description |
|------|------|-------------|
| **Start** | ▶️ | Entry point with trigger keywords |
| **Message** | 💬 | Send text message |
| **Button Menu** | ⬛ | Present options to user |
| **Wait for Input** | ⌨️ | Collect user response |
| **AI Question** | 🧠 | Smart data extraction with AI |
| **Condition** | ⑂ | If/else branching logic |
| **API Call** | 🔌 | Make HTTP requests |
| **Delay** | ⏱️ | Wait before continuing |
| **End** | ⏹️ | Terminate flow |

### Creating a Flow

1. **Click "New Flow"** button
2. **Configure flow:**
   - Name and description
   - Select WhatsApp account
   - Choose flow type (Basic or AI-Powered)
   - Set trigger type and keywords
3. **Add nodes** from left palette (click to add)
4. **Connect nodes** by dragging from output handle to input handle
5. **Configure each node** in right properties panel
6. **Save flow**

### Flow Types

#### Basic Flow
- Traditional decision-tree conversation
- Button menus and simple inputs
- No AI processing

#### AI-Powered Flow
- LLM-powered data extraction
- Natural language understanding
- Smart validation and re-prompting
- Requires LLM configuration

### Variable System
- Use `{{variable_name}}` syntax in messages
- Variables set by Input and AI Question nodes
- Available throughout the flow

### Flow Triggers

| Type | Description |
|------|-------------|
| **Keyword** | Triggered when message contains any keyword |
| **All** | Triggers on any message |
| **Regex** | Pattern matching |
| **Exact** | Exact match required |

---

## Message Management

### Sending Messages

#### Text Messages
```javascript
POST /api/messages/send
{
  "account_id": "uuid",
  "number": "+1234567890",
  "message": "Hello!"
}
```

#### Media Messages
```javascript
POST /api/messages/send/media
{
  "account_id": "uuid", 
  "number": "+1234567890",
  "media": {
    "url": "https://example.com/image.jpg",
    "mimetype": "image/jpeg",
    "filename": "image.jpg"
  },
  "caption": "Check this out!"
}
```

### Number Formats Supported
- International: `+1234567890`
- Without plus: `1234567890`
- WhatsApp ID: `1234567890@c.us`
- Local (auto-detects country)

### Message Types
- Text
- Image
- Video
- Audio
- Document
- Buttons (converted to text format)
- Polls

---

## Analytics & Monitoring

### Dashboard Statistics
- Total accounts
- Active accounts (ready status)
- Total messages (24h)
- Active webhooks

### Message Analytics
- Incoming vs outgoing counts
- Success vs failure rates
- Daily message trends (chart)
- Per-account breakdown

### System Health
- Server uptime
- Memory usage
- Message queue size
- Cache statistics
- Webhook queue status

---

## API Reference

### Authentication
All API routes (except `/api/auth/*`) require session authentication.

### Endpoints

#### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/user` | Get current user |

#### Accounts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create account |
| GET | `/api/accounts/:id` | Get account details |
| DELETE | `/api/accounts/:id` | Delete account |
| GET | `/api/accounts/:id/qr` | Get QR code |
| POST | `/api/accounts/:id/reconnect` | Reconnect account |

#### Webhooks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/webhooks` | List all webhooks |
| POST | `/api/webhooks` | Create webhook |
| GET | `/api/accounts/:id/webhooks` | Get account webhooks |
| PATCH | `/api/webhooks/:id/toggle` | Toggle webhook |
| DELETE | `/api/webhooks/:id` | Delete webhook |

#### Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/messages/send` | Send text message |
| POST | `/api/messages/send/media` | Send media |
| GET | `/api/accounts/:id/messages` | Get message history |

#### Flows
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chatbot/flows` | List all flows |
| POST | `/api/chatbot/flows` | Create flow |
| GET | `/api/chatbot/flows/:id` | Get flow with nodes |
| PUT | `/api/chatbot/flows/:id` | Update flow |
| PUT | `/api/chatbot/flows/:id/design` | Update nodes/connections |
| DELETE | `/api/chatbot/flows/:id` | Delete flow |
| POST | `/api/chatbot/flows/:id/simulate` | Test flow |

#### AI Config
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts/:id/ai-config` | Get AI config |
| POST | `/api/accounts/:id/ai-config` | Save AI config |
| DELETE | `/api/accounts/:id/ai-config` | Delete AI config |

---

## Database Schema

### Core Tables

```sql
-- WhatsApp Accounts
whatsapp_accounts (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  description TEXT,
  status VARCHAR(50),
  phone_number VARCHAR(50),
  session_data TEXT,
  qr_code TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)

-- Webhooks
webhooks (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES whatsapp_accounts,
  url VARCHAR(500),
  secret VARCHAR(255),
  is_active BOOLEAN,
  created_at TIMESTAMP
)

-- Message Logs
message_logs (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES whatsapp_accounts,
  direction VARCHAR(50),
  message TEXT,
  sender VARCHAR(255),
  recipient VARCHAR(255),
  status VARCHAR(50),
  created_at TIMESTAMP
)

-- AI Configuration
ai_auto_replies (
  account_id UUID PRIMARY KEY REFERENCES whatsapp_accounts,
  provider TEXT,
  api_key TEXT,
  model TEXT,
  system_prompt TEXT,
  temperature NUMERIC,
  is_active BOOLEAN
)

-- Chatbot Flows
chatbot_flows (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES whatsapp_accounts,
  name VARCHAR(255),
  trigger_type VARCHAR(50),
  trigger_keywords TEXT[],
  is_active BOOLEAN,
  flow_type VARCHAR(20),
  llm_provider VARCHAR(50),
  llm_api_key TEXT,
  llm_model VARCHAR(255)
)

-- Flow Nodes
flow_nodes (
  id UUID PRIMARY KEY,
  flow_id UUID REFERENCES chatbot_flows,
  node_type VARCHAR(50),
  name VARCHAR(255),
  position_x INTEGER,
  position_y INTEGER,
  config JSONB
)

-- Flow Connections
flow_connections (
  id UUID PRIMARY KEY,
  flow_id UUID REFERENCES chatbot_flows,
  source_node_id UUID REFERENCES flow_nodes,
  target_node_id UUID REFERENCES flow_nodes,
  source_handle VARCHAR(100)
)

-- Conversation State
chatbot_conversations (
  id UUID PRIMARY KEY,
  flow_id UUID REFERENCES chatbot_flows,
  account_id UUID REFERENCES whatsapp_accounts,
  contact_number VARCHAR(255),
  current_node_id UUID,
  context JSONB,
  status VARCHAR(50)
)
```

---

## Configuration

### Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=production

# Database
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
DATABASE_URL=postgres://user:pass@host:5432/db

# Authentication  
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=your_secure_password
SESSION_SECRET=your_session_secret
SESSION_COOKIE_SECURE=true  # Set to true for HTTPS

# WhatsApp
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Optional
KEEPALIVE_URL=https://your-app.railway.app
KEEPALIVE_INTERVAL_MINUTES=14
```

---

## Deployment

### Railway (Recommended)
1. Connect GitHub repository
2. Set environment variables
3. Deploy automatically

### Render (Free Tier Compatible)
1. Create Web Service
2. Connect repository
3. Runtime: Node
4. Build command: `npm install && npx puppeteer browsers install chrome`
5. Start command: `node --expose-gc --max-old-space-size=384 index.optimized.js`
6. Set environment variables (see `.env.example`)

**Note**: Render free tier has 512MB RAM and 0.1 vCPU - supports 1 WhatsApp account.

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Login loop | Clear browser cookies, check SESSION_COOKIE_SECURE |
| QR code not showing | Check Puppeteer/Chromium installation |
| Session lost on restart | Ensure DATABASE_URL is set for session persistence |
| AI not responding | Verify API key and check provider rate limits |
| Webhook not receiving | Check URL accessibility and firewall |
| Flow not triggering | Verify trigger keywords match and flow is active |

### Logs
- Server logs in `logs/` directory
- Real-time logs in System view
- Check browser console for frontend errors

---

## Support

For issues and feature requests, create an issue in the GitLab repository.

---

*Last Updated: December 21, 2025*
*Version: 2.0*
