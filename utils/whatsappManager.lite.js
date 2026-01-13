/**
 * WhatsApp Manager - Ultra-Lite Version (Fixed)
 * Minimal RAM usage - focused on webhooks and core API only
 * No chatbot, no flows, no heavy features
 */

const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database.lite');
const logger = require('./logger');
const path = require('path');
const fs = require('fs').promises;

// Ultra-aggressive memory thresholds
const MEMORY_CRITICAL = 250 * 1024 * 1024; // 250MB

// Ultra-minimal Puppeteer config
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--disable-gpu',
  '--disable-extensions',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-sync',
  '--disable-translate',
  '--disable-features=AudioServiceOutOfProcess,TranslateUI,IsolateOrigins,site-per-process',
  '--disable-notifications',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--single-process',
  '--no-zygote',
  '--renderer-process-limit=1',
  '--disable-software-rasterizer',
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
  '--disable-offline-load-stale-cache',
  '--disk-cache-size=0',
  '--media-cache-size=0'
];

const SESSION_PATH = './wa-sessions-temp';

class WhatsAppManagerLite {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.accountStatus = new Map();
    this.reconnecting = new Set();
    this.qrAttempts = new Map();
    this.isShuttingDown = false;
    this.io = null;
    this.webhookService = null;

    // Minimal metrics
    this.metrics = { messagesProcessed: 0, messagesFailed: 0, webhooksDelivered: 0 };

    // Memory check every 30 seconds
    this._memTimer = setInterval(() => this._checkMemory(), 30000);
    
    // Cleanup every 3 minutes
    this._cleanupTimer = setInterval(() => this._cleanup(), 180000);

    // Ensure session directory exists
    this._ensureSessionDir();
  }

  async _ensureSessionDir() {
    try {
      await fs.mkdir(SESSION_PATH, { recursive: true });
    } catch (e) {
      logger.warn('Could not create session dir:', e.message);
    }
  }

  _checkMemory() {
    const rss = process.memoryUsage().rss;
    if (rss > MEMORY_CRITICAL) {
      logger.warn(`⚠️ Memory critical: ${Math.round(rss / 1024 / 1024)}MB`);
      if (global.gc) global.gc();
    }
  }

  async _cleanup() {
    for (const [id, status] of this.accountStatus) {
      if (status === 'disconnected' || status === 'error') {
        const client = this.clients.get(id);
        if (client) {
          await this._disposeClient(id);
        }
      }
    }
    if (global.gc) global.gc();
  }

  async _disposeClient(accountId) {
    const client = this.clients.get(accountId);
    if (!client) return;

    try {
      if (client.saveInterval) clearInterval(client.saveInterval);
      client.removeAllListeners();
      await Promise.race([
        client.destroy().catch(() => {}),
        new Promise(r => setTimeout(r, 10000))
      ]);
    } catch (e) {
      logger.warn(`Dispose error ${accountId}:`, e.message);
    }
    
    this.clients.delete(accountId);
    this.qrCodes.delete(accountId);
    this.qrAttempts.delete(accountId);
  }

  setSocketIO(io) { this.io = io; }

  _emit(event, data) {
    if (this.io) {
      try {
        this.io.emit(event, data);
      } catch (e) {
        logger.warn('Socket emit error:', e.message);
      }
    }
  }

  // Get webhook service (lazy load with fallback)
  _getWebhookService() {
    if (!this.webhookService) {
      try {
        const WebhookService = require('./webhookDeliveryService');
        if (typeof WebhookService === 'function') {
          this.webhookService = new WebhookService();
        } else if (WebhookService.queueDeliveries) {
          this.webhookService = WebhookService;
        } else {
          throw new Error('Invalid webhook service');
        }
      } catch (e) {
        logger.warn('Webhook service not available, using inline fallback');
        // Fallback - inline webhook delivery
        this.webhookService = {
          async queueDeliveries(accountId, webhooks, msgData) {
            const axios = require('axios');
            for (const webhook of webhooks) {
              try {
                await axios.post(webhook.url, {
                  event: 'message',
                  account_id: accountId,
                  data: msgData,
                  timestamp: new Date().toISOString()
                }, {
                  timeout: 10000,
                  headers: webhook.headers || {}
                });
              } catch (err) {
                logger.warn(`Webhook failed ${webhook.url}:`, err.message);
              }
            }
          }
        };
      }
    }
    return this.webhookService;
  }

  /**
   * Create new account - NO session restore, fresh start for QR
   */
  async createAccount(name, description = '') {
    if (this.isShuttingDown) throw new Error('Shutting down');

    const id = uuidv4();
    
    // Create account in DB first
    const account = await db.createAccount({
      id,
      name,
      description,
      status: 'initializing',
      created_at: new Date().toISOString(),
      metadata: JSON.stringify({ version: '3.0-lite' })
    });

    logger.info(`📱 Creating new account: ${name} (${id})`);

    // Clear any old session directory for this account (fresh start)
    const accountSessionPath = path.join(SESSION_PATH, `session-${id}`);
    try {
      await fs.rm(accountSessionPath, { recursive: true, force: true });
    } catch (e) {}

    // Create client (fresh - no session)
    const client = this._createClient(id);
    this._setupHandlers(client, id);
    this.clients.set(id, client);
    this.accountStatus.set(id, 'initializing');

    // Initialize - this will trigger QR code generation
    client.initialize().catch(err => {
      logger.error(`Init error ${id}:`, err.message);
      this.accountStatus.set(id, 'error');
      db.updateAccount(id, { status: 'error', error_message: err.message }).catch(() => {});
    });

    return account;
  }

  /**
   * Create WhatsApp client with LocalAuth
   */
  _createClient(accountId) {
    return new Client({
      authStrategy: new LocalAuth({
        clientId: accountId,
        dataPath: SESSION_PATH
      }),
      puppeteer: {
        headless: 'new', // Use new headless mode for better performance
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: PUPPETEER_ARGS,
        defaultViewport: { width: 800, height: 600 },
        timeout: 180000 // 3 minutes for slow 0.1 vCPU
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webVersion.json'
      }
    });
  }

  _setupHandlers(client, accountId) {
    client.removeAllListeners();

    // Simple QR Code handler - no regeneration logic
    client.on('qr', async (qr) => {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        this.qrCodes.set(accountId, qrDataUrl);
        this.accountStatus.set(accountId, 'qr_ready');
        
        await db.updateAccount(accountId, { status: 'qr_ready' }).catch(() => {});
        this._emit('qr', { accountId, qr: qrDataUrl });
        
        logger.info(`📱 QR ready for ${accountId}`);
      } catch (e) {
        logger.error(`QR handler error:`, e.message);
      }
    });

    // Ready handler
    client.on('ready', async () => {
      try {
        const phone = client.info?.wid?.user || 'unknown';
        this.accountStatus.set(accountId, 'ready');
        this.qrCodes.delete(accountId);

        await db.updateAccount(accountId, {
          status: 'ready',
          phone_number: phone,
          last_active_at: new Date().toISOString(),
          error_message: null
        }).catch(() => {});

        this._emit('ready', { accountId, phoneNumber: phone });
        logger.info(`✅ Ready: ${accountId} (${phone})`);

        // Save session to DB after 60 seconds (wait for stability)
        setTimeout(() => this._saveSessionToDb(accountId), 60000);

        // Periodic save every 15 min
        if (client.saveInterval) clearInterval(client.saveInterval);
        client.saveInterval = setInterval(() => this._saveSessionToDb(accountId), 900000);
      } catch (e) {
        logger.error(`Ready handler error:`, e.message);
      }
    });

    // Authenticated handler
    client.on('authenticated', () => {
      logger.info(`🔐 Authenticated: ${accountId}`);
      this._emit('authenticated', { accountId });
    });

    // Auth failure handler
    client.on('auth_failure', async (msg) => {
      logger.error(`❌ Auth failed ${accountId}:`, msg);
      this.accountStatus.set(accountId, 'auth_failed');
      await db.updateAccount(accountId, { status: 'auth_failed', error_message: String(msg) }).catch(() => {});
      this._emit('auth_failure', { accountId, message: msg });
    });

    // Disconnected handler
    client.on('disconnected', async (reason) => {
      logger.warn(`📴 Disconnected ${accountId}:`, reason);
      this.accountStatus.set(accountId, 'disconnected');
      await db.updateAccount(accountId, { status: 'disconnected', error_message: String(reason) }).catch(() => {});
      this._emit('disconnected', { accountId, reason });
    });

    // Message handler
    client.on('message', async (message) => {
      if (message.from === 'status@broadcast') return;
      await this._handleMessage(client, accountId, message);
    });

    // Message ACK handler - for sent message seen/delivered notifications
    client.on('message_ack', async (message, ack) => {
      try {
        // ACK values: 0 = error, 1 = sent, 2 = delivered, 3 = read/seen
        const ackNames = { 0: 'error', 1: 'sent', 2: 'delivered', 3: 'read' };
        const ackName = ackNames[ack] || 'unknown';
        
        // Only send webhooks for delivered and read
        if (ack >= 2) {
          const msgData = {
            event: 'message_ack',
            account_id: accountId,
            message_id: message.id._serialized,
            recipient: message.to,
            ack: ack,
            ack_name: ackName,
            timestamp: Date.now(),
            created_at: new Date().toISOString()
          };
          
          await this._queueWebhooks(accountId, msgData);
          logger.info(`📬 Message ${ackName}: ${message.id._serialized.slice(0, 20)}...`);
        }
      } catch (e) {
        logger.warn('Message ACK handler error:', e.message);
      }
    });

    // Error handler
    client.on('error', (err) => {
      logger.error(`Client error ${accountId}:`, err.message);
    });
  }

  /**
   * Save session files to database for persistence
   */
  async _saveSessionToDb(accountId) {
    if (this.accountStatus.get(accountId) !== 'ready') return;

    try {
      const sessionPath = path.join(SESSION_PATH, `session-${accountId}`);
      const exists = await fs.access(sessionPath).then(() => true).catch(() => false);
      
      if (!exists) {
        logger.warn(`Session path not found for ${accountId}`);
        return;
      }

      // Read and compress session files
      const files = {};
      await this._collectSessionFiles(sessionPath, sessionPath, files);
      
      if (Object.keys(files).length === 0) {
        logger.warn(`No session files found for ${accountId}`);
        return;
      }

      const zlib = require('zlib');
      const util = require('util');
      const gzip = util.promisify(zlib.gzip);

      const sessionObj = { files, ts: Date.now(), id: accountId };
      const compressed = await gzip(JSON.stringify(sessionObj));
      
      const payload = JSON.stringify({
        type: 'session_v5',
        data: compressed.toString('base64'),
        saved: new Date().toISOString()
      });

      const final = Buffer.from(payload).toString('base64');
      await db.saveSessionData(accountId, final);
      
      logger.info(`💾 Session saved for ${accountId} (${Math.round(final.length / 1024)}KB)`);
    } catch (e) {
      logger.error(`Session save error ${accountId}:`, e.message);
    }
  }

  async _collectSessionFiles(dir, baseDir, files, stats = { totalSize: 0 }) {
    const MAX_TOTAL = 10 * 1024 * 1024;
    const MAX_FILE = 3 * 1024 * 1024;
    // Only these dirs are essential for WhatsApp session restoration
    const ESSENTIAL_DIRS = ['IndexedDB', 'Local Storage'];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (stats.totalSize > MAX_TOTAL) break;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath);

        if (entry.isDirectory()) {
          // At Default level, only recurse into essential dirs
          if (entry.name === 'Default') {
            await this._collectSessionFiles(fullPath, baseDir, files, stats);
          } else if (ESSENTIAL_DIRS.includes(entry.name)) {
            // Recurse into IndexedDB and Local Storage
            await this._collectSessionFiles(fullPath, baseDir, files, stats);
          } else if (dir.includes('IndexedDB') || dir.includes('Local Storage')) {
            // Inside essential dirs, recurse into subdirs (leveldb folders etc)
            await this._collectSessionFiles(fullPath, baseDir, files, stats);
          }
          // Skip all other directories (Cache, GPUCache, Service Worker, etc)
        } else {
          // Only save files inside essential directories
          if (!dir.includes('IndexedDB') && !dir.includes('Local Storage')) continue;
          
          // Skip lock files
          if (['LOCK', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) continue;
          
          const stat = await fs.stat(fullPath);
          if (stat.size === 0 || stat.size > MAX_FILE) continue;

          const content = await fs.readFile(fullPath);
          files[relPath] = content.toString('base64');
          stats.totalSize += content.length;
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read
    }
  }

  async _handleMaxQrAttempts(client, accountId) {
    logger.warn(`Max QR attempts for ${accountId}, cleaning up`);
    
    await db.clearSessionData(accountId).catch(() => {});
    await db.updateAccount(accountId, { status: 'disconnected', error_message: 'Max QR attempts reached' }).catch(() => {});
    
    this.accountStatus.set(accountId, 'disconnected');
    this.qrCodes.delete(accountId);
    this.qrAttempts.delete(accountId);
    
    try { 
      client.removeAllListeners(); 
      await client.destroy(); 
    } catch (e) {}
    
    this.clients.delete(accountId);
    this.reconnecting.delete(accountId);

    // Clean session directory
    const sessionPath = path.join(SESSION_PATH, `session-${accountId}`);
    await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
  }

  async _handleMessage(client, accountId, message) {
    try {
      const chat = await message.getChat();
      
      const msgData = {
        account_id: accountId,
        direction: 'incoming',
        message_id: message.id._serialized,
        sender: message.from,
        recipient: message.to,
        message: message.body || '',
        timestamp: message.timestamp,
        type: message.type,
        chat_id: chat.id._serialized,
        is_group: chat.isGroup,
        status: 'success',
        created_at: new Date().toISOString()
      };

      // Minimal media handling - skip large files
      if (message.hasMedia && message.type !== 'sticker') {
        try {
          const media = await message.downloadMedia();
          if (media) {
            const size = media.data ? Buffer.byteLength(media.data, 'base64') : 0;
            if (size < 512 * 1024) {
              msgData.media = { mimetype: media.mimetype, filename: media.filename, size };
            } else {
              msgData.media = { mimetype: media.mimetype, size, data_omitted: true };
            }
          }
        } catch (e) {
          msgData.media = { error: 'download_failed' };
        }
      }

      // Log to DB
      await db.logMessage(msgData).catch(e => logger.warn('Message log failed:', e.message));
      await db.updateAccount(accountId, { last_active_at: new Date().toISOString() }).catch(() => {});

      // Queue webhooks
      await this._queueWebhooks(accountId, msgData);
      this.metrics.messagesProcessed++;
    } catch (e) {
      logger.error(`Message error:`, e.message);
      this.metrics.messagesFailed++;
    }
  }

  async _queueWebhooks(accountId, msgData) {
    try {
      const webhooks = await db.getWebhooks(accountId);
      const active = (webhooks || []).filter(w => w.is_active);
      
      if (active.length > 0) {
        const svc = this._getWebhookService();
        await svc.queueDeliveries(accountId, active, msgData);
        this.metrics.webhooksDelivered += active.length;
      }
    } catch (e) {
      logger.warn('Webhook queue error:', e.message);
    }
  }

  formatPhoneNumber(number) {
    if (!number) throw new Error('Phone number required');
    if (number.includes('@')) return number;
    let cleaned = number.replace(/[^\d]/g, '').replace(/^0+/, '');
    if (cleaned.length === 10) cleaned = '91' + cleaned;
    if (cleaned.length < 10) throw new Error('Invalid phone number');
    return cleaned + '@c.us';
  }

  async sendMessage(accountId, number, message, options = {}) {
    const client = this.clients.get(accountId);
    if (!client) throw new Error('Account not connected');
    if (this.accountStatus.get(accountId) !== 'ready') {
      throw new Error(`Account not ready (status: ${this.accountStatus.get(accountId) || 'unknown'})`);
    }

    const formatted = this.formatPhoneNumber(number);
    
    // Simulate typing effect if enabled (default: true for HTTP requests)
    if (options.simulateTyping !== false) {
      try {
        const chat = await client.getChatById(formatted);
        await chat.sendStateTyping();
        // Calculate typing delay based on message length (50-100ms per char, max 5s)
        const typingDelay = Math.min(Math.max(message.length * 50, 1000), 5000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        await chat.clearState();
      } catch (e) {
        // Typing simulation failed, continue with sending
        logger.warn('Typing simulation failed:', e.message);
      }
    }
    
    const result = await client.sendMessage(formatted, message, options);

    await db.logMessage({
      account_id: accountId,
      direction: 'outgoing',
      message_id: result.id._serialized,
      recipient: formatted,
      message: typeof message === 'string' ? message : '',
      status: 'success',
      created_at: new Date().toISOString()
    }).catch(() => {});

    this.metrics.messagesProcessed++;
    return { success: true, messageId: result.id._serialized, timestamp: result.timestamp };
  }

  async sendMedia(accountId, number, media, caption = '', options = {}) {
    const client = this.clients.get(accountId);
    if (!client) throw new Error('Account not connected');
    if (this.accountStatus.get(accountId) !== 'ready') {
      throw new Error(`Account not ready (status: ${this.accountStatus.get(accountId) || 'unknown'})`);
    }

    const formatted = this.formatPhoneNumber(number);
    
    // Simulate typing/recording effect if enabled
    if (options.simulateTyping !== false) {
      try {
        const chat = await client.getChatById(formatted);
        // Use recording state for audio, typing for others
        if (media.mimetype?.startsWith('audio/')) {
          await chat.sendStateRecording();
        } else {
          await chat.sendStateTyping();
        }
        // 2-3 second delay for media
        await new Promise(resolve => setTimeout(resolve, 2500));
        await chat.clearState();
      } catch (e) {
        logger.warn('Typing simulation failed:', e.message);
      }
    }

    let base64 = media.data || '';
    let mimetype = media.mimetype || '';

    if (media.url && !base64) {
      const axios = require('axios');
      const resp = await axios.get(media.url, { responseType: 'arraybuffer', timeout: 30000 });
      base64 = Buffer.from(resp.data).toString('base64');
      mimetype = mimetype || resp.headers['content-type'];
    }

    if (!mimetype) throw new Error('Media mimetype required');
    if (!base64) throw new Error('Media data required');

    const msgMedia = new MessageMedia(mimetype, base64, media.filename || 'media');
    const result = await client.sendMessage(formatted, msgMedia, { caption });

    this.metrics.messagesProcessed++;
    return { success: true, messageId: result.id?._serialized, timestamp: result.timestamp };
  }

  getQRCode(id) { return this.qrCodes.get(id); }
  getAccountStatus(id) { return this.accountStatus.get(id); }
  isReconnecting(id) { return this.reconnecting.has(id); }
  getAllAccountStatuses() { return Object.fromEntries(this.accountStatus); }
  getMetrics() { return { ...this.metrics, activeClients: this.clients.size }; }

  async requestNewQRCode(accountId) {
    const account = await db.getAccount(accountId);
    if (!account) throw new Error('Account not found');
    
    // Clear existing session for fresh QR
    await db.clearSessionData(accountId).catch(() => {});
    const sessionPath = path.join(SESSION_PATH, `session-${accountId}`);
    await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
    
    return this.reconnectAccount(account, { forceReconnect: true, clearSession: true });
  }

  async deleteAccount(accountId) {
    await this._disposeClient(accountId);
    this.accountStatus.delete(accountId);
    this.reconnecting.delete(accountId);
    this.qrCodes.delete(accountId);
    this.qrAttempts.delete(accountId);
    
    await db.clearSessionData(accountId).catch(() => {});
    await db.deleteAccount(accountId);
    
    // Clean session directory
    const sessionPath = path.join(SESSION_PATH, `session-${accountId}`);
    await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
    
    if (global.gc) global.gc();
    return true;
  }

  async initializeExistingAccounts() {
    if (process.env.DISABLE_AUTO_INIT === 'true') {
      logger.info('Auto-init disabled');
      return;
    }

    try {
      const accounts = await db.getAccounts();
      logger.info(`Found ${accounts.length} existing accounts`);

      for (const account of accounts) {
        const hasSession = await db.hasSessionData(account.id);
        
        if (hasSession) {
          logger.info(`🔄 Restoring ${account.name}...`);
          await this.reconnectAccount(account, { reason: 'startup' });
          // Stagger initialization to avoid memory spikes
          await new Promise(r => setTimeout(r, 5000));
        } else {
          this.accountStatus.set(account.id, 'disconnected');
          logger.info(`⚠️ ${account.name} needs QR scan`);
        }
      }
    } catch (e) {
      logger.error('Error initializing accounts:', e.message);
    }
  }

  async reconnectAccount(account, options = {}) {
    const { forceReconnect = false, reason = 'manual', clearSession = false } = options;

    if (this.reconnecting.has(account.id)) {
      return { status: 'reconnecting', message: 'Already reconnecting' };
    }

    // Check if already connected
    if (this.clients.has(account.id) && !forceReconnect) {
      const status = this.accountStatus.get(account.id);
      if (status === 'ready') {
        return { status: 'ready', message: 'Already connected' };
      }
    }

    // Dispose existing client
    if (this.clients.has(account.id)) {
      await this._disposeClient(account.id);
    }

    this.reconnecting.add(account.id);
    this.qrAttempts.delete(account.id);
    this.qrCodes.delete(account.id);

    try {
      const hasSession = clearSession ? false : await db.hasSessionData(account.id);
      
      // Restore session from DB if available
      if (hasSession) {
        await this._restoreSessionFromDb(account.id);
      }

      await db.updateAccount(account.id, { status: 'initializing', error_message: null }).catch(() => {});

      const client = this._createClient(account.id);
      this._setupHandlers(client, account.id);
      this.clients.set(account.id, client);
      this.accountStatus.set(account.id, 'initializing');

      client.initialize()
        .catch(async (err) => {
          logger.error(`Init error ${account.id}:`, err.message);
          
          // Clear session if auth error
          if (err.message?.includes('auth') || err.message?.includes('Protocol') || err.message?.includes('session')) {
            await db.clearSessionData(account.id).catch(() => {});
            const sessionPath = path.join(SESSION_PATH, `session-${account.id}`);
            await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
          }
          
          this.accountStatus.set(account.id, 'disconnected');
          this.clients.delete(account.id);
          await db.updateAccount(account.id, { status: 'disconnected', error_message: err.message }).catch(() => {});
        })
        .finally(() => {
          this.reconnecting.delete(account.id);
        });

      return { status: 'initializing', message: `Initializing (${hasSession ? 'with session' : 'fresh start'})` };
    } catch (e) {
      this.reconnecting.delete(account.id);
      this.accountStatus.set(account.id, 'disconnected');
      throw e;
    }
  }

  /**
   * Restore session from database to local files
   */
  async _restoreSessionFromDb(accountId) {
    try {
      const sessionData = await db.getSessionData(accountId);
      if (!sessionData) {
        logger.info(`No session data in DB for ${accountId}`);
        return false;
      }

      // Decode and decompress
      const payloadJson = Buffer.from(sessionData, 'base64').toString('utf-8');
      const payload = JSON.parse(payloadJson);

      if (!payload.data) {
        logger.warn(`Invalid session format for ${accountId}`);
        await db.clearSessionData(accountId);
        return false;
      }

      const zlib = require('zlib');
      const util = require('util');
      const gunzip = util.promisify(zlib.gunzip);

      const compressed = Buffer.from(payload.data, 'base64');
      const decompressed = await gunzip(compressed);
      const sessionObj = JSON.parse(decompressed.toString('utf-8'));

      if (!sessionObj.files || Object.keys(sessionObj.files).length === 0) {
        logger.warn(`Empty session for ${accountId}`);
        await db.clearSessionData(accountId);
        return false;
      }

      // Restore files
      const sessionPath = path.join(SESSION_PATH, `session-${accountId}`);
      await fs.mkdir(sessionPath, { recursive: true });

      let restored = 0;
      for (const [relPath, b64Content] of Object.entries(sessionObj.files)) {
        try {
          const fullPath = path.join(sessionPath, relPath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, Buffer.from(b64Content, 'base64'));
          restored++;
        } catch (e) {
          logger.warn(`Failed to restore file: ${relPath}`);
        }
      }

      logger.info(`✅ Restored ${restored} session files for ${accountId}`);
      return true;
    } catch (e) {
      logger.error(`Session restore error ${accountId}:`, e.message);
      await db.clearSessionData(accountId).catch(() => {});
      return false;
    }
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down WhatsApp Manager...');

    clearInterval(this._memTimer);
    clearInterval(this._cleanupTimer);

    // Save all sessions before shutdown
    for (const [id] of this.clients) {
      if (this.accountStatus.get(id) === 'ready') {
        await this._saveSessionToDb(id);
      }
      await this._disposeClient(id);
    }

    this.clients.clear();
    this.accountStatus.clear();
    this.qrCodes.clear();
    this.qrAttempts.clear();
    
    logger.info('WhatsApp Manager shutdown complete');
  }
}

module.exports = new WhatsAppManagerLite();
