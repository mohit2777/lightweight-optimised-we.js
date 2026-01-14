/**
 * WhatsApp Manager - Baileys Version (No Chromium Required)
 * Uses @whiskeysockets/baileys for WhatsApp Web connection
 * Focused on minimal RAM usage and reliable session persistence
 * Database-backed session storage for ephemeral environments
 */

// ============================================================================
// MUST BE FIRST: Suppress noisy Baileys/Signal debug output BEFORE loading Baileys
// ============================================================================
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
let suppressNextLog = false;

console.log = (...args) => {
  // Suppress log following "Closing session"
  if (suppressNextLog) {
    suppressNextLog = false;
    return;
  }
  
  const str = args.map(a => typeof a === 'string' ? a : '').join(' ');
  if (str.includes('Closing session') || str.includes('Closing open session')) {
    suppressNextLog = true; // Suppress the SessionEntry object that follows
    return;
  }
  
  const firstArg = args[0];
  if (firstArg && typeof firstArg === 'object') {
    // Suppress SessionEntry and Signal protocol debug objects
    if (firstArg._chains || firstArg.registrationId || firstArg.currentRatchet || 
        firstArg.indexInfo || firstArg.pendingPreKey || firstArg.ephemeralKeyPair) return;
    if (firstArg.constructor && firstArg.constructor.name === 'SessionEntry') return;
  }
  originalConsoleLog.apply(console, args);
};
console.error = (...args) => {
  const str = args.map(a => typeof a === 'string' ? a : (a?.message || '')).join(' ');
  if (str.includes('Failed to decrypt') || str.includes('Bad MAC') || 
      str.includes('Session error') || str.includes('no sessions')) return;
  originalConsoleError.apply(console, args);
};
// ============================================================================

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../config/database');
const axios = require('axios');
const logger = require('./logger');
const webhookDeliveryService = require('./webhookDeliveryService');
const chatbotManager = require('./chatbot');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Memory thresholds - aggressive for low-RAM environments (512MB Render free tier)
const MEMORY_WARNING_THRESHOLD = 300 * 1024 * 1024; // 300MB
const MEMORY_CRITICAL_THRESHOLD = 420 * 1024 * 1024; // 420MB

// Baileys auth state backed by database
async function useDBAuthState(accountId) {
  const sessionPath = path.join('./wa-sessions-temp', accountId);
  
  // Ensure directory exists
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  // Try to restore from database first
  try {
    const sessionData = await db.getSessionData(accountId);
    if (sessionData && sessionData.length > 10) {
      const decoded = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf-8'));
      
      // Validate that decoded has proper structure
      if (decoded && typeof decoded === 'object' && decoded.creds) {
        // Write creds.json
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(decoded.creds, null, 2));
        
        // Write ALL saved files (keys, pre-keys, sessions, etc.)
        if (decoded.keys && typeof decoded.keys === 'object') {
          let fileCount = 0;
          for (const [filename, data] of Object.entries(decoded.keys)) {
            if (filename && data) {
              fs.writeFileSync(path.join(sessionPath, filename), JSON.stringify(data, null, 2));
              fileCount++;
            }
          }
          logger.info(`[BaileysAuth] Session restored from database for: ${accountId} (${fileCount} key files)`);
        } else {
          logger.info(`[BaileysAuth] Session restored from database for: ${accountId} (creds only)`);
        }
      } else {
        logger.warn(`[BaileysAuth] Invalid session structure for ${accountId}, will generate new session`);
      }
    }
  } catch (err) {
    logger.warn(`[BaileysAuth] Could not restore session from DB: ${err.message}`);
    // Clear corrupted session directory and try fresh
    try {
      const files = fs.readdirSync(sessionPath);
      for (const file of files) {
        fs.unlinkSync(path.join(sessionPath, file));
      }
      logger.info(`[BaileysAuth] Cleared corrupted session files for: ${accountId}`);
    } catch {}
  }

  // Use file-based auth state
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Debounce timer for session saves
  let saveTimeout = null;
  let lastSaveTime = 0;
  const SAVE_DEBOUNCE_MS = 10000; // Wait 10 seconds before saving
  const MIN_SAVE_INTERVAL_MS = 30000; // At least 30 seconds between saves

  // Function to save ALL session files to database (not just creds) - DEBOUNCED
  const saveAllToDatabase = async (force = false) => {
    const now = Date.now();
    
    // If forced (shutdown), save immediately
    if (force) {
      if (saveTimeout) clearTimeout(saveTimeout);
      await doSaveToDatabase();
      return;
    }
    
    // Debounce: wait for activity to settle
    if (saveTimeout) clearTimeout(saveTimeout);
    
    saveTimeout = setTimeout(async () => {
      // Rate limit: don't save too frequently
      if (now - lastSaveTime < MIN_SAVE_INTERVAL_MS) {
        return;
      }
      await doSaveToDatabase();
    }, SAVE_DEBOUNCE_MS);
  };

  // Actual save function
  const doSaveToDatabase = async () => {
    try {
      const credsPath = path.join(sessionPath, 'creds.json');
      if (!fs.existsSync(credsPath)) return;
      
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      
      // Collect ALL files (keys, pre-keys, sessions, sender-keys, etc.)
      const keys = {};
      const files = fs.readdirSync(sessionPath);
      for (const file of files) {
        if (file !== 'creds.json' && file.endsWith('.json')) {
          try {
            keys[file] = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8'));
          } catch {}
        }
      }
      
      const sessionObj = { creds, keys };
      const sessionBase64 = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
      await db.saveSessionData(accountId, sessionBase64);
      lastSaveTime = Date.now();
      logger.info(`[BaileysAuth] Session saved (${Object.keys(keys).length + 1} files)`);
    } catch (err) {
      logger.warn(`[BaileysAuth] Could not save session to DB: ${err.message}`);
    }
  };

  // Wrap saveCreds to also persist to database
  const saveCredsAndDB = async () => {
    await saveCreds();
    await saveAllToDatabase();
  };

  return { state, saveCreds: saveCredsAndDB, saveAllToDatabase };
}

class WhatsAppManager {
  constructor() {
    this.clients = new Map();       // accountId -> socket
    this.qrCodes = new Map();       // accountId -> qr data URL
    this.accountStatus = new Map(); // accountId -> status string
    this.reconnecting = new Set();
    this.qrAttempts = new Map();
    this.isShuttingDown = false;
    this.io = null;
    this.authStates = new Map();    // accountId -> { state, saveCreds }

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
      // Close WebSocket connection
      client.end(undefined);
      logger.info(`Client disposed for ${accountId}`);
    } catch (error) {
      logger.warn(`Error disposing client ${accountId}:`, error.message);
    } finally {
      this.clients.delete(accountId);
      this.qrCodes.delete(accountId);
      this.authStates.delete(accountId);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
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
        metadata: { created_by: 'system', version: '4.0', auth: 'baileys' }
      };

      const account = await db.createAccount(accountData);

      // Start connection
      await this.startBaileysClient(accountId);

      logger.info(`Account created: ${accountId} (${accountName})`);
      return account;
    } catch (error) {
      logger.error('Error creating account:', error);
      this.accountStatus.set(accountId, 'error');
      throw error;
    }
  }

  async startBaileysClient(accountId) {
    try {
      // Get or create auth state
      const { state, saveCreds, saveAllToDatabase } = await useDBAuthState(accountId);
      this.authStates.set(accountId, { state, saveCreds, saveAllToDatabase });

      const { version } = await fetchLatestBaileysVersion();
      logger.info(`Using Baileys version: ${version.join('.')}`);

      // Store for message retry (fixes "Waiting for this message" issue)
      const messageRetryMap = new Map();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Manager', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        // Message retry configuration - fixes encryption issues
        retryRequestDelayMs: 250,
        getMessage: async (key) => {
          // Return cached message for retry
          if (messageRetryMap.has(key.id)) {
            return messageRetryMap.get(key.id);
          }
          return { conversation: '' };
        },
        msgRetryCounterCache: messageRetryMap
      });

      // Store messageRetryMap with the client for later use
      sock.messageRetryMap = messageRetryMap;

      this.clients.set(accountId, sock);
      this.accountStatus.set(accountId, 'initializing');

      // Setup event handlers
      this.setupBaileysEventHandlers(sock, accountId, saveCreds);

      return sock;
    } catch (error) {
      logger.error(`Error starting Baileys client for ${accountId}:`, error);
      this.accountStatus.set(accountId, 'error');
      throw error;
    }
  }

  setupBaileysEventHandlers(sock, accountId, saveCreds) {
    // Connection update (QR code, connection state)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code received
      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          this.qrCodes.set(accountId, qrDataUrl);

          await db.updateAccount(accountId, {
            status: 'qr_ready',
            qr_code: qrDataUrl,
            updated_at: new Date().toISOString()
          });

          this.accountStatus.set(accountId, 'qr_ready');
          this.emitToAll('qr', { accountId, qr: qrDataUrl });

          logger.info(`QR generated for ${accountId}`);
        } catch (error) {
          logger.error(`QR error for ${accountId}:`, error);
        }
      }

      // Connection opened
      if (connection === 'open') {
        const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || 'unknown';

        await db.updateAccount(accountId, {
          status: 'ready',
          phone_number: phoneNumber,
          last_active_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        this.accountStatus.set(accountId, 'ready');
        this.qrCodes.delete(accountId);
        this.reconnecting.delete(accountId);

        // CRITICAL: Save ALL session files after connection is established
        // This ensures Signal protocol keys are saved before any messages are sent
        const authState = this.authStates.get(accountId);
        if (authState?.saveAllToDatabase) {
          try {
            await authState.saveAllToDatabase();
            logger.info(`Session saved after connection open for ${accountId}`);
          } catch (e) {
            logger.error(`Failed to save session on connect: ${e.message}`);
          }
        }

        this.emitToAll('ready', { accountId, phoneNumber });
        logger.info(`✅ WhatsApp ready for ${accountId} (${phoneNumber})`);
      }

      // Connection closed
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || lastDisconnect?.error?.message || 'unknown';

        logger.warn(`Disconnected ${accountId}: ${reason} (code: ${statusCode})`);

        // Handle different disconnect reasons
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          // User logged out - clear session
          await db.clearSessionData(accountId);
          await db.updateAccount(accountId, {
            status: 'logged_out',
            error_message: 'Logged out from another device',
            updated_at: new Date().toISOString()
          });
          this.accountStatus.set(accountId, 'logged_out');
          this.clients.delete(accountId);
        } else if (shouldReconnect && !this.isShuttingDown) {
          // Try to reconnect
          this.accountStatus.set(accountId, 'reconnecting');
          
          setTimeout(async () => {
            if (!this.isShuttingDown && !this.reconnecting.has(accountId)) {
              logger.info(`Attempting reconnect for ${accountId}...`);
              try {
                await this.startBaileysClient(accountId);
              } catch (err) {
                logger.error(`Reconnect failed for ${accountId}:`, err.message);
                this.accountStatus.set(accountId, 'disconnected');
              }
            }
          }, 3000);
        } else {
          await db.updateAccount(accountId, {
            status: 'disconnected',
            error_message: reason,
            updated_at: new Date().toISOString()
          });
          this.accountStatus.set(accountId, 'disconnected');
        }

        this.emitToAll('disconnected', { accountId, reason });
      }
    });

    // Credentials updated - save to database (debounced)
    sock.ev.on('creds.update', saveCreds);

    // History sync - triggers debounced save (creates many Signal keys)
    sock.ev.on('messaging-history.set', async () => {
      const authState = this.authStates.get(accountId);
      if (authState?.saveAllToDatabase) {
        authState.saveAllToDatabase().catch(() => {});
      }
    });

    // Incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          await this.handleIncomingMessage(sock, accountId, message);
        } catch (error) {
          logger.error(`Message handler error for ${accountId}:`, error);
        }
      }
    });

    // Message status updates (sent, delivered, read)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          if (update.update?.status) {
            const statusNames = { 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read' };
            const statusName = statusNames[update.update.status] || 'unknown';

            if (update.update.status >= 3) {
              const msgData = {
                event: 'message_ack',
                account_id: accountId,
                message_id: update.key.id,
                recipient: update.key.remoteJid,
                ack: update.update.status,
                ack_name: statusName,
                timestamp: Date.now(),
                created_at: new Date().toISOString()
              };

              await this.queueWebhookDeliveries(accountId, msgData);
              logger.info(`📬 Message ${statusName}: ${update.key.id?.slice(0, 20)}...`);
            }
          }
        } catch (error) {
          logger.warn('Message update handler error:', error.message);
        }
      }
    });
  }

  async handleIncomingMessage(sock, accountId, message) {
    // Ignore status broadcasts and own messages
    if (message.key.remoteJid === 'status@broadcast') return;
    if (message.key.fromMe) return;

    try {
      const messageContent = message.message;
      if (!messageContent) return;

      // Extract message text
      let messageText = '';
      if (messageContent.conversation) {
        messageText = messageContent.conversation;
      } else if (messageContent.extendedTextMessage?.text) {
        messageText = messageContent.extendedTextMessage.text;
      } else if (messageContent.imageMessage?.caption) {
        messageText = messageContent.imageMessage.caption;
      } else if (messageContent.videoMessage?.caption) {
        messageText = messageContent.videoMessage.caption;
      }

      // Log incoming message
      const sender = message.key.participant || message.key.remoteJid;
      logger.info(`📩 Incoming message from ${sender.split('@')[0]}: "${messageText?.slice(0, 50) || '[media]'}"`);

      // Determine message type
      let messageType = 'text';
      if (messageContent.imageMessage) messageType = 'image';
      else if (messageContent.videoMessage) messageType = 'video';
      else if (messageContent.audioMessage) messageType = 'audio';
      else if (messageContent.documentMessage) messageType = 'document';
      else if (messageContent.stickerMessage) messageType = 'sticker';
      else if (messageContent.contactMessage) messageType = 'contact';
      else if (messageContent.locationMessage) messageType = 'location';

      const isGroup = message.key.remoteJid.endsWith('@g.us');

      const messageData = {
        event: 'message',  // Event type for webhook filtering
        account_id: accountId,
        direction: 'incoming',
        message_id: message.key.id,
        sender: sender,
        recipient: message.key.remoteJid,
        message: messageText,
        timestamp: message.messageTimestamp,
        type: messageType,
        chat_id: message.key.remoteJid,
        is_group: isGroup,
        group_name: null,
        status: 'success',
        created_at: new Date().toISOString()
      };

      // Update last active
      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      // Queue webhook deliveries
      this.queueWebhookDeliveries(accountId, messageData).catch(err => {
        logger.error(`Webhook queue error:`, err);
      });

      // Process through chatbot (if enabled for this account)
      if (messageText && !isGroup) {
        try {
          logger.info(`[Chatbot] Processing message for account ${accountId}...`);
          const aiResponse = await chatbotManager.processMessage(accountId, {
            body: messageText,
            from: sender,
            getChat: async () => ({})
          }, sender);

          if (aiResponse) {
            logger.info(`[Chatbot] AI generated response: "${aiResponse.slice(0, 100)}..."`);
            
            // Use the original sender JID directly (preserves exact format)
            // For direct messages: use remoteJid, for groups: use participant
            const replyJid = isGroup ? sender : message.key.remoteJid;
            
            try {
              // Reduce typing delay for faster response (500ms instead of 1500ms default)
              const originalTypingDelay = process.env.TYPING_DELAY_MS;
              process.env.TYPING_DELAY_MS = '500';
              
              logger.info(`[Chatbot] Sending response to JID: ${replyJid}...`);
              
              // Send directly using sock.sendMessage with the exact JID
              const sock = this.clients.get(accountId);
              if (sock) {
                // Show typing
                try {
                  await sock.presenceSubscribe(replyJid);
                  await sock.sendPresenceUpdate('composing', replyJid);
                  await new Promise(resolve => setTimeout(resolve, 500));
                  await sock.sendPresenceUpdate('paused', replyJid);
                } catch {}
                
                const result = await sock.sendMessage(replyJid, { text: aiResponse });
                logger.info(`[Chatbot] ✅ Response sent to ${replyJid.split('@')[0]} (msgId: ${result?.key?.id?.slice(0, 10)}...)`);
              }
              
              // Restore original typing delay
              if (originalTypingDelay !== undefined) {
                process.env.TYPING_DELAY_MS = originalTypingDelay;
              } else {
                delete process.env.TYPING_DELAY_MS;
              }
            } catch (sendError) {
              logger.error(`[Chatbot] ❌ Failed to send response: ${sendError.message}`);
            }
          }
        } catch (chatbotError) {
          logger.error(`[Chatbot] Error processing message:`, chatbotError);
        }
      }

      this.metrics.messagesProcessed++;
      // Note: Session keys are saved via creds.update event when they change
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

    return cleaned + '@s.whatsapp.net';
  }

  async sendMessage(accountId, number, message, options = {}) {
    const sock = this.clients.get(accountId);
    if (!sock) throw new Error('Client not found');

    const status = this.accountStatus.get(accountId);
    if (status !== 'ready') throw new Error(`Client not ready: ${status}`);

    const jid = this.formatPhoneNumber(number);

    try {
      // Show typing indicator
      const typingDelay = parseInt(process.env.TYPING_DELAY_MS) || 1500;
      if (typingDelay > 0) {
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate('composing', jid);
          await new Promise(resolve => setTimeout(resolve, typingDelay));
          await sock.sendPresenceUpdate('paused', jid);
        } catch (e) { /* ignore presence errors */ }
      }

      // Create message content
      const msgContent = { text: message };
      
      const result = await sock.sendMessage(jid, msgContent);

      // Cache message for retry (fixes "Waiting for this message" issue)
      if (sock.messageRetryMap && result?.key?.id) {
        sock.messageRetryMap.set(result.key.id, msgContent);
        // Clean up old entries after 5 minutes
        setTimeout(() => sock.messageRetryMap?.delete(result.key.id), 5 * 60 * 1000);
      }
      // Note: Session keys are saved via creds.update event when they change

      await db.updateAccount(accountId, {
        last_active_at: new Date().toISOString()
      });

      this.metrics.messagesProcessed++;

      return {
        success: true,
        messageId: result.key.id,
        timestamp: Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      this.metrics.messagesFailed++;
      throw error;
    }
  }

  async sendMedia(accountId, number, media, caption = '', options = {}) {
    const sock = this.clients.get(accountId);
    if (!sock) throw new Error('Client not found');

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

    const jid = this.formatPhoneNumber(number);
    const buffer = Buffer.from(base64Data, 'base64');

    // Show typing indicator
    const typingDelay = parseInt(process.env.TYPING_DELAY_MS) || 1500;
    if (typingDelay > 0) {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise(resolve => setTimeout(resolve, typingDelay));
      await sock.sendPresenceUpdate('paused', jid);
    }

    // Determine message type based on mimetype
    let messageContent;
    if (mimetype.startsWith('image/')) {
      messageContent = { image: buffer, caption, mimetype };
    } else if (mimetype.startsWith('video/')) {
      messageContent = { video: buffer, caption, mimetype };
    } else if (mimetype.startsWith('audio/')) {
      messageContent = { audio: buffer, mimetype, ptt: mimetype.includes('ogg') };
    } else {
      messageContent = { document: buffer, mimetype, fileName: filename || 'file' };
    }

    const result = await sock.sendMessage(jid, messageContent);

    this.metrics.messagesProcessed++;

    return {
      success: true,
      messageId: result.key?.id,
      timestamp: Math.floor(Date.now() / 1000)
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

  async ensureQRCode(accountId) {
    const hasQR = this.qrCodes.has(accountId);
    if (hasQR) return { status: this.accountStatus.get(accountId) || 'qr_ready' };

    const account = await db.getAccount(accountId);
    if (!account) throw new Error('Account not found');

    if (this.reconnecting.has(accountId)) {
      return { status: 'reconnecting' };
    }

    return this.reconnectAccount(account, {
      forceReconnect: true,
      reason: 'qr_ensure'
    });
  }

  async deleteAccount(accountId) {
    try {
      await this.safeDisposeClient(accountId);

      this.qrCodes.delete(accountId);
      this.accountStatus.delete(accountId);
      this.reconnecting.delete(accountId);

      // Clear session files
      const sessionPath = path.join('./wa-sessions-temp', accountId);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }

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

          // Wait 3 seconds between each to reduce load
          await new Promise(resolve => setTimeout(resolve, 3000));
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

    try {
      await db.updateAccount(account.id, {
        status: 'initializing',
        error_message: null,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      this.qrCodes.delete(account.id);

      await this.startBaileysClient(account.id);

      // Remove from reconnecting set after a delay
      setTimeout(() => {
        this.reconnecting.delete(account.id);
      }, 5000);

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

    for (const [accountId, sock] of this.clients.entries()) {
      try {
        // Force save session before closing (bypass debounce)
        const authState = this.authStates.get(accountId);
        if (authState?.saveAllToDatabase) {
          logger.info(`Saving session for ${accountId}...`);
          await authState.saveAllToDatabase(true).catch(() => {});
        }

        sock.end(undefined);
        logger.info(`Closed ${accountId}`);
      } catch (error) {
        logger.error(`Shutdown error for ${accountId}:`, error.message);
      }
    }

    this.clients.clear();
    this.accountStatus.clear();
    this.qrCodes.clear();
    this.reconnecting.clear();
    this.authStates.clear();

    logger.info('WhatsAppManager shutdown complete');
  }
}

module.exports = new WhatsAppManager();
