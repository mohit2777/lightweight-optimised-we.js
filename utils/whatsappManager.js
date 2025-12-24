const { Client, MessageMedia, Buttons, List } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const axios = require('axios');
const logger = require('./logger');
const RemoteAuth = require('./RemoteAuth');
const { preRestoreSession } = require('./RemoteAuth');
const webhookDeliveryService = require('./webhookDeliveryService');
const FlowEngine = require('../services/flowEngine');
const flowState = require('../services/flowState');

// Memory threshold for cleanup (512MB - safe for Render free tier)
const MEMORY_WARNING_THRESHOLD = 400 * 1024 * 1024; // 400MB
const MEMORY_CRITICAL_THRESHOLD = 480 * 1024 * 1024; // 480MB

// Shared Puppeteer config - optimized for Render/Docker
const PUPPETEER_CONFIG = {
  headless: 'new',
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
    '--disable-notifications'
  ],
  defaultViewport: { width: 800, height: 600 },
  timeout: 90000
};

class WhatsAppManager {
  constructor() {
    this.clients = new Map(); // Store active WhatsApp clients
    this.qrCodes = new Map(); // Store QR codes for each account
    this.accountStatus = new Map(); // Store account status
    this.messageQueues = new Map(); // Message queues per account
    this.numberFormatCache = new Map(); // Cached formatted numbers
    this.webhookSecretCache = new Map(); // Cached webhook secrets
    this.reconnecting = new Set(); // Track accounts currently reconnecting
    this.eventHandlers = new Map(); // Store event handlers for cleanup
    this.isShuttingDown = false; // Track shutdown state
    this.qrAttempts = new Map(); // Track QR generation attempts per account
    this.io = null; // Socket.IO instance (set after server starts)

    // Performance metrics
    this.metrics = {
      messagesProcessed: 0,
      messagesFailed: 0,
      webhooksDelivered: 0,
      webhooksFailed: 0
    };
    webhookDeliveryService.on('delivery-success', () => {
      this.metrics.webhooksDelivered++;
    });
    webhookDeliveryService.on('delivery-failed', () => {
      this.metrics.webhooksFailed++;
    });

    // Cleanup caches periodically
    setInterval(() => this.cleanupCaches(), 3600000); // Every hour

    // Cleanup disconnected accounts periodically
    setInterval(() => this.cleanupDisconnectedAccounts(), 600000); // Every 10 minutes

    // Memory monitoring for cloud deployments (every 2 minutes)
    setInterval(() => this.checkMemoryUsage(), 120000);

    // Initialize Flow Engine
    this.flowEngine = new FlowEngine(this);
  }

  // Set Socket.IO instance for real-time updates
  setSocketIO(io) {
    this.io = io;
    logger.info('Socket.IO instance set for WhatsAppManager');
  }

  // Emit event to all connected clients
  emitToAll(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  // Emit event to specific account subscribers
  emitToAccount(accountId, event, data) {
    if (this.io) {
      this.io.to(`account-${accountId}`).emit(event, data);
    }
  }

  // Safely dispose of a WhatsApp client with timeout
  async safeDisposeClient(accountId, timeoutMs = 15000) {
    const client = this.clients.get(accountId);
    if (!client) return true;

    try {
      // Stop any save intervals
      if (client.saveInterval) {
        clearInterval(client.saveInterval);
        client.saveInterval = null;
      }

      // Remove all event listeners first to prevent callbacks during destruction
      client.removeAllListeners();

      // Try to destroy with timeout
      await Promise.race([
        client.destroy().catch(e => logger.warn(`Client destroy error for ${accountId}: ${e.message}`)),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);

      logger.info(`Client disposed for ${accountId}`);
    } catch (error) {
      logger.warn(`Error during client disposal for ${accountId}:`, error.message);
    } finally {
      // Always clean up references
      this.clients.delete(accountId);
      this.qrCodes.delete(accountId);
    }

    // Wait for Chrome processes to fully terminate
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  }

  // Check memory usage and cleanup if needed (for Render/Railway)
  checkMemoryUsage() {
    const used = process.memoryUsage();
    const heapUsed = used.heapUsed;
    const rss = used.rss;

    if (rss > MEMORY_CRITICAL_THRESHOLD) {
      logger.warn(`⚠️ CRITICAL: Memory usage high (${Math.round(rss / 1024 / 1024)}MB). Forcing garbage collection and cache cleanup...`);
      this.cleanupCaches();
      this.numberFormatCache.clear();
      this.webhookSecretCache.clear();
      if (global.gc) {
        global.gc();
        logger.info('Garbage collection triggered');
      }
    } else if (rss > MEMORY_WARNING_THRESHOLD) {
      logger.info(`Memory usage: ${Math.round(rss / 1024 / 1024)}MB (heap: ${Math.round(heapUsed / 1024 / 1024)}MB)`);
    }
  }

  // Create a new WhatsApp account instance with optimizations
  async createAccount(accountName, description = '') {
    if (this.isShuttingDown) {
      throw new Error('Server is shutting down, cannot create new accounts');
    }

    let accountId;
    const startTime = Date.now();

    try {
      accountId = uuidv4();

      // Create account in database first
      const accountData = {
        id: accountId,
        name: accountName,
        description: description,
        status: 'initializing',
        created_at: new Date().toISOString(),
        metadata: { created_by: 'system', version: '3.0', auth: 'remote' }
      };

      const account = await db.createAccount(accountData);

      // Initialize WhatsApp client with RemoteAuth (database-backed sessions)
      const client = new Client({
        authStrategy: new RemoteAuth({
          accountId: accountId,
          dataPath: './wa-sessions-temp' // Temporary directory for session files
        }),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webVersion.json'
        },
        puppeteer: PUPPETEER_CONFIG,
        queueOptions: {
          messageProcessingTimeoutMs: 15000,
          concurrency: 5
        }
      });

      // Set up event handlers
      this.setupEventHandlers(client, accountId);

      // Store client reference
      this.clients.set(accountId, client);
      this.accountStatus.set(accountId, 'initializing');

      // Initialize client asynchronously
      client.initialize().catch(err => {
        logger.error(`Client initialization error for ${accountId}:`, err);
        this.accountStatus.set(accountId, 'error');
        db.updateAccount(accountId, {
          status: 'error',
          error_message: err.message,
          updated_at: new Date().toISOString()
        }).catch(e => logger.error('Failed to update account status:', e));
      });

      const processingTime = Date.now() - startTime;
      logger.info(`Account created: ${accountId} (${accountName}) in ${processingTime}ms [RemoteAuth]`);

      return account;
    } catch (error) {
      logger.error('Error creating WhatsApp account:', error);
      if (accountId) {
        this.accountStatus.set(accountId, 'error');
      }
      throw error;
    }
  }

  // Set up event handlers for WhatsApp client
  setupEventHandlers(client, accountId) {
    // Remove existing listeners first to prevent memory leaks
    client.removeAllListeners();

    // Define handlers
    const handlers = {};
    client.on('qr', async (qr) => {
      try {
        // Track QR attempts to prevent infinite loops
        const attempts = (this.qrAttempts.get(accountId) || 0) + 1;
        this.qrAttempts.set(accountId, attempts);
        
        // If too many QR codes generated without successful auth, stop trying
        const maxQrAttempts = parseInt(process.env.MAX_QR_ATTEMPTS) || 15;
        if (attempts > maxQrAttempts) {
          logger.warn(`Account ${accountId} exceeded max QR attempts (${maxQrAttempts}). Stopping client.`);
          
          // Clear potentially corrupted session
          try {
            await db.clearSessionData(accountId);
            logger.info(`Cleared corrupt session for ${accountId}`);
          } catch (clearErr) {
            logger.error(`Failed to clear session for ${accountId}:`, clearErr.message);
          }
          
          // Update status and stop
          await db.updateAccount(accountId, {
            status: 'disconnected',
            error_message: 'Session expired - please reconnect manually',
            updated_at: new Date().toISOString()
          });
          
          this.accountStatus.set(accountId, 'disconnected');
          this.qrCodes.delete(accountId);
          
          // Destroy the client
          try {
            client.removeAllListeners();
            await client.destroy();
          } catch (e) { /* ignore */ }
          
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
        
        // Emit QR code to connected clients via Socket.IO
        this.emitToAll('qr', { accountId, qr: qrDataUrl });
        
        logger.info(`QR code generated for account ${accountId} (attempt ${attempts}/${maxQrAttempts})`);
      } catch (error) {
        logger.error(`Error generating QR code for ${accountId}:`, error);
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
        
        // Emit ready event to connected clients
        this.emitToAll('ready', { accountId, phoneNumber });

        logger.info(`WhatsApp client ready for account ${accountId} (${phoneNumber})`);

        // Save session after successful connection with retry
        if (client.authStrategy instanceof RemoteAuth) {
          const saveWithRetry = async (attempt = 1) => {
            try {
              await client.authStrategy.saveSessionToDb();
              logger.info(`Session saved to database for ${accountId} (attempt ${attempt})`);
              return true;
            } catch (err) {
              if (attempt < 3) {
                logger.warn(`Session save attempt ${attempt} failed for ${accountId}, retrying...`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                return saveWithRetry(attempt + 1);
              }
              logger.error(`All session save attempts failed for ${accountId}:`, err.message);
              return false;
            }
          };

          // Initial save with retry
          await saveWithRetry();
          
          // Second save after 5 seconds (browser state more stable)
          setTimeout(async () => {
            try {
              if (this.accountStatus.get(accountId) === 'ready') {
                await client.authStrategy.saveSessionToDb();
                logger.info(`[${accountId}] Secondary session save completed`);
              }
            } catch (err) {
              logger.warn(`Secondary session save failed for ${accountId}:`, err.message);
            }
          }, 5000);

          // Set up periodic save - default 15 minutes (was 5 min)
          // Can be disabled with DISABLE_PERIODIC_SESSION_SAVE=true to reduce egress
          if (process.env.DISABLE_PERIODIC_SESSION_SAVE !== 'true') {
            // Clear existing interval if any
            if (client.saveInterval) clearInterval(client.saveInterval);

            const saveIntervalMs = parseInt(process.env.SESSION_SAVE_INTERVAL_MS) || 15 * 60 * 1000; // 15 min default
            client.saveInterval = setInterval(async () => {
              try {
                if (this.accountStatus.get(accountId) === 'ready') {
                  await client.authStrategy.saveSessionToDb();
                }
              } catch (err) {
                logger.warn(`Periodic session save failed for ${accountId}:`, err.message);
              }
            }, saveIntervalMs);

            logger.info(`Session persistence enabled for account ${accountId} (interval: ${saveIntervalMs / 60000}min)`);
          } else {
            logger.info(`Periodic session save disabled for ${accountId} (egress saving mode)`);
          }
        }
      } catch (error) {
        logger.error(`Error updating account status for ${accountId}:`, error);
      }
    });

    client.on('authenticated', async (session) => {
      try {
        logger.info(`WhatsApp client authenticated for account ${accountId}`);
        
        // Emit authenticated event to connected clients
        this.emitToAll('authenticated', { accountId });
        
        // Reset QR attempts counter on successful authentication
        this.qrAttempts.delete(accountId);

        // Save session with multiple attempts after authentication
        if (client.authStrategy instanceof RemoteAuth) {
          const saveAttempts = [3000, 6000, 10000]; // Wait times before each attempt
          
          for (let i = 0; i < saveAttempts.length; i++) {
            await new Promise(resolve => setTimeout(resolve, saveAttempts[i]));
            
            try {
              await client.authStrategy.saveSessionToDb();
              logger.info(`Session saved after authentication for ${accountId} (attempt ${i + 1})`);
              break; // Success, exit loop
            } catch (saveErr) {
              if (i < saveAttempts.length - 1) {
                logger.warn(`Post-auth session save attempt ${i + 1} failed for ${accountId}, will retry...`);
              } else {
                logger.error(`All post-auth session save attempts failed for ${accountId}:`, saveErr.message);
              }
            }
          }
        }
      } catch (error) {
        logger.error(`Error in authenticated handler for ${accountId}:`, error);
        // Don't throw - allow connection to continue
      }
    });

    client.on('loading_screen', (percent, message) => {
      logger.info(`[${accountId}] Loading... ${percent}% - ${message}`);
    });

    client.on('remote_session_saved', async () => {
      logger.info(`[${accountId}] Remote session saved event triggered`);
    });

    client.on('auth_failure', async (msg) => {
      try {
        await db.updateAccount(accountId, {
          status: 'auth_failed',
          error_message: msg,
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'auth_failed');
        logger.error(`Authentication failed for account ${accountId}:`, msg);
      } catch (error) {
        logger.error(`Error updating auth failure status for ${accountId}:`, error);
      }
    });

    client.on('disconnected', async (reason) => {
      try {
        await db.updateAccount(accountId, {
          status: 'disconnected',
          error_message: reason,
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'disconnected');
        
        // Emit disconnected event to connected clients
        this.emitToAll('disconnected', { accountId, reason });
        
        logger.warn(`WhatsApp client disconnected for account ${accountId}:`, reason);

        // Clear session data on disconnect (will require QR scan to reconnect)
        if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
          await db.clearSessionData(accountId);
          logger.info(`Session data cleared for disconnected account ${accountId}`);
        }
      } catch (error) {
        logger.error(`Error updating disconnected status for ${accountId}:`, error);
      }
    });

    client.on('message', async (message) => {
      try {
        await this.handleIncomingMessage(client, accountId, message);
      } catch (error) {
        logger.error(`Error handling incoming message for ${accountId}:`, error);
      }
    });

    client.on('message_create', async (message) => {
      // Ignore status updates (broadcasts) completely
      if (message.from === 'status@broadcast' || message.to === 'status@broadcast') {
        return;
      }

      // Handle sent messages
      if (message.fromMe) {
        try {
          await db.updateAccount(accountId, {
            last_active_at: new Date().toISOString()
          });
        } catch (error) {
          logger.error(`Error updating last_active_at for ${accountId}:`, error);
        }
      }
    });
  }

  // Handle incoming messages with improved error handling
  async handleIncomingMessage(client, accountId, message) {
    // Ignore status updates (broadcasts) completely
    if (message.from === 'status@broadcast' || message.to === 'status@broadcast') {
      return;
    }

    const startTime = Date.now();

    try {
      const chat = await message.getChat();

      // Prepare message data
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
        processing_time_ms: null,
        created_at: new Date().toISOString()
      };

      // Add media data if present
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          const mediaSize = media.data ? Buffer.byteLength(media.data, 'base64') : 0;

          // Warn if media is very large (may cause webhook/DB issues)
          if (mediaSize > 10 * 1024 * 1024) { // 10MB
            logger.warn(`Large media received (${(mediaSize / 1024 / 1024).toFixed(2)}MB) for message ${message.id._serialized}`);
          }

          messageData.media = {
            mimetype: media.mimetype,
            filename: media.filename || 'media',
            size: mediaSize,
            data: media.data // Include base64 data for webhooks
          };
        } catch (mediaError) {
          logger.error(`Error downloading media for message ${message.id._serialized}:`, mediaError);
          // Log media error but continue processing
          messageData.media = {
            error: 'Failed to download media',
            error_message: mediaError.message
          };
        }
      }

      // Log message to database (this also persists history used by AI)
      await db.logMessage(messageData);

      // Update last active timestamp
      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      // Queue webhook deliveries for durable processing
      this.queueWebhookDeliveries(accountId, messageData).catch(err => {
        logger.error(`Error queueing webhooks for ${accountId}:`, err);
      });

      // Flow Engine Processing
      let flowHandled = false;
      if (message.type === 'chat' && message.body) {
        try {
          logger.info(`[WhatsAppManager] Processing flow for account ${accountId}, from: ${message.from}, body: "${message.body}"`);
          const session = await flowState.getSession(accountId, message.from);
          flowHandled = await this.flowEngine.processMessage(accountId, message.from, message.body, session);
          logger.info(`[WhatsAppManager] Flow processing result: ${flowHandled ? 'handled' : 'not handled'}`);
        } catch (err) {
          logger.error(`Flow engine error for ${accountId}:`, err.message || err, err.stack);
        }
      }

      // AI auto-reply (text chats only, if not handled by flow)
      if (!flowHandled && message.type === 'chat' && message.body && typeof message.body === 'string') {
        try {
          const aiAutoReplyService = require('./aiAutoReply');
          const reply = await aiAutoReplyService.generateReply({
            accountId,
            contactId: message.from,
            message: message.body
          });

          if (reply && reply.trim()) {
            await this.sendMessage(accountId, message.from, reply.trim(), { type: 'chatbot_reply' });
          }
        } catch (aiError) {
          logger.error(`AI auto-reply error for ${accountId}:`, aiError.message || aiError);
        }
      }

      const processingTime = Date.now() - startTime;
      messageData.processing_time_ms = processingTime;
      this.metrics.messagesProcessed++;

    } catch (error) {
      logger.error(`Error handling incoming message for ${accountId}:`, error);
      this.metrics.messagesFailed++;

      // Log error
      await db.logMessage({
        account_id: accountId,
        direction: 'incoming',
        status: 'failed',
        error_message: error.message,
        created_at: new Date().toISOString()
      });
    }
  }

  async queueWebhookDeliveries(accountId, messageData) {
    try {
      const webhooks = await db.getWebhooks(accountId);
      if (!webhooks || webhooks.length === 0) {
        return;
      }

      const activeWebhooks = webhooks.filter(webhook => webhook.is_active);
      if (activeWebhooks.length === 0) {
        return;
      }

      await webhookDeliveryService.queueDeliveries(accountId, activeWebhooks, messageData);
    } catch (error) {
      logger.error(`Error queueing webhook deliveries for ${accountId}:`, error);
    }
  }

  // Send message with queue management
  async sendMessage(accountId, number, message, options = {}) {
    const startTime = Date.now();

    // Initialize queue if needed
    if (!this.messageQueues.has(accountId)) {
      this.messageQueues.set(accountId, []);
    }

    const queue = this.messageQueues.get(accountId);
    const maxQueueSize = parseInt(process.env.WA_MESSAGE_QUEUE_SIZE) || 20;

    // Check queue size
    if (queue.length >= maxQueueSize) {
      throw new Error('Message queue is full. Please try again later.');
    }

    try {
      const client = this.clients.get(accountId);
      if (!client) {
        throw new Error('WhatsApp client not found for this account');
      }

      const status = this.accountStatus.get(accountId);
      if (status !== 'ready') {
        throw new Error(`WhatsApp client is not ready. Current status: ${status}`);
      }

      if (!client.pupPage || client.pupPage._closed) {
        throw new Error('WhatsApp client page is closed or not available');
      }

      // Format phone number
      const formattedNumber = this.getFormattedNumber(number);

      // Add to queue
      const queueItem = {
        number: formattedNumber,
        message,
        options,
        timestamp: Date.now()
      };
      queue.push(queueItem);

      // Send typing indicator (non-blocking, short delay)
      // Reduced from 500-3000ms to 200-800ms for faster responses
      const typingPromise = (async () => {
        try {
          const chat = await client.getChatById(formattedNumber);
          if (chat) {
            await chat.sendStateTyping();
            // Short typing delay - enough to feel natural but not slow
            const typingDelay = Math.min(800, Math.max(200, (typeof message === 'string' ? message.length : 30) * 10));
            await new Promise(resolve => setTimeout(resolve, typingDelay));
          }
        } catch (typingErr) {
          // Ignore typing indicator errors - not critical
        }
      })();

      // Wait for typing (but with a max timeout of 1 second)
      await Promise.race([
        typingPromise,
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);

      // Send message
      const result = await client.sendMessage(formattedNumber, message, options);

      // Clear typing state after sending (don't await - fire and forget)
      client.getChatById(formattedNumber).then(chat => {
        if (chat) chat.clearState().catch(() => {});
      }).catch(() => {});

      // Remove from queue
      const index = queue.findIndex(item =>
        item.number === formattedNumber &&
        item.message === message &&
        item.timestamp === queueItem.timestamp
      );
      if (index !== -1) queue.splice(index, 1);

      const processingTime = Date.now() - startTime;

      // Log outgoing message
      try {
        let messageContent = message;
        let messageType = options.type || 'text';

        if (message instanceof Buttons) {
          messageContent = message.body;
          messageType = 'buttons';
        } else if (message instanceof List) {
          messageContent = message.body;
          messageType = 'list';
        } else if (typeof message === 'object') {
          // Fallback for other objects
          messageContent = JSON.stringify(message);
        }

        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          message_id: result.id._serialized,
          sender: result.from,
          recipient: result.to,
          message: messageContent,
          timestamp: result.timestamp,
          type: messageType,
          status: 'success',
          processing_time_ms: processingTime,
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        // Don't fail the send if logging fails
        logger.error('Failed to log outgoing message:', logError);
      }

      // Update last active
      try {
        await db.updateAccount(accountId, {
          last_active_at: new Date().toISOString()
        });
      } catch (updateError) {
        logger.warn('Failed to update account last_active_at:', updateError.message);
      }

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.id._serialized,
        timestamp: result.timestamp,
        processingTime
      };

    } catch (error) {
      this.metrics.messagesFailed++;

      // Log failed message
      try {
        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          recipient: number,
          message: message,
          status: 'failed',
          error_message: error.message,
          processing_time_ms: Date.now() - startTime,
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        logger.error('Failed to log failed message:', logError);
      }

      throw error;
    }
  }

  // Send media with validation and optimization
  async sendMedia(accountId, number, media, caption = '', options = {}) {
    const startTime = Date.now();

    // Validate media payload
    if (!media || (!media.data && !media.url)) {
      throw new Error('Invalid media payload. Expect { data | url, mimetype?, filename? }');
    }

    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error('WhatsApp client not found for this account');
    }

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') {
      throw new Error(`WhatsApp client is not ready. Current status: ${status}`);
    }

    if (!client.pupPage || client.pupPage._closed) {
      throw new Error('WhatsApp client page is closed or not available');
    }

    try {
      // Prepare media data
      let base64Data = media.data || '';
      let mimetype = media.mimetype || '';
      let filename = media.filename || '';

      // Fetch from URL if provided
      if (media.url && !base64Data) {
        const response = await axios.get(media.url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: 16 * 1024 * 1024 // 16MB limit
        });

        const buffer = Buffer.from(response.data);
        base64Data = buffer.toString('base64');
        mimetype = mimetype || response.headers['content-type'] || 'application/octet-stream';

        if (!filename) {
          try {
            const urlObj = new URL(media.url);
            filename = urlObj.pathname.split('/').pop() || '';
          } catch { }
        }
      }

      // Normalize base64
      const dataUrlPrefix = /^data:[^;]+;base64,/i;
      if (base64Data && dataUrlPrefix.test(base64Data)) {
        base64Data = base64Data.replace(dataUrlPrefix, '');
      }

      if (!mimetype) {
        throw new Error('mimetype is required when sending media');
      }

      // Check size limit
      const sizeBytes = Buffer.byteLength(base64Data, 'base64');
      const maxSize = 16 * 1024 * 1024; // 16MB
      if (sizeBytes > maxSize) {
        throw new Error(`Media too large (${(sizeBytes / 1024 / 1024).toFixed(2)}MB). Max allowed ~16MB`);
      }

      // Build MessageMedia
      filename = filename || this.deriveDefaultFilename(mimetype);
      const msgMedia = new MessageMedia(mimetype, base64Data, filename);

      // Format number
      const formattedNumber = this.getFormattedNumber(number);

      // Send options
      const isAudio = typeof mimetype === 'string' && mimetype.startsWith('audio/');
      const sendOptions = { caption };

      if (isAudio && options.sendAudioAsVoice) {
        sendOptions.sendAudioAsVoice = true;
      } else if (options.sendMediaAsDocument) {
        sendOptions.sendMediaAsDocument = true;
      }

      // Send typing indicator before sending media to reduce ban risk
      try {
        const chat = await client.getChatById(formattedNumber);
        if (chat) {
          await chat.sendStateTyping();
          // Short delay for media (1-2 seconds)
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      } catch (typingErr) {
        // Ignore typing indicator errors - not critical
        logger.debug(`Typing indicator error (non-critical): ${typingErr.message}`);
      }

      const result = await client.sendMessage(formattedNumber, msgMedia, sendOptions);

      // Clear typing state after sending
      try {
        const chat = await client.getChatById(formattedNumber);
        if (chat) await chat.clearState();
      } catch (e) { /* Ignore */ }

      const processingTime = Date.now() - startTime;

      // Log outgoing media
      try {
        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          message_id: result.id?._serialized,
          sender: result.from,
          recipient: result.to,
          message: caption || '',
          type: 'media',
          media: {
            mimetype: mimetype,
            filename: filename,
            size: sizeBytes,
            source: media.url ? 'url' : 'base64'
          },
          status: 'success',
          timestamp: result.timestamp,
          processing_time_ms: processingTime,
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        logger.error('Failed to log outgoing media:', logError);
      }

      // Update last active
      try {
        await db.updateAccount(accountId, {
          last_active_at: new Date().toISOString()
        });
      } catch (updateError) {
        logger.warn('Failed to update account last_active_at:', updateError.message);
      }

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.id?._serialized,
        timestamp: result.timestamp,
        processingTime
      };

    } catch (error) {
      this.metrics.messagesFailed++;

      logger.error(`Error sending media for account ${accountId}:`, error);

      try {
        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          recipient: number,
          message: caption || '',
          type: 'media',
          status: 'failed',
          error_message: error.message,
          processing_time_ms: Date.now() - startTime,
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        logger.error('Failed to log failed media send:', logError);
      }

      throw error;
    }
  }

  // Derive default filename from mimetype
  deriveDefaultFilename(mimetype) {
    try {
      const ext = mimetype.split('/')[1] || 'bin';
      return `media.${ext}`;
    } catch {
      return 'media.bin';
    }
  }

  // Get formatted number with caching
  getFormattedNumber(number) {
    if (this.numberFormatCache.has(number)) {
      return this.numberFormatCache.get(number);
    }

    const formattedNumber = this.formatPhoneNumber(number);

    // Limit cache size
    if (this.numberFormatCache.size > 1000) {
      const firstKey = this.numberFormatCache.keys().next().value;
      this.numberFormatCache.delete(firstKey);
    }

    this.numberFormatCache.set(number, formattedNumber);
    return formattedNumber;
  }

  // Format phone number for WhatsApp
  formatPhoneNumber(number) {
    // If already has @c.us or @s.whatsapp.net, return as is
    if (number.includes('@')) {
      return number;
    }

    // Remove all non-digit characters (spaces, dashes, parentheses, etc.)
    let cleaned = number.replace(/[^\d]/g, '');

    // Remove leading zeros
    cleaned = cleaned.replace(/^0+/, '');

    // Handle different formats:
    // - 1234567890 (10 digits) -> add country code 91
    // - 911234567890 (12 digits with 91) -> use as is
    // - 11234567890 (11 digits) -> use as is

    if (cleaned.length === 10) {
      // Assume it's a local number without country code, add default country code 91
      cleaned = '91' + cleaned;
    }
    // For 11-15 digit numbers, assume they already have country code

    // Build WhatsApp JID
    return cleaned + '@c.us';
  }

  // Get QR code
  getQRCode(accountId) {
    return this.qrCodes.get(accountId);
  }

  // Get account status
  getAccountStatus(accountId) {
    return this.accountStatus.get(accountId);
  }

  // Check if reconnect is already in progress
  isReconnecting(accountId) {
    return this.reconnecting.has(accountId);
  }

  // Force-generate a new QR code by restarting the client
  async requestNewQRCode(accountId) {
    const account = await db.getAccount(accountId);

    if (!account) {
      throw new Error('Account not found');
    }

    return this.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'qr_request'
    });
  }

  // Get all account statuses
  getAllAccountStatuses() {
    const statuses = {};
    for (const [accountId, status] of this.accountStatus) {
      statuses[accountId] = status;
    }
    return statuses;
  }

  // Delete account
  async deleteAccount(accountId) {
    try {
      const client = this.clients.get(accountId);

      if (client) {
        // Clear save interval
        if (client.saveInterval) clearInterval(client.saveInterval);

        // Remove all event listeners to prevent memory leaks
        client.removeAllListeners();

        // Destroy client (kills Chrome process)
        await client.destroy();

        // Clean up all references
        this.clients.delete(accountId);
      }

      // Clean up all account data
      this.qrCodes.delete(accountId);
      this.accountStatus.delete(accountId);
      this.messageQueues.delete(accountId);
      this.eventHandlers.delete(accountId);
      this.reconnecting.delete(accountId);

      // Clear session data from database
      await db.clearSessionData(accountId);

      // Delete from database
      await db.deleteAccount(accountId);

      logger.info(`Account fully deleted and cleaned up: ${accountId}`);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        logger.info('Forced garbage collection after account deletion');
      }

      return true;
    } catch (error) {
      logger.error(`Error deleting account ${accountId}:`, error);
      throw error;
    }
  }

  // Initialize existing accounts from database
  async initializeExistingAccounts() {
    try {
      // Skip auto-initialization if disabled via environment variable
      if (process.env.DISABLE_AUTO_INIT === 'true') {
        logger.info('Auto-initialization of accounts is disabled. Accounts will start when manually triggered.');
        return;
      }

      // NOTE: We do NOT clean up temp session dirs here anymore
      // Each account's RemoteAuth will restore its session from database
      // Cleaning up would delete sessions before they can be restored!

      const accounts = await db.getAccounts();
      
      // Only auto-initialize accounts that have session data (were previously connected)
      const accountsWithSessions = [];
      for (const account of accounts) {
        try {
          const hasSession = await db.hasSessionData(account.id);
          if (hasSession) {
            accountsWithSessions.push(account);
          } else {
            // Mark accounts without sessions as disconnected
            this.accountStatus.set(account.id, 'disconnected');
          }
        } catch (err) {
          logger.warn(`Could not check session for ${account.id}:`, err.message);
        }
      }

      logger.info(`Found ${accounts.length} accounts, ${accountsWithSessions.length} have saved sessions`);

      // Limit concurrent initializations to reduce load
      const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_INIT, 10) || 2;
      
      for (let i = 0; i < accountsWithSessions.length; i += maxConcurrent) {
        const batch = accountsWithSessions.slice(i, i + maxConcurrent);
        
        await Promise.all(batch.map(async (account) => {
          try {
            const result = await this.reconnectAccount(account, {
              skipIfNoSession: true,
              reason: 'startup'
            });

            if (result?.status === 'disconnected') {
              this.accountStatus.set(account.id, 'disconnected');
            }
          } catch (reconnectError) {
            logger.error(`Startup reconnect failed for ${account.id}:`, reconnectError.message);
            this.accountStatus.set(account.id, 'error');
          }
        }));
        
        // Add delay between batches
        if (i + maxConcurrent < accountsWithSessions.length) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      logger.info(`Finished initializing existing accounts`);
    } catch (error) {
      logger.error('Error initializing existing accounts:', error);
    }
  }

  // Clean up temporary session directories
  async cleanupTempSessionDirs() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const tempPath = './wa-sessions-temp';

      const exists = await fs.access(tempPath).then(() => true).catch(() => false);

      if (exists) {
        logger.info('Cleaning up temporary session directories from previous run...');
        await fs.rm(tempPath, { recursive: true, force: true });
        logger.info('Temporary session directories cleaned');
      }
    } catch (error) {
      logger.warn('Error cleaning up temp session dirs:', error.message);
    }
  }

  // Reconnect to existing account (optionally forcing a fresh QR)
  async reconnectAccount(account, options = {}) {
    const { forceReconnect = false, reason = 'manual', skipIfNoSession = false } = options;

    logger.info(`Reconnecting account ${account.id} (${account.name}). Reason: ${reason}, Force: ${forceReconnect}`);

    if (this.reconnecting.has(account.id)) {
      logger.warn(`Reconnect already in progress for ${account.id}, skipping request (${reason})`);
      return { status: 'reconnecting' };
    }

    const existingClient = this.clients.get(account.id);
    if (existingClient) {
      const currentStatus = this.accountStatus.get(account.id);

      if (!forceReconnect && currentStatus === 'ready') {
        logger.warn(`Client already ready for ${account.id}, skipping reconnect (${reason})`);
        return { status: currentStatus };
      }

      logger.info(`Disposing existing client for ${account.id} before reconnect (${reason})`);
      
      // Use safe dispose with proper cleanup and wait
      await this.safeDisposeClient(account.id);
      
      // Additional wait if client was initializing (race condition prevention)
      if (currentStatus === 'initializing') {
        logger.info(`Waiting extra time for ${account.id} as it was still initializing...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    let hasSession = false;
    try {
      hasSession = await db.hasSessionData(account.id);
    } catch (sessionError) {
      logger.warn(`Could not verify session state for ${account.id}:`, sessionError);
    }

    // If we are just starting up and there is no session, we don't want to start a browser
    // because it will sit there waiting for a QR scan that no one is looking at.
    if (!hasSession && skipIfNoSession) {
      logger.info(`Skipping reconnect for ${account.id} - no persisted session (${reason})`);

      // Update database to reflect disconnected state
      try {
        await db.updateAccount(account.id, {
          status: 'disconnected',
          error_message: 'No saved session - QR scan required',
          updated_at: new Date().toISOString()
        });
      } catch (updateError) {
        logger.warn(`Could not update disconnected status for ${account.id}:`, updateError);
      }

      return { status: 'disconnected' };
    }

    this.reconnecting.add(account.id);
    
    // Reset QR attempts counter for fresh reconnection
    this.qrAttempts.delete(account.id);

    try {
      if (!hasSession) {
        logger.info(`No session data found for ${account.id}, requesting fresh QR (${reason})`);
      } else {
        // PRE-RESTORE: Restore session files from database BEFORE creating client
        // This ensures files are ready when Puppeteer starts
        logger.info(`[PreRestore] Pre-restoring session for ${account.id} before client creation...`);
        const startTime = Date.now();
        const { restored, sessionPath } = await preRestoreSession(account.id, './wa-sessions-temp');
        const duration = Date.now() - startTime;
        
        if (restored) {
          logger.info(`[PreRestore] Session pre-restored in ${duration}ms for ${account.id}`);
        } else {
          logger.warn(`[PreRestore] Could not pre-restore session for ${account.id}, will need QR`);
        }
      }

      try {
        await db.updateAccount(account.id, {
          status: 'initializing',
          error_message: null,
          updated_at: new Date().toISOString()
        });
      } catch (updateError) {
        logger.warn(`Could not update account status to initializing for ${account.id}:`, updateError);
      }

      this.qrCodes.delete(account.id);

      const client = new Client({
        authStrategy: new RemoteAuth({
          accountId: account.id,
          dataPath: './wa-sessions-temp'
        }),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/webVersion.json'
        },
        puppeteer: PUPPETEER_CONFIG,
        queueOptions: {
          messageProcessingTimeoutMs: 15000,
          concurrency: 5
        }
      });

      this.setupEventHandlers(client, account.id);
      this.clients.set(account.id, client);
      this.accountStatus.set(account.id, 'initializing');

      // Initialize client asynchronously
      client.initialize()
        .then(() => {
          logger.info(`Client initialization started for: ${account.name} (${account.id})`);
        })
        .catch(async (error) => {
          logger.error(`Error initializing client for account ${account.id}:`, error);

          // If authentication failed, clear corrupt session
          if (error.message?.includes('auth') || error.message?.includes('Protocol') || error.message?.includes('Evaluation failed')) {
            logger.warn(`Clearing potentially corrupt session for ${account.id}`);
            try {
              await db.clearSessionData(account.id);
            } catch (clearError) {
              logger.error(`Could not clear session for ${account.id}:`, clearError);
            }
          }

          this.accountStatus.set(account.id, 'disconnected');
          this.clients.delete(account.id);
          await db.updateAccount(account.id, {
            status: 'disconnected',
            error_message: error.message,
            updated_at: new Date().toISOString()
          });
        })
        .finally(() => {
          this.reconnecting.delete(account.id);
        });

      return { status: 'initializing' };
    } catch (error) {
      logger.error(`Error reconnecting to account ${account.id}:`, error);

      await db.updateAccount(account.id, {
        status: 'disconnected',
        error_message: error.message,
        updated_at: new Date().toISOString()
      });

      this.accountStatus.set(account.id, 'disconnected');
      this.reconnecting.delete(account.id);
      throw error;
    }
  }

  // Cleanup caches
  cleanupCaches() {
    // Clear number format cache if too large
    if (this.numberFormatCache.size > 1000) {
      const keysToDelete = Array.from(this.numberFormatCache.keys()).slice(0, 500);
      keysToDelete.forEach(key => this.numberFormatCache.delete(key));
      logger.info(`Cleaned up ${keysToDelete.length} entries from number format cache`);
    }

    // Clear webhook secret cache
    this.webhookSecretCache.clear();
    logger.info('Cleared webhook secret cache');
  }

  // Cleanup disconnected accounts to free memory
  async cleanupDisconnectedAccounts() {
    try {
      const accounts = await db.getAccounts();
      let cleanedCount = 0;

      for (const account of accounts) {
        const client = this.clients.get(account.id);
        const status = this.accountStatus.get(account.id);

        // Clean up if client exists but account is disconnected in database
        if (client && account.status === 'disconnected') {
          logger.info(`Cleaning up disconnected account: ${account.id}`);

          try {
            await client.destroy();
            this.clients.delete(account.id);
            this.accountStatus.delete(account.id);
            this.qrCodes.delete(account.id);
            this.eventHandlers.delete(account.id);
            cleanedCount++;
          } catch (cleanupError) {
            logger.error(`Error cleaning up account ${account.id}:`, cleanupError);
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} disconnected account(s)`);

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
          logger.info('Forced garbage collection');
        }
      }
    } catch (error) {
      logger.error('Error in cleanup task:', error);
    }
  }

  // Get performance metrics
  getMetrics() {
    return {
      ...this.metrics,
      activeClients: this.clients.size,
      queueSizes: Object.fromEntries(
        Array.from(this.messageQueues.entries()).map(([id, queue]) => [id, queue.length])
      )
    };
  }

  // Graceful shutdown - close all WhatsApp clients
  async shutdown() {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    logger.info(`Shutting down WhatsAppManager - closing ${this.clients.size} client(s)...`);

    const shutdownPromises = [];

    for (const [accountId, client] of this.clients.entries()) {
      const shutdownPromise = (async () => {
        try {
          logger.info(`Closing client for account ${accountId}`);
          
          // Save session before closing (only if authenticated)
          if (this.accountStatus.get(accountId) === 'ready' && client.authStrategy instanceof RemoteAuth) {
            try {
              logger.info(`Saving session for account ${accountId} before shutdown...`);
              await client.authStrategy.saveSessionToDb();
              logger.info(`Session saved for account ${accountId}`);
            } catch (saveErr) {
              logger.warn(`Could not save session for ${accountId}: ${saveErr.message}`);
            }
          }
          
          // Clear interval if any
          if (client.saveInterval) {
            clearInterval(client.saveInterval);
          }
          
          client.removeAllListeners();
          await Promise.race([
            client.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
          ]);
          logger.info(`Client closed for account ${accountId}`);
        } catch (error) {
          logger.error(`Error closing client ${accountId}:`, error.message);
        }
      })();

      shutdownPromises.push(shutdownPromise);
    }

    await Promise.allSettled(shutdownPromises);

    // Clear all data structures
    this.clients.clear();
    this.accountStatus.clear();
    this.qrCodes.clear();
    this.messageQueues.clear();
    this.eventHandlers.clear();
    this.reconnecting.clear();

    logger.info('WhatsAppManager shutdown complete');
  }

  // Send buttons
  async sendButtons(accountId, number, body, buttons, title = null, footer = null, media = null) {
    try {
      const client = this.clients.get(accountId);
      if (!client) throw new Error('WhatsApp client not found for this account');

      const status = this.accountStatus.get(accountId);
      if (status !== 'ready') throw new Error(`WhatsApp client is not ready. Current status: ${status}`);

      // Format buttons manually (replicating Buttons._format from whatsapp-web.js)
      const formattedButtons = buttons.slice(0, 3).map(btn => {
        const btnBody = typeof btn === 'string' ? btn : btn.body;
        const btnId = (typeof btn === 'object' && btn.id) ? String(btn.id) : Math.random().toString(36).substring(2, 8);
        return {
          buttonId: btnId,
          buttonText: { displayText: btnBody },
          type: 1
        };
      });

      let contentBody = body;
      let attachment = null;

      // Handle media if provided
      if (media && (media.data || media.url)) {
        let base64Data = media.data || '';
        let mimetype = media.mimetype || '';
        let filename = media.filename || '';

        // Fetch from URL if provided and no data
        if (media.url && !base64Data) {
          const response = await axios.get(media.url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 16 * 1024 * 1024
          });

          const buffer = Buffer.from(response.data);
          base64Data = buffer.toString('base64');
          mimetype = mimetype || response.headers['content-type'] || 'application/octet-stream';

          if (!filename) {
            try {
              const urlObj = new URL(media.url);
              filename = urlObj.pathname.split('/').pop() || '';
            } catch { }
          }
        }

        // Normalize base64
        const dataUrlPrefix = /^data:[^;]+;base64,/i;
        if (base64Data && dataUrlPrefix.test(base64Data)) {
          base64Data = base64Data.replace(dataUrlPrefix, '');
        }

        if (mimetype) {
          filename = filename || this.deriveDefaultFilename(mimetype);
          // Create plain object for media
          attachment = {
            mimetype,
            data: base64Data,
            filename
          };
          contentBody = attachment;
        }
      }

      const formattedNumber = this.getFormattedNumber(number);

      // Send typing indicator before sending buttons to reduce ban risk
      try {
        const chat = await client.getChatById(formattedNumber);
        if (chat) {
          await chat.sendStateTyping();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (typingErr) {
        logger.debug(`Typing indicator error (non-critical): ${typingErr.message}`);
      }

      // BYPASS: Directly execute in browser to avoid "Buttons are deprecated" warning/error in Client.js
      // AND use 'interactive' message type which is the modern replacement for buttons
      const result = await client.pupPage.evaluate(async (chatId, contentBody, formattedButtons, title, footer, isMedia) => {
        // Get chat
        const chat = await window.WWebJS.getChat(chatId);

        // Construct the interactive message structure
        // This bypasses the old 'Buttons' class and uses the new 'interactive' type directly

        const buttons = formattedButtons.map(btn => ({
          type: 'reply',
          reply: {
            id: btn.buttonId,
            title: btn.buttonText.displayText
          }
        }));

        const interactivePayload = {
          type: 'button',
          body: { text: typeof contentBody === 'string' ? contentBody : '' },
          footer: { text: footer || '' },
          action: { buttons: buttons }
        };

        if (title) {
          interactivePayload.header = { title: title, subtitle: '', hasMediaAttachment: false };
        }

        // Handle media if present
        if (isMedia && contentBody) {
          try {
            const mediaOptions = await window.WWebJS.processMediaData(contentBody, {
              forceSticker: false,
              forceGif: false,
              forceVoice: false,
              forceDocument: false,
              forceMediaHd: false
            });

            interactivePayload.header = {
              hasMediaAttachment: true,
              ...mediaOptions
            };
          } catch (e) {
            console.error('Failed to process media for interactive message', e);
          }
        }

        const newId = await window.Store.MsgKey.newId();
        const meUser = window.Store.User.getMaybeMePnUser();

        const newMsgKey = new window.Store.MsgKey({
          from: meUser,
          to: chat.id,
          id: newId,
          participant: undefined,
          selfDir: 'out',
        });

        const message = {
          id: newMsgKey,
          ack: 0,
          from: meUser,
          to: chat.id,
          local: true,
          self: 'out',
          t: parseInt(new Date().getTime() / 1000),
          isNewMsg: true,
          type: 'interactive',
          interactive: interactivePayload,
          // Remove isDynamicReplyButtonsMsg as it might conflict with type 'interactive'
          // isDynamicReplyButtonsMsg: true 
        };

        // Send message
        const [msgPromise, sendMsgResultPromise] = await window.Store.SendMessage.addAndSendMsgToChat(chat, message);
        await msgPromise;
        // await sendMsgResultPromise; // Optional: wait for server ack

        // Return serialized message
        return { id: newMsgKey, timestamp: message.t, from: meUser._serialized, to: chat.id._serialized };

      }, formattedNumber, contentBody, formattedButtons, title, footer, !!attachment);

      // Clear typing state after sending
      try {
        const chat = await client.getChatById(formattedNumber);
        if (chat) await chat.clearState();
      } catch (e) { /* Ignore */ }

      if (!result) {
        throw new Error('Failed to send buttons: Browser returned no result (possibly blocked by WhatsApp)');
      }

      // Log success
      try {
        await db.logMessage({
          account_id: accountId,
          direction: 'outgoing',
          message_id: result.id._serialized,
          sender: result.from,
          recipient: result.to,
          message: typeof body === 'string' ? body : 'Media Button Message',
          timestamp: result.timestamp,
          type: 'buttons',
          status: 'success',
          processing_time_ms: 0, // Approximate
          created_at: new Date().toISOString()
        });
      } catch (logError) {
        logger.error('Failed to log outgoing button message:', logError);
      }

      return {
        success: true,
        messageId: result.id._serialized,
        timestamp: result.timestamp
      };

    } catch (error) {
      logger.error(`Error sending buttons for account ${accountId}:`, error);
      throw error;
    }
  }

  // Send list
  async sendList(accountId, number, body, buttonText, sections, title = null, footer = null) {
    try {
      // sections array example: [{title: 'Section 1', rows: [{id: 'row1', title: 'Row 1', description: 'Desc'}]}]
      const listObj = new List(body, buttonText, sections, title, footer);
      return this.sendMessage(accountId, number, listObj);
    } catch (error) {
      logger.error(`Error sending list for account ${accountId}:`, error);
      throw error;
    }
  }
}

module.exports = new WhatsAppManager();
