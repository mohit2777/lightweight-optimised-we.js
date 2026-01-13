/**
 * WhatsApp Gateway - Optimized for Render.com Free Tier
 * Removed: Flows, unnecessary debug endpoints, heavy middleware
 * Features: Accounts, Webhooks, Messaging, Chatbot, APIs
 * Target: < 512MB RAM
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs').promises;
const axios = require('axios');

const { db, supabase, MissingWebhookQueueTableError } = require('./config/database');
const whatsappManager = require('./utils/whatsappManager');
const webhookDeliveryService = require('./utils/webhookDeliveryService');
const logger = require('./utils/logger');
const { requireAuth, requireGuest, login, logout, getCurrentUser } = require('./middleware/auth');
const { validate, schemas } = require('./utils/validator');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE - Minimal for RAM savings
// ============================================================================

app.set('trust proxy', 1);

// Security (lightweight config)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Compression - saves bandwidth
app.use(compression());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// File uploads (memory storage - no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 } // 16MB max
});

// Session (in-memory - lightweight)
app.use(session({
  secret: process.env.SESSION_SECRET || 'optimized-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.SESSION_COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// SOCKET.IO
// ============================================================================

whatsappManager.setSocketIO(io);

io.on('connection', (socket) => {
  socket.emit('statuses', Object.fromEntries(whatsappManager.accountStatus));
  
  socket.on('subscribe-account', (accountId) => {
    socket.join(`account-${accountId}`);
  });
});

const emitToAll = (event, data) => io.emit(event, data);
const emitToAccount = (accountId, event, data) => io.to(`account-${accountId}`).emit(event, data);

// ============================================================================
// KEEP-ALIVE ENDPOINTS (for Render.com free tier)
// ============================================================================

// Ultra-lightweight ping - use with UptimeRobot or cron-job.org
app.get('/ping', (req, res) => res.send('pong'));

// Health check
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024)
    },
    accounts: whatsappManager.clients.size
  });
});

// Readiness check
app.get('/ready', async (req, res) => {
  try {
    await db.getAccounts();
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready', error: e.message });
  }
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.get('/login', requireGuest, (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/user', getCurrentUser);

// ============================================================================
// DASHBOARD
// ============================================================================

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// ============================================================================
// ACCOUNTS API
// ============================================================================

app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const enriched = accounts.map(a => ({
      ...a,
      status: whatsappManager.getAccountStatus(a.id) || a.status,
      runtime_status: whatsappManager.getAccountStatus(a.id)
    }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const account = await whatsappManager.createAccount(name.trim(), description || '');
    emitToAll('account-created', account);
    res.json(account);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const account = await db.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    account.status = whatsappManager.getAccountStatus(account.id) || account.status;
    res.json(account);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    await whatsappManager.deleteAccount(req.params.id);
    emitToAll('account-deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR Code endpoints
app.get('/api/accounts/:id/qr', requireAuth, (req, res) => {
  const qr = whatsappManager.getQRCode(req.params.id);
  if (qr) return res.json({ qr_code: qr });
  
  const status = whatsappManager.getAccountStatus(req.params.id);
  if (status === 'ready') return res.json({ status: 'ready' });
  
  res.status(202).json({ status: status || 'disconnected' });
});

app.post('/api/accounts/:id/request-qr', requireAuth, async (req, res) => {
  try {
    if (whatsappManager.isReconnecting(req.params.id)) {
      return res.status(202).json({ status: 'reconnecting' });
    }
    await whatsappManager.requestNewQRCode(req.params.id);
    res.json({ status: 'initializing' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:id/reconnect', requireAuth, async (req, res) => {
  try {
    const account = await db.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    const result = await whatsappManager.reconnectAccount(account, { forceReconnect: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// WEBHOOKS API
// ============================================================================

app.get('/api/accounts/:id/webhooks', requireAuth, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks(req.params.id);
    res.json(webhooks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    emitToAccount(req.params.id, 'webhook-created', webhook);
    res.json(webhook);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/accounts/:id/webhooks/:webhookId', requireAuth, async (req, res) => {
  try {
    await db.deleteWebhook(req.params.webhookId);
    emitToAccount(req.params.id, 'webhook-deleted', { id: req.params.webhookId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/webhooks/:id/toggle', requireAuth, async (req, res) => {
  try {
    const webhook = await db.getWebhook(req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Not found' });
    const updated = await db.updateWebhook(req.params.id, { is_active: !webhook.is_active });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:accountId/webhooks/:webhookId/test', requireAuth, async (req, res) => {
  try {
    const webhook = await db.getWebhook(req.params.webhookId);
    if (!webhook) return res.status(404).json({ error: 'Not found' });
    
    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      account_id: req.params.accountId,
      message: 'Test webhook from WhatsApp Gateway'
    };
    
    const headers = { 'Content-Type': 'application/json' };
    if (webhook.secret) headers['X-Webhook-Secret'] = webhook.secret;
    
    const response = await axios.post(webhook.url, testPayload, {
      headers,
      timeout: 10000,
      validateStatus: () => true
    });
    
    res.json({
      success: response.status >= 200 && response.status < 300,
      statusCode: response.status
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================================
// MESSAGING API
// ============================================================================

app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { account_id, number, message } = req.body;
    if (!account_id || !number || !message) {
      return res.status(400).json({ error: 'account_id, number, message required' });
    }
    const result = await whatsappManager.sendMessage(account_id, number, message);
    emitToAccount(account_id, 'message-sent', result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-media', requireAuth, upload.single('media'), async (req, res) => {
  try {
    const { account_id, number, caption } = req.body;
    const file = req.file;
    
    if (!account_id || !number || !file) {
      return res.status(400).json({ error: 'account_id, number, media required' });
    }
    
    const mediaData = {
      data: file.buffer.toString('base64'),
      mimetype: file.mimetype,
      filename: file.originalname
    };
    
    const result = await whatsappManager.sendMedia(account_id, number, mediaData, caption || '');
    emitToAccount(account_id, 'media-sent', result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-buttons', requireAuth, (req, res) => {
  res.status(501).json({ error: 'Button messages not supported by WhatsApp Web' });
});

// ============================================================================
// PUBLIC WEBHOOK ENDPOINTS (for n8n/external)
// ============================================================================

app.post('/webhook/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
      return res.status(400).json({ error: 'Invalid account ID' });
    }
    
    const account = await db.getAccount(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    
    await db.logMessage({
      account_id: accountId,
      direction: 'webhook_incoming',
      status: 'success',
      message: JSON.stringify(req.body),
      created_at: new Date().toISOString()
    });
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/webhook-reply', async (req, res) => {
  try {
    const { account_id, number, message, webhook_secret, media, caption } = req.body;
    
    if (!account_id || !number) {
      return res.status(400).json({ error: 'account_id and number required' });
    }
    
    if (!message && !media) {
      return res.status(400).json({ error: 'message or media required' });
    }
    
    // Verify webhook secret
    const webhooks = await db.getWebhooks(account_id);
    const validWebhook = webhooks.find(w => w.secret === webhook_secret && w.is_active);
    
    if (!validWebhook) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    
    // Respond immediately for n8n
    const isN8n = req.headers['user-agent']?.includes('n8n');
    if (isN8n) {
      res.json({ status: 'queued' });
      
      (async () => {
        try {
          if (media?.mimetype) {
            await whatsappManager.sendMedia(account_id, number, media, caption || message || '');
          } else {
            await whatsappManager.sendMessage(account_id, number, message);
          }
        } catch (e) {
          logger.error('Background send error:', e.message);
        }
      })();
    } else {
      const result = media?.mimetype
        ? await whatsappManager.sendMedia(account_id, number, media, caption || message || '')
        : await whatsappManager.sendMessage(account_id, number, message);
      res.json(result);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// CHATBOT API
// ============================================================================

let chatbotManager = null;

const getChatbotManager = () => {
  if (!chatbotManager) {
    try {
      chatbotManager = require('./utils/chatbot');
    } catch (e) {
      logger.warn('Chatbot module not available');
    }
  }
  return chatbotManager;
};

app.get('/api/accounts/:id/chatbot', requireAuth, async (req, res) => {
  try {
    const config = await db.getChatbotConfig(req.params.id);
    res.json(config || { enabled: false });
  } catch (e) {
    res.json({ enabled: false });
  }
});

app.put('/api/accounts/:id/chatbot', requireAuth, async (req, res) => {
  try {
    const config = await db.saveChatbotConfig(req.params.id, req.body);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:id/chatbot/test', requireAuth, async (req, res) => {
  try {
    const mgr = getChatbotManager();
    if (!mgr) return res.status(501).json({ error: 'Chatbot not available' });
    
    const { message } = req.body;
    const response = await mgr.testConfig(req.params.id, message || 'Hello');
    res.json({ response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// STATS & LOGS API
// ============================================================================

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const activeCount = accounts.filter(a => 
      whatsappManager.getAccountStatus(a.id) === 'ready'
    ).length;
    
    let totalMessages = 0, incoming = 0, outgoing = 0, failed = 0;
    
    for (const account of accounts) {
      const stats = await db.getMessageStats(account.id);
      totalMessages += stats.total || 0;
      incoming += stats.incoming || 0;
      outgoing += stats.outgoing || 0;
      failed += stats.failed || 0;
    }
    
    res.json({
      totalAccounts: accounts.length,
      activeAccounts: activeCount,
      totalMessages,
      incomingMessages: incoming,
      outgoingMessages: outgoing,
      failedMessages: failed,
      successRate: outgoing > 0 ? Math.round(((outgoing - failed) / outgoing) * 100) : 0,
      metrics: whatsappManager.getMetrics()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const logs = await db.getAllMessageLogs(limit, 0);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts/:id/logs', requireAuth, async (req, res) => {
  try {
    const logs = await db.getMessageLogs(req.params.id, 100);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const logFile = path.join(__dirname, 'logs', 'combined.log');
    const content = await fs.readFile(logFile, 'utf8').catch(() => '');
    const lines = content.trim().split('\n').slice(-100).reverse();
    const logs = lines.map(line => {
      try { return JSON.parse(line); } catch { return { message: line }; }
    });
    res.json({ logs });
  } catch (e) {
    res.json({ logs: [] });
  }
});

// ============================================================================
// FLOWS API (Disabled - returns empty/501)
// ============================================================================

app.get('/api/chatbot/flows', requireAuth, (req, res) => res.json([]));
app.get('/api/chatbot/flows/:id', requireAuth, (req, res) => res.status(404).json({ error: 'Flows disabled' }));
app.post('/api/chatbot/flows', requireAuth, (req, res) => res.status(501).json({ error: 'Flows disabled' }));
app.put('/api/chatbot/flows/:id', requireAuth, (req, res) => res.status(501).json({ error: 'Flows disabled' }));
app.delete('/api/chatbot/flows/:id', requireAuth, (req, res) => res.status(501).json({ error: 'Flows disabled' }));

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
});

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
  try {
    logger.info('Starting WhatsApp Gateway (Optimized)...');
    
    // Ensure directories
    const fsExtra = require('fs-extra');
    await fsExtra.ensureDir('./wa-sessions-temp');
    await fsExtra.ensureDir('./logs');
    
    // Init WhatsApp accounts
    await whatsappManager.initializeExistingAccounts();
    
    // Start webhook service
    try {
      await webhookDeliveryService.start();
    } catch (e) {
      logger.warn('Webhook service start failed:', e.message);
    }
    
    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📊 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
    });
    
  } catch (e) {
    logger.error('Startup failed:', e);
    process.exit(1);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  
  webhookDeliveryService.stop();
  await whatsappManager.shutdown();
  await db.flushMessageQueue();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  setTimeout(() => process.exit(1), 30000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  const msg = err?.message || '';
  if (msg.includes('timeout') || msg.includes('ECONNRESET')) {
    logger.warn('Recoverable error:', msg);
    return;
  }
  logger.error('Fatal error:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || '';
  if (msg.includes('timeout') || msg.includes('ECONNRESET')) return;
  logger.error('Unhandled rejection:', reason);
});

start();

module.exports = { app, server, io };
