/**
 * WhatsApp Manager - Optimized Version
 * Focused on minimal RAM usage and reliable session persistence
 * Removes: AI auto-reply, Flow Engine, heavy caching
 */

const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const axios = require('axios');
const logger = require('./logger');
const { SupabaseAuth } = require('./SupabaseAuth');
const webhookDeliveryService = require('./webhookDeliveryService');

// Memory thresholds - aggressive for low-RAM environments
const MEMORY_WARNING_THRESHOLD = 300 * 1024 * 1024; // 300MB
const MEMORY_CRITICAL_THRESHOLD = 400 * 1024 * 1024; // 400MB

// Minimal Puppeteer config - optimized for low RAM
const PUPPETEER_CONFIG = {
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
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
    '--disable-features=AudioServiceOutOfProcess,TranslateUI',
    '--disable-notifications',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-client-side-phishing-detection',
    '--disable-popup-blocking',
    '--disable-component-update',
    '--single-process', // Important for low RAM
    '--no-zygote',
    '--memory-pressure-off',
    '--max-old-space-size=256', // Limit V8 heap
    '--js-flags="--max-old-space-size=256"'
  ],
  defaultViewport: { width: 800, height: 600 },
  timeout: 120000
};

class WhatsAppManager {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.accountStatus = new Map();
    this.reconnecting = new Set();
    this.qrAttempts = new Map();
    this.isShuttingDown = false;
    this.io = null;

    // Minimal metrics
    this.metrics = {
      messagesProcessed: 0,
      messagesFailed: 0,
      webhooksDelivered: 0,
      webhooksFailed: 0
    };

    // Memory monitoring (every 60 seconds)
    setInterval(() => this.checkMemoryUsage(), 60000);

    // Cleanup disconnected accounts (every 5 minutes)
    setInterval(() => this.cleanupDisconnectedAccounts(), 300000);
  }

  setSocketIO(io) {
    this.io = io;
    logger.info('Socket.IO instance set for WhatsAppManager');
  }

  emitToAll(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  emitToAccount(accountId, event, data) {
    if (this.io) {
      this.io.to(`account-${accountId}`).emit(event, data);
    }
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const rss = used.rss;

    if (rss > MEMORY_CRITICAL_THRESHOLD) {
      logger.warn(`⚠️ CRITICAL: Memory ${Math.round(rss / 1024 / 1024)}MB - forcing GC`);
      if (global.gc) {
        global.gc();
      }
    } else if (rss > MEMORY_WARNING_THRESHOLD) {
      logger.info(`Memory: ${Math.round(rss / 1024 / 1024)}MB`);
    }
  }

  async safeDisposeClient(accountId, timeoutMs = 15000) {
    const client = this.clients.get(accountId);
    if (!client) return true;

    try {
      if (client.saveInterval) {
        clearInterval(client.saveInterval);
        client.saveInterval = null;
      }

      client.removeAllListeners();

      await Promise.race([
        client.destroy().catch(e => logger.warn(`Client destroy error: ${e.message}`)),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);

      logger.info(`Client disposed for ${accountId}`);
    } catch (error) {
      logger.warn(`Error disposing client ${accountId}:`, error.message);
    } finally {
      this.clients.delete(accountId);
      this.qrCodes.delete(accountId);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  }

  async createAccount(accountName, description = '') {
    if (this.isShuttingDown) {
      throw new Error('Server is shutting down');
    }

    const accountId = uuidv4();

    try {
      const accountData = {
        id: accountId,
        name: accountName,
        description: description,
        status: 'initializing',
        created_at: new Date().toISOString(),
        metadata: { created_by: 'system', version: '3.0' }
      };

      const account = await db.createAccount(accountData);

      // Create client with SupabaseAuth
      const client = new Client({
        authStrategy: new SupabaseAuth({
          accountId: accountId,
          dataPath: './wa-sessions-temp'
        }),
        puppeteer: PUPPETEER_CONFIG,
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webVersion.json'
        }
      });

      this.setupEventHandlers(client, accountId);
      this.clients.set(accountId, client);
      this.accountStatus.set(accountId, 'initializing');

      // Initialize async
      client.initialize().catch(err => {
        logger.error(`Init error for ${accountId}:`, err);
        this.accountStatus.set(accountId, 'error');
        db.updateAccount(accountId, {
          status: 'error',
          error_message: err.message,
          updated_at: new Date().toISOString()
        }).catch(() => {});
      });

      logger.info(`Account created: ${accountId} (${accountName})`);
      return account;
    } catch (error) {
      logger.error('Error creating account:', error);
      this.accountStatus.set(accountId, 'error');
      throw error;
    }
  }

  setupEventHandlers(client, accountId) {
    client.removeAllListeners();

    client.on('qr', async (qr) => {
      try {
        const attempts = (this.qrAttempts.get(accountId) || 0) + 1;
        this.qrAttempts.set(accountId, attempts);

        const maxQrAttempts = parseInt(process.env.MAX_QR_ATTEMPTS) || 10;
        if (attempts > maxQrAttempts) {
          logger.warn(`Account ${accountId} exceeded max QR attempts`);
          
          await db.clearSessionData(accountId);
          await db.updateAccount(accountId, {
            status: 'disconnected',
            error_message: 'Session expired - reconnect manually',
            updated_at: new Date().toISOString()
          });

          this.accountStatus.set(accountId, 'disconnected');
          this.qrCodes.delete(accountId);

          try {
            client.removeAllListeners();
            await client.destroy();
          } catch (e) {}

          this.clients.delete(accountId);
          this.reconnecting.delete(accountId);
          return;
        }

        const qrDataUrl = await qrcode.toDataURL(qr);
        this.qrCodes.set(accountId, qrDataUrl);

        await db.updateAccount(accountId, {
          status: 'qr_ready',
          qr_code: qrDataUrl,
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'qr_ready');
        this.emitToAll('qr', { accountId, qr: qrDataUrl });
        
        logger.info(`QR generated for ${accountId} (attempt ${attempts}/${maxQrAttempts})`);
      } catch (error) {
        logger.error(`QR error for ${accountId}:`, error);
      }
    });

    client.on('ready', async () => {
      try {
        const phoneNumber = client.info.wid.user;

        await db.updateAccount(accountId, {
          status: 'ready',
          phone_number: phoneNumber,
          last_active_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'ready');
        this.qrCodes.delete(accountId);
        this.qrAttempts.delete(accountId);

        this.emitToAll('ready', { accountId, phoneNumber });
        logger.info(`✅ WhatsApp ready for ${accountId} (${phoneNumber})`);

        // Schedule session save after 60 seconds for stability
        setTimeout(async () => {
          if (this.accountStatus.get(accountId) === 'ready' && client.authStrategy) {
            try {
              await client.authStrategy.saveSession();
              logger.info(`Initial session saved for ${accountId}`);
            } catch (err) {
              logger.warn(`Initial save failed for ${accountId}:`, err.message);
            }
          }
        }, 60000);

        // Periodic save every 15 minutes
        if (client.saveInterval) clearInterval(client.saveInterval);
        const saveIntervalMs = parseInt(process.env.SESSION_SAVE_INTERVAL_MS) || 15 * 60 * 1000;
        
        client.saveInterval = setInterval(async () => {
          if (this.accountStatus.get(accountId) === 'ready' && client.authStrategy) {
            try {
              await client.authStrategy.saveSession();
            } catch (err) {
              logger.warn(`Periodic save failed for ${accountId}:`, err.message);
            }
          }
        }, saveIntervalMs);
      } catch (error) {
        logger.error(`Ready handler error for ${accountId}:`, error);
      }
    });

    client.on('authenticated', () => {
      logger.info(`Authenticated: ${accountId}`);
      this.qrAttempts.delete(accountId);
      this.emitToAll('authenticated', { accountId });
    });

    client.on('auth_failure', async (msg) => {
      logger.error(`Auth failed for ${accountId}:`, msg);
      await db.updateAccount(accountId, {
        status: 'auth_failed',
        error_message: msg,
        updated_at: new Date().toISOString()
      });
      this.accountStatus.set(accountId, 'auth_failed');
    });

    client.on('disconnected', async (reason) => {
      logger.warn(`Disconnected ${accountId}:`, reason);
      
      await db.updateAccount(accountId, {
        status: 'disconnected',
        error_message: reason,
        updated_at: new Date().toISOString()
      });

      this.accountStatus.set(accountId, 'disconnected');
      this.emitToAll('disconnected', { accountId, reason });
      
      // Don't clear session - keep it for reconnection
      logger.info(`Session preserved for ${accountId}`);
    });

    client.on('message', async (message) => {
      try {
        await this.handleIncomingMessage(client, accountId, message);
      } catch (error) {
        logger.error(`Message handler error for ${accountId}:`, error);
      }
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
          
          // Queue webhook deliveries
          await this.queueWebhookDeliveries(accountId, msgData);
          logger.info(`📬 Message ${ackName}: ${message.id._serialized.slice(0, 20)}...`);
        }
      } catch (error) {
        logger.warn('Message ACK handler error:', error.message);
      }
    });
  }

  async handleIncomingMessage(client, accountId, message) {
    // Ignore status broadcasts
    if (message.from === 'status@broadcast' || message.to === 'status@broadcast') {
      return;
    }

    try {
      const chat = await message.getChat();

      const messageData = {
        account_id: accountId,
        direction: 'incoming',
        message_id: message.id._serialized,
        sender: message.from,
        recipient: message.to,
        message: message.body,
        timestamp: message.timestamp,
        type: message.type,
        chat_id: chat.id._serialized,
        is_group: chat.isGroup,
        group_name: chat.isGroup ? chat.name : null,
        status: 'success',
        created_at: new Date().toISOString()
      };

      // Handle media (minimal - don't download large files)
      if (message.hasMedia && message.type !== 'sticker') {
        try {
          const media = await message.downloadMedia();
          if (media) {
            const mediaSize = media.data ? Buffer.byteLength(media.data, 'base64') : 0;
            
            // Only include small media (< 1MB) in webhook payload
            if (mediaSize < 1024 * 1024) {
              messageData.media = {
                mimetype: media.mimetype,
                filename: media.filename || 'media',
                size: mediaSize,
                data: media.data
              };
            } else {
              messageData.media = {
                mimetype: media.mimetype,
                filename: media.filename || 'media',
                size: mediaSize,
                data_omitted: true
              };
            }
          }
        } catch (mediaError) {
          messageData.media = { error: 'Failed to download' };
        }
      }

      // Log to database (if enabled)
      await db.logMessage(messageData);

      // Update last active
      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      // Queue webhook deliveries
      this.queueWebhookDeliveries(accountId, messageData).catch(err => {
        logger.error(`Webhook queue error:`, err);
      });

      this.metrics.messagesProcessed++;
    } catch (error) {
      logger.error(`Incoming message error:`, error);
      this.metrics.messagesFailed++;
    }
  }

  async queueWebhookDeliveries(accountId, messageData) {
    try {
      const webhooks = await db.getWebhooks(accountId);
      const activeWebhooks = (webhooks || []).filter(w => w.is_active);
      
      if (activeWebhooks.length > 0) {
        await webhookDeliveryService.queueDeliveries(accountId, activeWebhooks, messageData);
      }
    } catch (error) {
      logger.error(`Webhook delivery error:`, error);
    }
  }

  formatPhoneNumber(number) {
    if (number.includes('@')) return number;

    let cleaned = number.replace(/[^\d]/g, '').replace(/^0+/, '');

    if (cleaned.length === 10) {
      cleaned = '91' + cleaned;
    }

    return cleaned + '@c.us';
  }

  async sendMessage(accountId, number, message, options = {}) {
    const client = this.clients.get(accountId);
    if (!client) throw new Error('Client not found');

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') throw new Error(`Client not ready: ${status}`);

    const formattedNumber = this.formatPhoneNumber(number);

    try {
      const result = await client.sendMessage(formattedNumber, message, options);

      // Log outgoing
      try {
        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          message_id: result.id._serialized,
          sender: result.from,
          recipient: result.to,
          message: typeof message === 'string' ? message : JSON.stringify(message),
          timestamp: result.timestamp,
          type: 'text',
          status: 'success',
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        logger.warn('Log outgoing failed:', logError.message);
      }

      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.id._serialized,
        timestamp: result.timestamp
      };
    } catch (error) {
      this.metrics.messagesFailed++;
      
      await db.logMessage({
        account_id: accountId,
        direction: 'outgoing',
        recipient: number,
        message: typeof message === 'string' ? message : '',
        status: 'failed',
        error_message: error.message,
        created_at: new Date().toISOString()
      }).catch(() => {});

      throw error;
    }
  }

  async sendMedia(accountId, number, media, caption = '', options = {}) {
    const client = this.clients.get(accountId);
    if (!client) throw new Error('Client not found');

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') throw new Error(`Client not ready: ${status}`);

    let base64Data = media.data || '';
    let mimetype = media.mimetype || '';
    let filename = media.filename || '';

    // Fetch from URL if needed
    if (media.url && !base64Data) {
      const response = await axios.get(media.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 16 * 1024 * 1024
      });

      base64Data = Buffer.from(response.data).toString('base64');
      mimetype = mimetype || response.headers['content-type'] || 'application/octet-stream';

      if (!filename) {
        try {
          filename = new URL(media.url).pathname.split('/').pop() || '';
        } catch {}
      }
    }

    // Normalize base64
    if (base64Data && /^data:[^;]+;base64,/i.test(base64Data)) {
      base64Data = base64Data.replace(/^data:[^;]+;base64,/i, '');
    }

    if (!mimetype) throw new Error('mimetype required');

    const msgMedia = new MessageMedia(mimetype, base64Data, filename || 'media');
    const formattedNumber = this.formatPhoneNumber(number);

    const result = await client.sendMessage(formattedNumber, msgMedia, { caption });

    this.metrics.messagesProcessed++;

    return {
      success: true,
      messageId: result.id?._serialized,
      timestamp: result.timestamp
    };
  }

  getQRCode(accountId) {
    return this.qrCodes.get(accountId);
  }

  getAccountStatus(accountId) {
    return this.accountStatus.get(accountId);
  }

  isReconnecting(accountId) {
    return this.reconnecting.has(accountId);
  }

  getAllAccountStatuses() {
    const statuses = {};
    for (const [accountId, status] of this.accountStatus) {
      statuses[accountId] = status;
    }
    return statuses;
  }

  async requestNewQRCode(accountId) {
    const account = await db.getAccount(accountId);
    if (!account) throw new Error('Account not found');

    return this.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'qr_request'
    });
  }

  async deleteAccount(accountId) {
    try {
      const client = this.clients.get(accountId);

      if (client) {
        if (client.saveInterval) clearInterval(client.saveInterval);
        client.removeAllListeners();
        await client.destroy().catch(() => {});
        this.clients.delete(accountId);
      }

      this.qrCodes.delete(accountId);
      this.accountStatus.delete(accountId);
      this.reconnecting.delete(accountId);

      await db.clearSessionData(accountId);
      await db.deleteAccount(accountId);

      logger.info(`Account deleted: ${accountId}`);

      if (global.gc) global.gc();

      return true;
    } catch (error) {
      logger.error(`Delete account error:`, error);
      throw error;
    }
  }

  async initializeExistingAccounts() {
    if (process.env.DISABLE_AUTO_INIT === 'true') {
      logger.info('Auto-init disabled');
      return;
    }

    try {
      const accounts = await db.getAccounts();
      logger.info(`Found ${accounts.length} accounts`);

      const accountsWithSessions = [];

      for (const account of accounts) {
        try {
          const hasSession = await db.hasSessionData(account.id);
          
          if (hasSession) {
            accountsWithSessions.push(account);
            logger.info(`✅ ${account.name} has session`);
          } else {
            this.accountStatus.set(account.id, 'disconnected');
            logger.info(`⚠️ ${account.name} needs QR scan`);
          }
        } catch (err) {
          this.accountStatus.set(account.id, 'disconnected');
        }
      }

      logger.info(`${accountsWithSessions.length}/${accounts.length} have sessions`);

      // Initialize one at a time to reduce memory spikes
      for (const account of accountsWithSessions) {
        try {
          await this.reconnectAccount(account, {
            skipIfNoSession: false,
            reason: 'startup'
          });
          
          // Wait 5 seconds between each to reduce load
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (err) {
          logger.error(`Startup reconnect failed for ${account.id}:`, err.message);
          this.accountStatus.set(account.id, 'error');
        }
      }

      logger.info('Finished initializing accounts');
    } catch (error) {
      logger.error('Init accounts error:', error);
    }
  }

  async reconnectAccount(account, options = {}) {
    const { forceReconnect = false, reason = 'manual', skipIfNoSession = false } = options;

    logger.info(`Reconnecting ${account.id} (${account.name}). Reason: ${reason}`);

    if (this.reconnecting.has(account.id)) {
      logger.warn(`Already reconnecting ${account.id}`);
      return { status: 'reconnecting' };
    }

    // Dispose existing client
    if (this.clients.has(account.id)) {
      const currentStatus = this.accountStatus.get(account.id);
      if (!forceReconnect && currentStatus === 'ready') {
        return { status: currentStatus };
      }
      await this.safeDisposeClient(account.id);
    }

    // Check for session
    let hasSession = false;
    try {
      hasSession = await db.hasSessionData(account.id);
    } catch (err) {
      logger.warn(`Could not check session for ${account.id}`);
    }

    if (!hasSession && skipIfNoSession) {
      logger.info(`No session for ${account.id}, skipping`);
      await db.updateAccount(account.id, {
        status: 'disconnected',
        error_message: 'No saved session - QR scan required',
        updated_at: new Date().toISOString()
      }).catch(() => {});
      return { status: 'disconnected' };
    }

    this.reconnecting.add(account.id);
    this.qrAttempts.delete(account.id);

    try {
      // Pre-restore session from Supabase
      if (hasSession) {
        logger.info(`Pre-restoring session for ${account.id}...`);
        const { restored } = await SupabaseAuth.preRestoreSession(account.id, './wa-sessions-temp');
        logger.info(`Session restore: ${restored ? 'success' : 'failed'}`);
      }

      await db.updateAccount(account.id, {
        status: 'initializing',
        error_message: null,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      this.qrCodes.delete(account.id);

      const client = new Client({
        authStrategy: new SupabaseAuth({
          accountId: account.id,
          dataPath: './wa-sessions-temp'
        }),
        puppeteer: PUPPETEER_CONFIG,
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webVersion.json'
        }
      });

      this.setupEventHandlers(client, account.id);
      this.clients.set(account.id, client);
      this.accountStatus.set(account.id, 'initializing');

      client.initialize()
        .then(() => {
          logger.info(`Client init started for ${account.name}`);
        })
        .catch(async (error) => {
          logger.error(`Init error for ${account.id}:`, error);

          if (error.message?.includes('auth') || error.message?.includes('Protocol')) {
            await db.clearSessionData(account.id).catch(() => {});
          }

          this.accountStatus.set(account.id, 'disconnected');
          this.clients.delete(account.id);
          await db.updateAccount(account.id, {
            status: 'disconnected',
            error_message: error.message,
            updated_at: new Date().toISOString()
          }).catch(() => {});
        })
        .finally(() => {
          this.reconnecting.delete(account.id);
        });

      return { status: 'initializing' };
    } catch (error) {
      logger.error(`Reconnect error for ${account.id}:`, error);
      
      await db.updateAccount(account.id, {
        status: 'disconnected',
        error_message: error.message,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      this.accountStatus.set(account.id, 'disconnected');
      this.reconnecting.delete(account.id);
      throw error;
    }
  }

  async cleanupDisconnectedAccounts() {
    try {
      for (const [accountId, status] of this.accountStatus) {
        if (status === 'disconnected' || status === 'error') {
          const client = this.clients.get(accountId);
          if (client) {
            logger.info(`Cleaning up ${accountId}`);
            await this.safeDisposeClient(accountId);
          }
        }
      }

      if (global.gc) global.gc();
    } catch (error) {
      logger.error('Cleanup error:', error);
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeClients: this.clients.size
    };
  }

  async shutdown() {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    logger.info(`Shutting down ${this.clients.size} client(s)...`);

    for (const [accountId, client] of this.clients.entries()) {
      try {
        // Save session before closing
        if (this.accountStatus.get(accountId) === 'ready' && client.authStrategy) {
          logger.info(`Saving session for ${accountId}...`);
          await client.authStrategy.saveSession().catch(() => {});
        }

        if (client.saveInterval) clearInterval(client.saveInterval);
        client.removeAllListeners();
        
        await Promise.race([
          client.destroy(),
          new Promise(resolve => setTimeout(resolve, 10000))
        ]).catch(() => {});
        
        logger.info(`Closed ${accountId}`);
      } catch (error) {
        logger.error(`Shutdown error for ${accountId}:`, error.message);
      }
    }

    this.clients.clear();
    this.accountStatus.clear();
    this.qrCodes.clear();
    this.reconnecting.clear();

    logger.info('WhatsAppManager shutdown complete');
  }
}

module.exports = new WhatsAppManager();
