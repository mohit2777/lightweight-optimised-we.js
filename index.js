const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs').promises;
const axios = require('axios');
const os = require('os');
require('dotenv').config();
const pg = require('pg');
const pgSession = require('connect-pg-simple')(session);

const { requireAuth, requireGuest, checkSessionTimeout, login, logout, getCurrentUser, verifySessionIntegrity } = require('./middleware/auth');
const { db, supabase, MissingWebhookQueueTableError } = require('./config/database');
const whatsappManager = require('./utils/whatsappManager');
const webhookDeliveryService = require('./utils/webhookDeliveryService');
const aiAutoReplyService = require('./utils/aiAutoReply');
const logger = require('./utils/logger');
const { validate, schemas } = require('./utils/validator');
const { apiLimiter, authLimiter, messageLimiter, webhookLimiter, accountLimiter } = require('./utils/rateLimiter');
const flowRoutes = require('./routes/flowRoutes');

const app = express();

// Trust proxy (required for Render/Heroku SSL)
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  }
});



// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers like onclick
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Compression
app.use(compression());

// CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true
}));

// Body parsers with increased limits for media
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB
  }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration with enhanced security
// Use MemoryStore for simplicity - sessions will reset on server restart
// To enable persistent sessions, set DATABASE_URL or SUPABASE_DB_PASSWORD
let sessionStore = new session.MemoryStore();

// Check for DATABASE_URL first (Render/Heroku style), then fall back to SUPABASE_DB_PASSWORD
if (process.env.DATABASE_URL) {
  try {
    const pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      max: 3
    });
    
    pgPool.on('error', (err) => {
      logger.error('Session DB pool error:', err.message);
    });
    
    sessionStore = new pgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: true,
      pruneSessionInterval: false,
      errorLog: (err) => logger.error('Session store error:', err.message)
    });
    
    logger.info('Using PostgreSQL for session storage (DATABASE_URL)');
  } catch (e) {
    logger.error('PostgreSQL session setup failed, using MemoryStore:', e.message);
    sessionStore = new session.MemoryStore();
  }
} else if (process.env.SUPABASE_DB_PASSWORD) {
  try {
    const supabaseUrl = new URL(process.env.SUPABASE_URL);
    const projectRef = supabaseUrl.hostname.split('.')[0];
    
    const pgPool = new pg.Pool({
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: process.env.SUPABASE_DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      family: 4,
      connectionTimeoutMillis: 5000,
      max: 3
    });
    
    pgPool.on('error', (err) => {
      logger.error('Session DB pool error:', err.message);
    });
    
    sessionStore = new pgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: true,
      pruneSessionInterval: false,
      errorLog: (err) => logger.error('Session store error:', err.message)
    });
    
    logger.info('Using PostgreSQL for session storage (SUPABASE_DB_PASSWORD)');
  } catch (e) {
    logger.error('PostgreSQL session setup failed, using MemoryStore:', e.message);
    sessionStore = new session.MemoryStore();
  }
} else {
  logger.info('Using MemoryStore for sessions (set DATABASE_URL or SUPABASE_DB_PASSWORD for persistence)');
}

// Generate a secure session secret if not provided
const sessionSecret = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  logger.warn('WARNING: Using auto-generated SESSION_SECRET. Set SESSION_SECRET in .env for persistent sessions.');
}

// Determine if we should use secure cookies
// Only use secure in production AND when explicitly enabled (for HTTPS deployments)
const useSecureCookies = process.env.SESSION_COOKIE_SECURE === 'true';
if (process.env.NODE_ENV === 'production' && !useSecureCookies) {
  logger.warn('WARNING: Running in production without secure cookies. Set SESSION_COOKIE_SECURE=true if using HTTPS.');
}

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  name: 'wa.sid', // Custom session cookie name (not default 'connect.sid')
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset cookie expiration on each request
  cookie: {
    secure: useSecureCookies,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: useSecureCookies ? 'strict' : 'lax' // Use lax for non-HTTPS to prevent issues
  }
}));

// Session timeout check
app.use(checkSessionTimeout);

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// ============================================================================
// SOCKET.IO
// ============================================================================

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });

  socket.on('subscribe-account', (accountId) => {
    socket.join(`account-${accountId}`);
    logger.debug(`Socket ${socket.id} subscribed to account ${accountId}`);
  });
});

// Helper function to emit socket events
const emitToAll = (event, data) => {
  io.emit(event, data);
};

const emitToAccount = (accountId, event, data) => {
  io.to(`account-${accountId}`).emit(event, data);
};

// Keepalive ping (optional Render/Railway wake-up)
const keepAliveUrl = process.env.KEEPALIVE_URL;
const keepAliveIntervalMs = Math.max((parseInt(process.env.KEEPALIVE_INTERVAL_MINUTES, 10) || 14) * 60 * 1000, 60 * 1000);
let keepAliveTimer = null;

const startKeepAlivePing = () => {
  if (!keepAliveUrl) {
    return;
  }

  const ping = async () => {
    try {
      const response = await axios.get(keepAliveUrl, { timeout: 5000 });
      logger.info(`Keepalive ping ${response.status} -> ${keepAliveUrl}`);
    } catch (error) {
      logger.warn(`Keepalive ping failed for ${keepAliveUrl}: ${error.message}`);
    }
  };

  ping();
  keepAliveTimer = setInterval(ping, keepAliveIntervalMs);
  logger.info(`Keepalive ping enabled for ${keepAliveUrl} every ${keepAliveIntervalMs / 60000} minutes`);
};

const stopKeepAlivePing = () => {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
};

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

app.get('/login', requireGuest, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/api/auth/login', authLimiter, validate(schemas.login), login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/user', getCurrentUser);

app.get('/api/auth/user', getCurrentUser);

// Flow Builder API
app.use('/api/chatbot', flowRoutes);

// ============================================================================
// DASHBOARD ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.redirect('/dashboard');
});

app.get('/flow-builder', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'flow-builder.html'));
});

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const queueStatus = db.getQueueStatus();
    const cacheStats = db.getCacheStats();
    const metrics = whatsappManager.getMetrics();
    let webhookQueue;
    try {
      webhookQueue = await db.getWebhookQueueStats();
    } catch (error) {
      if (error instanceof MissingWebhookQueueTableError) {
        webhookQueue = { error: 'missing_table' };
      } else {
        throw error;
      }
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      systemMemory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      queue: queueStatus,
      cache: cacheStats,
      webhookQueue,
      metrics
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
});

// ============================================================================
// ACCOUNTS API
// ============================================================================

app.get('/api/accounts', requireAuth, apiLimiter, async (req, res) => {
  try {
    const accounts = await db.getAccounts();

    // Get webhooks, chatbot configs, and flows for all accounts in parallel (with error handling)
    let allWebhooks = [], allChatbotConfigs = [], allFlows = [];
    try {
      [allWebhooks, allChatbotConfigs, allFlows] = await Promise.all([
        supabase.from('webhooks').select('account_id, is_active').then(r => r.data || []),
        supabase.from('ai_auto_replies').select('account_id, is_active').then(r => r.data || []),
        supabase.from('chatbot_flows').select('account_id, is_active').then(r => r.data || [])
      ]);
    } catch (featureErr) {
      logger.warn('Could not fetch feature indicators:', featureErr.message);
    }

    // Enrich with real-time status from WhatsApp manager (overrides DB status)
    const enrichedAccounts = accounts.map(account => {
      const runtimeStatus = whatsappManager.getAccountStatus(account.id);
      
      // Get feature indicators for this account
      const accountWebhooks = allWebhooks.filter(w => w.account_id === account.id);
      const accountChatbot = allChatbotConfigs.find(c => c.account_id === account.id);
      const accountFlows = allFlows.filter(f => f.account_id === account.id);
      
      return {
        ...account,
        runtime_status: runtimeStatus,
        // Use runtime status if available, otherwise fall back to DB status
        status: runtimeStatus || account.status,
        // Feature indicators
        features: {
          webhooks: {
            count: accountWebhooks.length,
            active: accountWebhooks.filter(w => w.is_active).length
          },
          chatbot: {
            enabled: accountChatbot?.is_active || false
          },
          flows: {
            count: accountFlows.length,
            active: accountFlows.filter(f => f.is_active).length
          }
        }
      };
    });

    res.json(enrichedAccounts);
  } catch (error) {
    logger.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

app.post('/api/accounts', requireAuth, accountLimiter, validate(schemas.createAccount), async (req, res) => {
  try {
    const { name, description } = req.body;

    const account = await whatsappManager.createAccount(name, description);

    // Emit socket event
    emitToAll('account-created', account);

    res.json(account);
  } catch (error) {
    logger.error('Error creating account:', error);
    res.status(500).json({ error: 'Failed to create account', message: error.message });
  }
});

app.get('/api/accounts/:id', requireAuth, apiLimiter, async (req, res) => {
  try {
    const account = await db.getAccount(req.params.id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Add runtime status and override DB status if manager has better info
    const runtimeStatus = whatsappManager.getAccountStatus(account.id);
    account.runtime_status = runtimeStatus;

    // Use runtime status if available (more accurate than DB)
    if (runtimeStatus) {
      account.status = runtimeStatus;
    }

    res.json(account);
  } catch (error) {
    logger.error(`Error fetching account ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

app.delete('/api/accounts/:id', requireAuth, apiLimiter, async (req, res) => {
  try {
    await whatsappManager.deleteAccount(req.params.id);

    // Emit socket event
    emitToAll('account-deleted', { id: req.params.id });

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error deleting account ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete account', message: error.message });
  }
});

// Get QR code
app.get('/api/accounts/:id/qr', requireAuth, apiLimiter, async (req, res) => {
  const accountId = req.params.id;

  try {
    const qrCode = whatsappManager.getQRCode(accountId);

    if (qrCode) {
      return res.json({ qr_code: qrCode });
    }

    const runtimeStatus = whatsappManager.getAccountStatus(accountId);

    if (runtimeStatus === 'ready') {
      return res.json({ status: 'ready' });
    }

    // If we are not reconnecting and not ready, we should probably try to get a QR code
    if (!whatsappManager.isReconnecting(accountId)) {
      try {
        // Force a new QR code generation
        const result = await whatsappManager.requestNewQRCode(accountId);
        return res.status(202).json({ status: result?.status || 'initializing' });
      } catch (error) {
        if (error.message === 'Account not found') {
          return res.status(404).json({ error: 'Account not found' });
        }
        throw error;
      }
    }

    return res.status(202).json({ status: runtimeStatus || 'initializing' });
  } catch (error) {
    logger.error(`Error fetching QR code for ${accountId}:`, error);
    res.status(500).json({ error: 'Failed to fetch QR code' });
  }
});

// Reconnect account endpoint
app.post('/api/accounts/:id/reconnect', requireAuth, apiLimiter, async (req, res) => {
  const accountId = req.params.id;
  try {
    const account = await db.getAccount(accountId);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const result = await whatsappManager.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'user_request'
    });

    res.json(result);
  } catch (error) {
    logger.error(`Error reconnecting account ${accountId}:`, error);
    res.status(500).json({ error: 'Failed to reconnect account' });
  }
});

// ============================================================================
// WEBHOOKS API
// ============================================================================

app.get('/api/accounts/:id/webhooks', requireAuth, apiLimiter, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks(req.params.id);
    res.json(webhooks);
  } catch (error) {
    logger.error(`Error fetching webhooks for account ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

app.post('/api/accounts/:id/webhooks', requireAuth, webhookLimiter, async (req, res) => {
  try {
    const { url, secret, is_active } = req.body;
    const account_id = req.params.id;

    if (!url) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    const webhookData = {
      id: require('uuid').v4(),
      account_id,
      url,
      secret: secret || null,
      is_active: is_active !== false,
      created_at: new Date().toISOString()
    };

    const webhook = await db.createWebhook(webhookData);

    // Emit socket event
    emitToAccount(account_id, 'webhook-created', webhook);

    res.json(webhook);
  } catch (error) {
    logger.error('Error creating webhook:', error);
    res.status(500).json({ error: 'Failed to create webhook', message: error.message });
  }
});

app.delete('/api/accounts/:accountId/webhooks/:webhookId', requireAuth, apiLimiter, async (req, res) => {
  try {
    const { accountId, webhookId } = req.params;

    await db.deleteWebhook(webhookId);

    // Emit socket event
    emitToAccount(accountId, 'webhook-deleted', { id: webhookId });

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error deleting webhook ${req.params.webhookId}:`, error);
    res.status(500).json({ error: 'Failed to delete webhook', message: error.message });
  }
});

// Test webhook endpoint
app.post('/api/accounts/:accountId/webhooks/:webhookId/test', requireAuth, apiLimiter, async (req, res) => {
  try {
    const { accountId, webhookId } = req.params;

    // Fetch the webhook
    const webhook = await db.getWebhook(webhookId);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    // Send a test payload
    const axios = require('axios');
    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      account_id: accountId,
      message: 'This is a test webhook from WhatsApp Multi-Automation',
      data: {
        test: true,
        webhook_id: webhookId
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'WA-Multi-Automation-Webhook/1.0'
    };

    // Add signature if secret is configured
    if (webhook.secret) {
      const crypto = require('crypto');
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(testPayload))
        .digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    const response = await axios.post(webhook.url, testPayload, {
      headers,
      timeout: 10000,
      validateStatus: () => true // Don't throw on any status code
    });

    if (response.status >= 200 && response.status < 300) {
      res.json({ 
        success: true, 
        statusCode: response.status,
        message: 'Webhook test successful'
      });
    } else {
      res.json({ 
        success: false, 
        statusCode: response.status,
        error: `Webhook returned status ${response.status}`
      });
    }

  } catch (error) {
    logger.error(`Error testing webhook ${req.params.webhookId}:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to test webhook'
    });
  }
});

app.post('/api/webhooks', requireAuth, webhookLimiter, validate(schemas.createWebhook), async (req, res) => {
  try {
    const { account_id, url, secret, is_active } = req.body;

    const webhookData = {
      id: require('uuid').v4(),
      account_id,
      url,
      secret: secret || '',
      is_active: is_active !== false,
      created_at: new Date().toISOString()
    };

    const webhook = await db.createWebhook(webhookData);

    // Emit socket event
    emitToAccount(account_id, 'webhook-created', webhook);

    res.json(webhook);
  } catch (error) {
    logger.error('Error creating webhook:', error);
    res.status(500).json({ error: 'Failed to create webhook', message: error.message });
  }
});

app.patch('/api/webhooks/:id/toggle', requireAuth, apiLimiter, async (req, res) => {
  try {
    const webhook = await db.getWebhook(req.params.id);

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const updatedWebhook = await db.updateWebhook(req.params.id, {
      is_active: !webhook.is_active,
      updated_at: new Date().toISOString()
    });

    // Emit socket event
    emitToAccount(webhook.account_id, 'webhook-updated', updatedWebhook);

    res.json(updatedWebhook);
  } catch (error) {
    logger.error(`Error toggling webhook ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to toggle webhook' });
  }
});

app.delete('/api/webhooks/:id', requireAuth, apiLimiter, async (req, res) => {
  try {
    const webhook = await db.getWebhook(req.params.id);

    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    await db.deleteWebhook(req.params.id);

    // Emit socket event
    emitToAccount(webhook.account_id, 'webhook-deleted', { id: req.params.id });

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error deleting webhook ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete webhook', message: error.message });
  }
});

// Get webhook secrets (for n8n configuration)
app.get('/api/accounts/:id/webhook-secrets', requireAuth, apiLimiter, async (req, res) => {
  try {
    const webhooks = await db.getWebhooks(req.params.id);
    const webhookSecrets = webhooks.map(webhook => ({
      id: webhook.id,
      url: webhook.url,
      secret: webhook.secret,
      is_active: webhook.is_active
    }));
    res.json(webhookSecrets);
  } catch (error) {
    logger.error(`Error fetching webhook secrets for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch webhook secrets' });
  }
});

// ============================================================================
// MESSAGING API
// ============================================================================

// Send text message
app.post('/api/send', requireAuth, messageLimiter, validate(schemas.sendMessage), async (req, res) => {
  try {
    const { account_id, number, message } = req.body;

    const result = await whatsappManager.sendMessage(account_id, number, message);

    // Emit socket event
    emitToAccount(account_id, 'message-sent', result);

    res.json(result);
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message', message: error.message });
  }
});

// Send media
app.post('/api/send-media', requireAuth, messageLimiter, upload.single('media'), async (req, res) => {
  try {
    const { account_id, number, caption } = req.body;
    const file = req.file;

    if (!account_id || !number) {
      return res.status(400).json({ error: 'account_id and number are required' });
    }

    if (!file) {
      return res.status(400).json({ error: 'Media file is required' });
    }

    // Convert file to base64
    const mediaData = {
      data: file.buffer.toString('base64'),
      mimetype: file.mimetype,
      filename: file.originalname
    };

    const result = await whatsappManager.sendMedia(
      account_id,
      number,
      mediaData,
      caption || '',
      {}
    );

    // Emit socket event
    emitToAccount(account_id, 'media-sent', result);

    res.json(result);
  } catch (error) {
    logger.error('Error sending media:', error);
    res.status(500).json({ error: 'Failed to send media', message: error.message });
  }
});

// Send buttons
app.post('/api/send-buttons', requireAuth, messageLimiter, upload.single('media'), async (req, res) => {
  try {
    const { account_id, number, body, title, footer } = req.body;
    let { buttons } = req.body;
    const file = req.file;

    if (!account_id || !number || !buttons) {
      return res.status(400).json({ error: 'Missing required fields: account_id, number, buttons' });
    }

    // Parse buttons if it's a string (when using FormData)
    if (typeof buttons === 'string') {
      try {
        buttons = JSON.parse(buttons);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid buttons format. Must be a JSON array.' });
      }
    }

    // Prepare media if file is uploaded
    let media = null;
    if (file) {
      media = {
        data: file.buffer.toString('base64'),
        mimetype: file.mimetype,
        filename: file.originalname
      };
    }

    // If sending media buttons, body is optional (or used as caption if supported, but here we pass it as content if no media)
    // If media is present, whatsappManager uses media as content. 
    // Note: whatsapp-web.js Buttons constructor takes (body, buttons, title, footer). 
    // If body is MessageMedia, it sends media. 
    // If we want text AND media, it's complicated. 
    // For now, if media is present, 'body' text from request might be ignored by whatsappManager logic 
    // unless we pass it as title/footer or if Buttons supports caption.
    // However, let's pass 'body' as is. If media is present, whatsappManager uses media as content.
    // If the user wants a caption, they might need to put it in title or footer, or we rely on library behavior.

    // Actually, looking at my whatsappManager change:
    // let content = body;
    // if (media) content = new MessageMedia(...)
    // So if media is present, body text is ignored as the main content.

    const result = await whatsappManager.sendButtons(account_id, number, body, buttons, title, footer, media);

    // Emit socket event
    emitToAccount(account_id, 'message-sent', result);

    res.json(result);
  } catch (error) {
    logger.error('Error sending buttons:', error);
    res.status(500).json({ error: 'Failed to send buttons', message: error.message });
  }
});

// Send list
app.post('/api/send-list', requireAuth, messageLimiter, async (req, res) => {
  try {
    const { account_id, number, body, button_text, sections, title, footer } = req.body;

    if (!account_id || !number || !body || !button_text || !sections) {
      return res.status(400).json({ error: 'Missing required fields: account_id, number, body, button_text, sections' });
    }

    const result = await whatsappManager.sendList(account_id, number, body, button_text, sections, title, footer);

    // Emit socket event
    emitToAccount(account_id, 'message-sent', result);

    res.json(result);
  } catch (error) {
    logger.error('Error sending list:', error);
    res.status(500).json({ error: 'Failed to send list', message: error.message });
  }
});

// ============================================================================
// AI AUTO-REPLY / CHATBOT CONFIG API
// ============================================================================

// Get AI config for an account
app.get('/api/accounts/:id/chatbot', requireAuth, apiLimiter, async (req, res) => {
  try {
    const config = await db.getAiConfig(req.params.id);
    res.json(config || {});
  } catch (error) {
    logger.error(`Error fetching AI config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch AI configuration' });
  }
});

// Save AI config
app.post('/api/accounts/:id/chatbot', requireAuth, apiLimiter, async (req, res) => {
  try {
    const accountId = req.params.id;
    const { provider, model, api_key, system_prompt, temperature, is_active } = req.body;

    if (!provider || !model) {
      return res.status(400).json({ error: 'Provider and model are required' });
    }

    if (is_active && !api_key) {
      return res.status(400).json({ error: 'API key is required when enabling AI replies' });
    }

    const saved = await aiAutoReplyService.saveConfig(accountId, {
      provider,
      model,
      api_key,
      system_prompt,
      temperature,
      is_active
    });

    res.json(saved);
  } catch (error) {
    logger.error(`Error saving AI config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to save AI configuration', message: error.message });
  }
});

// Delete AI config
app.delete('/api/accounts/:id/chatbot', requireAuth, apiLimiter, async (req, res) => {
  try {
    await aiAutoReplyService.deleteConfig(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error(`Error deleting AI config for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete AI configuration' });
  }
});

// Test AI config with a single prompt (does not store config)
app.post('/api/accounts/:id/chatbot/test', requireAuth, apiLimiter, async (req, res) => {
  try {
    const accountId = req.params.id;
    const { provider, model, api_key, system_prompt, temperature, message } = req.body;

    if (!provider || !model || !api_key) {
      return res.status(400).json({ error: 'Provider, model, and API key are required for testing' });
    }

    const testMessage = message || 'Hello, this is a test message.';
    const responseText = await aiAutoReplyService.testConfig({
      accountId,
      provider,
      model,
      api_key,
      system_prompt,
      temperature,
      message: testMessage
    });

    if (!responseText) {
      return res.status(500).json({ error: 'No response generated from AI provider' });
    }

    res.json({ response: responseText });
  } catch (error) {
    logger.error(`Error testing AI config for ${req.params.id}:`, error.response?.data || error.message);
    res.status(500).json({ error: 'AI test failed', details: error.message });
  }
});

// Webhook reply (authenticated via webhook secret)
app.post('/api/webhook-reply', apiLimiter, validate(schemas.webhookReply), async (req, res) => {
  try {
    const { account_id, number, message, webhook_secret, media, caption } = req.body;
    const isN8n = req.headers['user-agent']?.includes('n8n') || req.query.source === 'n8n';

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
        ? whatsappManager.sendMedia(account_id, number, media, caption || message || '')
        : whatsappManager.sendMessage(account_id, number, message);

      sendPromise
        .then(result => logger.info(`Background message sent: ${result.success}`))
        .catch(err => logger.error(`Background message error:`, err));
    } else {
      // For regular clients, wait for result
      const result = media && (media.data || media.url) && media.mimetype
        ? await whatsappManager.sendMedia(account_id, number, media, caption || message || '')
        : await whatsappManager.sendMessage(account_id, number, message);

      res.json(result);
    }
  } catch (error) {
    logger.error('Error sending webhook reply:', error);
    res.status(500).json({ error: 'Failed to send message', message: error.message });
  }
});

// ============================================================================
// MESSAGE LOGS API
// ============================================================================

app.get('/api/accounts/:id/logs', requireAuth, apiLimiter, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const logs = await db.getMessageLogs(req.params.id, limit);
    res.json(logs);
  } catch (error) {
    logger.error(`Error fetching logs for account ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch message logs' });
  }
});

// Get all messages across all accounts
app.get('/api/messages', requireAuth, apiLimiter, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Get all messages from database
    const logs = await db.getAllMessageLogs(limit, offset);
    res.json(logs);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================================================
// STATISTICS API
// ============================================================================

app.get('/api/stats', requireAuth, apiLimiter, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const totalAccounts = accounts.length;
    const activeAccounts = accounts.filter(a =>
      whatsappManager.getAccountStatus(a.id) === 'ready'
    ).length;

    let totalMessages = 0;
    let successMessages = 0;
    let incomingMessages = 0;
    let outgoingMessages = 0;
    let failedMessages = 0;

    const accountStats = [];

    // Parallelize stats fetching
    const statsPromises = accounts.map(async (account) => {
      const stats = await db.getMessageStats(account.id);
      return {
        account,
        stats
      };
    });

    const results = await Promise.all(statsPromises);

    let totalOutgoingSuccess = 0;

    for (const { account, stats } of results) {
      totalMessages += stats.total;
      successMessages += stats.success;
      incomingMessages += stats.incoming;
      outgoingMessages += stats.outgoing;
      failedMessages += stats.failed;
      totalOutgoingSuccess += (stats.outgoing_success || 0);

      accountStats.push({
        id: account.id,
        name: account.name || 'Unnamed',
        total: stats.total,
        success: stats.success,
        failed: stats.failed,
        incoming: stats.incoming,
        outgoing: stats.outgoing
      });
    }

    // Calculate success rate based on OUTGOING messages only
    // Success Rate = (Successful Outgoing / Total Outgoing) * 100
    const successRate = outgoingMessages > 0 ? Math.round((totalOutgoingSuccess / outgoingMessages) * 100) : 0;
    const dailyStats = await db.getDailyMessageStats(7);

    res.json({
      totalAccounts,
      activeAccounts,
      totalMessages,
      successMessages: totalOutgoingSuccess, // Send outgoing success count instead of total success for charts
      incomingMessages,
      outgoingMessages,
      failedMessages,
      successRate,
      dailyStats,
      accountStats, // Added this
      queueStatus: db.getQueueStatus(),
      metrics: whatsappManager.getMetrics()
    });
  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================================================
// PUBLIC WEBHOOK ENDPOINT
// ============================================================================

app.post('/webhook/:accountId', apiLimiter, async (req, res) => {
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

    // Validate messageData is not empty
    if (!messageData || typeof messageData !== 'object') {
      return res.status(400).json({ error: 'Invalid message data' });
    }

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

// ============================================================================
// VIEW ROUTES (JSON endpoints for dashboard)
// ============================================================================

app.get('/views/dashboard', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    let totalMessages = 0;
    let successMessages = 0;

    for (const account of accounts) {
      const stats = await db.getMessageStats(account.id);
      totalMessages += stats.total;
      successMessages += stats.success;
    }

    const stats = {
      total: totalMessages,
      success: successMessages,
      successRate: totalMessages > 0 ? Math.round((successMessages / totalMessages) * 100) : 0
    };

    res.json({ accounts, stats });
  } catch (error) {
    logger.error('Error loading dashboard data:', error);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

app.get('/views/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    res.json(accounts);
  } catch (error) {
    logger.error('Error loading accounts:', error);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

app.get('/views/webhooks', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const webhooks = {};

    for (const account of accounts) {
      webhooks[account.id] = await db.getWebhooks(account.id);
    }

    res.json({ accounts, webhooks });
  } catch (error) {
    logger.error('Error loading webhooks:', error);
    res.status(500).json({ error: 'Failed to load webhooks' });
  }
});

app.get('/views/messages', requireAuth, async (req, res) => {
  try {
    const accounts = await db.getAccounts();
    const messages = {};

    for (const account of accounts) {
      messages[account.id] = await db.getMessageLogs(account.id, 50);
    }

    res.json({ accounts, messages });
  } catch (error) {
    logger.error('Error loading messages:', error);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ============================================================================
// HEALTH CHECK & MONITORING ENDPOINTS (Must be before 404 handler)
// ============================================================================

// Ultra-lightweight ping endpoint for UptimeRobot/Cron-job.org (keeps Render awake)
// Configure UptimeRobot to ping this every 5 minutes for 100% uptime
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Diagnostic endpoint to check Puppeteer/Chromium setup
app.get('/api/debug/puppeteer', async (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  const diagnostics = {
    puppeteerPath: process.env.PUPPETEER_EXECUTABLE_PATH || 'NOT SET',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    memory: {
      total: Math.round(require('os').totalmem() / 1024 / 1024) + 'MB',
      free: Math.round(require('os').freemem() / 1024 / 1024) + 'MB',
      used: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
    },
    chromiumExists: false,
    chromiumVersion: null,
    envVars: {
      PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || 'NOT SET',
      PUPPETEER_SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_DOWNLOAD || 'NOT SET',
      NODE_ENV: process.env.NODE_ENV || 'NOT SET'
    }
  };
  
  // Check if chromium exists
  const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  try {
    if (fs.existsSync(chromiumPath)) {
      diagnostics.chromiumExists = true;
      try {
        diagnostics.chromiumVersion = execSync(`${chromiumPath} --version 2>/dev/null`).toString().trim();
      } catch (e) {
        diagnostics.chromiumVersion = 'Could not get version: ' + e.message;
      }
    }
  } catch (e) {
    diagnostics.chromiumError = e.message;
  }
  
  // Check alternative paths
  const altPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  diagnostics.availableChromium = altPaths.filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  
  res.json(diagnostics);
});

// Test Puppeteer launch endpoint
app.get('/api/debug/test-puppeteer', async (req, res) => {
  const puppeteer = require('puppeteer-core');
  const result = {
    success: false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    error: null,
    browserVersion: null
  };
  
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: result.executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ],
      timeout: 30000
    });
    
    result.browserVersion = await browser.version();
    result.success = true;
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack?.split('\n').slice(0, 5);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
  
  res.json(result);
});

// Webhook-style endpoint for UptimeRobot (alternative to /ping)
app.post('/webhook/keepalive', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime())
  });
});

// Health check for monitoring services (no auth required)
app.get('/health', async (req, res) => {
  try {
    let queueStats;
    try {
      queueStats = await db.getWebhookQueueStats();
    } catch (error) {
      if (error instanceof MissingWebhookQueueTableError) {
        queueStats = { error: 'missing_table' };
      } else {
        throw error;
      }
    }

    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: {
        used: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.floor(process.memoryUsage().rss / 1024 / 1024)
      },
      accounts: {
        total: whatsappManager.clients.size,
        connected: Array.from(whatsappManager.accountStatus.values())
          .filter(s => s === 'ready').length
      },
      webhookQueue: queueStats
    };

    res.json(health);
  } catch (error) {
    logger.error('Health endpoint error:', error);
    res.status(500).json({ status: 'error', message: 'Health check failed' });
  }
});

// Readiness check for Render (checks database connection)
app.get('/ready', async (req, res) => {
  try {
    await db.getAccounts();
    res.json({
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Readiness check failed:', error);
    res.status(503).json({
      status: 'not ready',
      database: 'disconnected',
      error: error.message
    });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  logger.warn(`404 Not Found: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    logger.info('Initializing WhatsApp Multi-Automation System V2...');

    // Create sessions directory
    const fs = require('fs-extra');
    await fs.ensureDir('./sessions');

    // Initialize flow controller with whatsappManager reference
    const { initializeFlowController } = require('./controllers/flowController');
    initializeFlowController(whatsappManager);

    // Initialize existing accounts
    await whatsappManager.initializeExistingAccounts();
    try {
      await webhookDeliveryService.start();
    } catch (error) {
      logger.error('Failed to start WebhookDeliveryService:', error);
    }

    logger.info('System initialized successfully!');
  } catch (error) {
    logger.error('Error initializing app:', error);
  }
}

// ============================================================================
// GLOBAL ERROR HANDLER
// ============================================================================

// Handle async errors
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Global error handler (must be last)
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Database connection errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === '57P01') {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Database connection issue. Please try again in a moment.',
      code: 'DB_UNAVAILABLE'
    });
  }

  // Rate limit errors
  if (err.status === 429) {
    return res.status(429).json({
      error: 'Too many requests',
      message: 'You are being rate limited. Please slow down.',
      retryAfter: err.retryAfter
    });
  }

  // Validation errors
  if (err.name === 'ValidationError' || err.isJoi) {
    return res.status(400).json({
      error: 'Validation error',
      message: err.message,
      details: err.details
    });
  }

  // Generic server error
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong on our end'
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ============================================================================
// START SERVER
// ============================================================================

// Validate critical environment variables
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'your-secret-key-change-this') {
  if (process.env.NODE_ENV === 'production') {
    logger.error('❌ SESSION_SECRET environment variable must be set with a secure random value!');
    process.exit(1);
  } else {
    logger.warn('⚠️ Using default SESSION_SECRET - set a secure value for production!');
  }
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set!');
  process.exit(1);
}

// Log deployment info
if (process.env.RENDER) {
  logger.info('🌐 Running on Render');
}
if (process.env.RAILWAY_ENVIRONMENT) {
  logger.info('🚂 Running on Railway');
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  logger.info(`🚀 WhatsApp Multi-Automation V2 running on port ${PORT}`);
  logger.info(`📱 Dashboard: http://localhost:${PORT}/dashboard`);
  logger.info(`🔐 Login: http://localhost:${PORT}/login`);
  logger.info(`💚 Health: http://localhost:${PORT}/health`);
  logger.info(`✅ Ready: http://localhost:${PORT}/ready`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

  initializeApp();
  startKeepAlivePing();
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully...`);

  try {
    webhookDeliveryService.stop();
    logger.info('WebhookDeliveryService stopped');
  } catch (error) {
    logger.error('Error stopping WebhookDeliveryService:', error);
  }

  stopKeepAlivePing();

  // Close all WhatsApp clients first
  try {
    await whatsappManager.shutdown();
    logger.info('WhatsApp clients closed');
  } catch (error) {
    logger.error('Error shutting down WhatsApp clients:', error);
  }

  // Flush pending messages
  try {
    await db.flushMessageQueue();
    logger.info('Message queue flushed');
  } catch (error) {
    logger.error('Error flushing message queue:', error);
  }

  // Close server
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error('Forcefully shutting down');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Get system logs
app.get('/api/logs', requireAuth, apiLimiter, async (req, res) => {
  try {
    const logFile = path.join(__dirname, 'logs', 'combined.log');

    // Check if file exists
    try {
      await fs.access(logFile);
    } catch (error) {
      return res.json({ logs: ['No logs available yet.'] });
    }

    // Read file
    const content = await fs.readFile(logFile, 'utf8');
    const lines = content.trim().split('\n');

    // Get last 100 lines
    const recentLogs = lines.slice(-100).reverse();

    // Parse JSON logs if possible
    const parsedLogs = recentLogs.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return { message: line, timestamp: new Date().toISOString() };
      }
    });

    res.json({ logs: parsedLogs });
  } catch (error) {
    logger.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs' });
  }
});

module.exports = { app, server, io, emitToAll, emitToAccount };
