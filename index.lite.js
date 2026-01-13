/**
 * WhatsApp Gateway - Ultra-Lite Version
 * Minimal RAM usage - Webhooks & Core API only
 * No chatbot, no flows, no heavy features
 * Target: < 200MB RAM per instance
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');

const { db } = require('./config/database.lite');
const logger = require('./utils/logger');
const { requireAuth, requireGuest, login, logout, getCurrentUser } = require('./middleware/auth');
const whatsapp = require('./utils/whatsappManager.lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.set('trust proxy', 1);

// Session middleware (in-memory for lite version)
app.use(session({
  secret: process.env.SESSION_SECRET || 'lite-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests' } });
app.use('/api/', limiter);

// Socket.IO
whatsapp.setSocketIO(io);
io.on('connection', (socket) => {
  socket.emit('statuses', whatsapp.getAllAccountStatuses());
});

// Health endpoint
app.get('/health', async (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: '3.0-lite',
    uptime: process.uptime(),
    memory: { rss: Math.round(mem.rss / 1024 / 1024), heap: Math.round(mem.heapUsed / 1024 / 1024) },
    accounts: whatsapp.getAllAccountStatuses(),
    metrics: whatsapp.getMetrics()
  });
});

// ===== ACCOUNT ROUTES =====

// Create account
app.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const account = await whatsapp.createAccount(name.trim(), description || '');
    res.status(201).json(account);
  } catch (e) {
    logger.error('Create account:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List accounts
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const result = accounts.map(a => ({
      ...a,
      live_status: whatsapp.getAccountStatus(a.id) || a.status,
      qr_code: whatsapp.getQRCode(a.id)
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get account
app.get('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const account = await db.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...account,
      live_status: whatsapp.getAccountStatus(req.params.id) || account.status,
      qr_code: whatsapp.getQRCode(req.params.id)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete account
app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    await whatsapp.deleteAccount(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get QR code
app.get('/api/accounts/:id/qr', requireAuth, async (req, res) => {
  try {
    const qr = whatsapp.getQRCode(req.params.id);
    if (!qr) return res.status(404).json({ error: 'No QR available' });
    res.json({ qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Request new QR
app.post('/api/accounts/:id/qr', requireAuth, async (req, res) => {
  try {
    await whatsapp.requestNewQRCode(req.params.id);
    res.json({ success: true, message: 'QR generation started' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reconnect account
app.post('/api/accounts/:id/reconnect', requireAuth, async (req, res) => {
  try {
    const account = await db.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    const result = await whatsapp.reconnectAccount(account, { forceReconnect: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== MESSAGING ROUTES =====

// Send text message
app.post('/api/accounts/:id/send', requireAuth, async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'number and message required' });
    const result = await whatsapp.sendMessage(req.params.id, number, message);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send media
app.post('/api/accounts/:id/send-media', requireAuth, async (req, res) => {
  try {
    const { number, media, caption } = req.body;
    if (!number || !media) return res.status(400).json({ error: 'number and media required' });
    const result = await whatsapp.sendMedia(req.params.id, number, media, caption);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== WEBHOOK ROUTES =====

// List webhooks
app.get('/api/accounts/:id/webhooks', requireAuth, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks(req.params.id);
    res.json(webhooks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create webhook
app.post('/api/accounts/:id/webhooks', requireAuth, async (req, res) => {
  try {
    const { url, secret, is_active } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    const webhook = await db.createWebhook({
      id: require('uuid').v4(),
      account_id: req.params.id,
      url,
      secret: secret || null,
      is_active: is_active !== false,
      created_at: new Date().toISOString()
    });
    res.status(201).json(webhook);
  } catch (e) {
    logger.error('Create webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update webhook
app.put('/api/accounts/:id/webhooks/:webhookId', requireAuth, async (req, res) => {
  try {
    const { url, secret, is_active } = req.body;
    // Only include valid columns that exist in the database
    const updates = {};
    if (url !== undefined) updates.url = url;
    if (secret !== undefined) updates.secret = secret;
    if (is_active !== undefined) updates.is_active = is_active;
    updates.updated_at = new Date().toISOString();
    
    const webhook = await db.updateWebhook(req.params.webhookId, updates);
    res.json(webhook);
  } catch (e) {
    logger.error('Update webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete webhook
app.delete('/api/accounts/:id/webhooks/:webhookId', requireAuth, async (req, res) => {
  try {
    await db.deleteWebhook(req.params.webhookId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== MESSAGE HISTORY =====

app.get('/api/accounts/:id/messages', requireAuth, async (req, res) => {
  try {
    const messages = await db.getMessageLogs(req.params.id, 100);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== STATS API =====
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const statuses = whatsapp.getAllAccountStatuses();
    const metrics = whatsapp.getMetrics();
    
    const activeCount = Object.values(statuses).filter(s => s === 'ready').length;
    const pendingCount = Object.values(statuses).filter(s => s === 'qr_ready' || s === 'initializing').length;
    
    res.json({
      accounts: {
        total: accounts.length,
        active: activeCount,
        pending: pendingCount,
        disconnected: accounts.length - activeCount - pendingCount
      },
      messages: {
        total: metrics.messagesProcessed || 0,
        incoming: 0,
        outgoing: 0,
        failed: metrics.messagesFailed || 0
      },
      webhooks: {
        delivered: metrics.webhooksDelivered || 0
      },
      system: {
        uptime: process.uptime(),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Global send message (expects accountId in body)
app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { accountId, number, message } = req.body;
    if (!accountId || !number || !message) {
      return res.status(400).json({ error: 'accountId, number, and message required' });
    }
    const result = await whatsapp.sendMessage(accountId, number, message);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Global send media
app.post('/api/send-media', requireAuth, async (req, res) => {
  try {
    const { accountId, number, media, caption } = req.body;
    if (!accountId || !number || !media) {
      return res.status(400).json({ error: 'accountId, number, and media required' });
    }
    const result = await whatsapp.sendMedia(accountId, number, media, caption);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send buttons (lite mode - not supported, return error)
app.post('/api/send-buttons', requireAuth, (req, res) => {
  res.status(501).json({ 
    error: 'Button messages not supported in lite mode',
    message: 'WhatsApp Web API does not support interactive buttons. Use text messages instead.'
  });
});

// Global message logs
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
    const messages = await db.getAllMessageLogs(limit, 0);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// System logs (lite mode - minimal)
app.get('/api/logs', requireAuth, (req, res) => {
  res.json([
    { level: 'info', message: 'System running in LITE mode', timestamp: new Date().toISOString() },
    { level: 'info', message: `Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`, timestamp: new Date().toISOString() },
    { level: 'info', message: `Uptime: ${Math.round(process.uptime())}s`, timestamp: new Date().toISOString() }
  ]);
});

// Chatbot flows (lite mode - disabled)
app.get('/api/chatbot/flows', requireAuth, (req, res) => {
  res.json([]);
});

// Get single flow (lite mode - not found)
app.get('/api/chatbot/flows/:id', requireAuth, (req, res) => {
  res.status(404).json({ error: 'Flows not available in lite mode' });
});

// Delete flow (lite mode - not found)
app.delete('/api/chatbot/flows/:id', requireAuth, (req, res) => {
  res.status(404).json({ error: 'Flows not available in lite mode' });
});

// Chatbot config (lite mode - disabled)
app.get('/api/accounts/:id/chatbot', requireAuth, (req, res) => {
  res.json({ enabled: false, message: 'Chatbot not available in lite mode' });
});

app.put('/api/accounts/:id/chatbot', requireAuth, (req, res) => {
  res.status(501).json({ error: 'Chatbot not available in lite mode' });
});

app.post('/api/accounts/:id/chatbot/test', requireAuth, (req, res) => {
  res.status(501).json({ error: 'Chatbot not available in lite mode' });
});

// Health check (also as /api/health for dashboard compatibility)
app.get('/api/health', async (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: '3.0-lite',
    uptime: process.uptime(),
    memory: { rss: Math.round(mem.rss / 1024 / 1024), heap: Math.round(mem.heapUsed / 1024 / 1024) },
    accounts: whatsapp.getAllAccountStatuses(),
    metrics: whatsapp.getMetrics()
  });
});

// Request new QR - alternate endpoint (dashboard uses this)
app.post('/api/accounts/:id/request-qr', requireAuth, async (req, res) => {
  try {
    await whatsapp.requestNewQRCode(req.params.id);
    res.json({ success: true, message: 'QR generation started' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PUBLIC ENDPOINTS FOR N8N/EXTERNAL SERVICES =====

// Public webhook endpoint - receives incoming data from external services
app.post('/webhook/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const messageData = req.body;

    // Validate accountId is UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID format' });
    }

    // Verify account exists
    const account = await db.getAccount(accountId);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Log the incoming webhook
    await db.logMessage({
      account_id: accountId,
      direction: 'webhook_incoming',
      status: 'success',
      message: JSON.stringify(messageData),
      created_at: new Date().toISOString()
    });

    res.json({ success: true, received_at: new Date().toISOString() });
  } catch (error) {
    logger.error('Error processing incoming webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Webhook reply - n8n uses this to send messages (authenticated via webhook secret)
app.post('/api/webhook-reply', async (req, res) => {
  try {
    const { account_id, number, message, webhook_secret, media, caption } = req.body;
    const isN8n = req.headers['user-agent']?.includes('n8n') || req.query.source === 'n8n';

    if (!account_id || !number) {
      return res.status(400).json({ error: 'account_id and number are required' });
    }

    // Validate at least message or media is provided
    if (!message && (!media || (!media.data && !media.url))) {
      return res.status(400).json({
        error: 'Either message text or media (with data or url) is required'
      });
    }

    // Verify webhook secret
    const webhooks = await db.getWebhooks(account_id);

    if (!webhooks || webhooks.length === 0) {
      return res.status(404).json({ error: 'No webhooks configured for this account' });
    }

    const validWebhook = webhooks.find(webhook =>
      webhook.secret === webhook_secret && webhook.is_active
    );

    if (!validWebhook) {
      logger.warn(`Invalid webhook secret attempt for account ${account_id}`);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    // For n8n requests, respond immediately and process in background
    if (isN8n) {
      res.json({ status: 'pending', message: 'Message queued for delivery' });

      // Process in background
      const sendPromise = media && (media.data || media.url) && media.mimetype
        ? whatsapp.sendMedia(account_id, number, media, caption || message || '')
        : whatsapp.sendMessage(account_id, number, message);

      sendPromise
        .then(result => logger.info(`Background message sent: ${result.success}`))
        .catch(err => logger.error(`Background message error:`, err));
    } else {
      // For regular clients, wait for result
      const result = media && (media.data || media.url) && media.mimetype
        ? await whatsapp.sendMedia(account_id, number, media, caption || message || '')
        : await whatsapp.sendMessage(account_id, number, message);

      res.json(result);
    }
  } catch (error) {
    logger.error('Error sending webhook reply:', error);
    res.status(500).json({ error: 'Failed to send message', message: error.message });
  }
});

// Test webhook endpoint - allows testing webhook configuration
app.post('/api/accounts/:accountId/webhooks/:webhookId/test', requireAuth, async (req, res) => {
  try {
    const { accountId, webhookId } = req.params;
    const webhook = await db.getWebhook(webhookId);
    
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    // Send test payload to webhook URL
    const axios = require('axios');
    const testPayload = {
      event: 'test',
      account_id: accountId,
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook from WhatsApp Gateway'
    };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'WhatsApp-Gateway-Lite/1.0',
      ...(webhook.headers || {})
    };

    if (webhook.secret) {
      headers['X-Webhook-Secret'] = webhook.secret;
    }

    const response = await axios.post(webhook.url, testPayload, {
      headers,
      timeout: 10000,
      validateStatus: () => true
    });

    res.json({
      success: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      message: response.status >= 200 && response.status < 300 
        ? 'Webhook test successful' 
        : `Webhook returned status ${response.status}`
    });
  } catch (error) {
    logger.error('Webhook test error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Failed to reach webhook URL'
    });
  }
});

// Toggle webhook active status
app.patch('/api/webhooks/:id/toggle', requireAuth, async (req, res) => {
  try {
    const webhook = await db.getWebhook(req.params.id);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    const updated = await db.updateWebhook(req.params.id, { 
      is_active: !webhook.is_active 
    });
    
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== AUTH ROUTES =====
app.post('/api/login', login);
app.post('/api/auth/login', login);  // Also support /api/auth/login
app.post('/api/logout', logout);
app.post('/api/auth/logout', logout);  // Also support /api/auth/logout
app.get('/api/auth/user', getCurrentUser);  // Get current user info

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, 'public')));
app.get('/login', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Startup
async function start() {
  try {
    // Test DB - simple check
    const accounts = await db.getAccounts();
    logger.info(`✅ Database connected (${accounts.length} accounts)`);

    // Start server
    server.listen(PORT, '0.0.0.0', async () => {
      logger.info(`🚀 Server running on port ${PORT} (LITE MODE)`);
      
      // Memory info
      const mem = process.memoryUsage();
      logger.info(`📊 Initial RAM: ${Math.round(mem.rss / 1024 / 1024)}MB`);

      // Init accounts
      await whatsapp.initializeExistingAccounts();
    });

  } catch (e) {
    logger.error('Startup failed:', e);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  await whatsapp.shutdown();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => {
  logger.error('Uncaught:', e);
  if (!e.message?.includes('EPIPE')) process.exit(1);
});

start();
