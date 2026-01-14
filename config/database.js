const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Missing Supabase configuration. Please check your .env file.');
  process.exit(1);
}

// Create optimized Supabase client with enhanced configuration
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false
  },
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'x-application-name': 'wa-multi-automation-v2'
    }
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// Enhanced in-memory cache with TTL and size limits
class CacheManager {
  constructor(maxSize = 1000, defaultTTL = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.stats = { hits: 0, misses: 0 };
  }

  set(key, value, ttl = this.defaultTTL) {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl
    });
  }

  get(key) {
    const item = this.cache.get(key);

    if (!item) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return item.value;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  invalidatePattern(pattern) {
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
}

const cacheManager = new CacheManager(
  parseInt(process.env.QUERY_CACHE_SIZE) || 1000,
  parseInt(process.env.CACHE_TTL) || 300000  // 5 minutes default cache
);

// Message queue for batch processing
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.batchSize = parseInt(process.env.WA_MESSAGE_BATCH_SIZE) || 10;
    this.interval = parseInt(process.env.WA_MESSAGE_BATCH_INTERVAL) || 5000;
    this.lastFlush = Date.now();

    // Auto-flush at intervals
    setInterval(() => this.flush(), this.interval);
  }

  add(message) {
    this.queue.push({
      ...message,
      queued_at: Date.now()
    });

    // Auto-flush if batch size reached
    if (this.queue.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);
    this.lastFlush = Date.now();

    // Valid columns in message_logs table
    const validColumns = ['account_id', 'webhook_id', 'direction', 'message_id', 'sender', 
      'recipient', 'message', 'media', 'timestamp', 'type', 'chat_id', 'is_group', 
      'group_name', 'status', 'error_message', 'created_at'];
    
    // Sanitize batch: only keep valid columns
    const sanitizedBatch = batch.map(m => {
      const clean = {};
      for (const col of validColumns) {
        if (m[col] !== undefined) clean[col] = m[col];
      }
      return clean;
    });

    try {
      let { error } = await supabase
        .from('message_logs')
        .insert(sanitizedBatch);

      // Handle unknown column errors gracefully (shouldn't happen with whitelist, but just in case)
      if (error && error.code === 'PGRST204') {
        logger.warn(`Unknown column error (schema mismatch): ${error.message}`);
        // Already sanitized, so just log the error
      }

      if (error) {
        logger.error('Error flushing message queue:', error);
        // Re-queue failed messages
        this.queue.unshift(...batch);
      } else {
        logger.info(`Successfully flushed ${batch.length} messages to database`);
      }
    } catch (error) {
      logger.error('Exception in message queue flush:', error);
      this.queue.unshift(...batch);
    } finally {
      this.processing = false;
    }
  }

  getQueueSize() {
    return this.queue.length;
  }
}

const messageQueue = new MessageQueue();

/**
 * Retry helper for database operations with exponential backoff
 * Handles temporary Supabase 5xx errors gracefully
 */
async function withRetry(fn, operationName, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if it's a retryable error (5xx, network issues)
      const isRetryable =
        error?.code === 'PGRST500' ||
        error?.code === 'PGRST520' ||
        error?.message?.includes('520') ||
        error?.message?.includes('502') ||
        error?.message?.includes('503') ||
        error?.message?.includes('504') ||
        error?.message?.includes('fetch failed') ||
        error?.message?.includes('network') ||
        error?.message?.includes('ECONNRESET') ||
        error?.message?.includes('ETIMEDOUT');

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      const delay = 1000 * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
      logger.warn(`[DB Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// Database helper functions with improved error handling
class MissingWebhookQueueTableError extends Error {
  constructor(message) {
    super(message || 'webhook_delivery_queue table not found');
    this.name = 'MissingWebhookQueueTableError';
  }
}

function isWebhookQueueMissingError(error) {
  return error?.code === 'PGRST205' && /webhook_delivery_queue/i.test(error?.message || '');
}

const db = {
  // Account management
  async createAccount(accountData) {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .insert([accountData])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate accounts cache
      cacheManager.invalidatePattern('^accounts');

      logger.info(`Account created: ${accountData.id}`);
      return data[0];
    } catch (error) {
      logger.error('Error creating account:', error);
      throw error;
    }
  },

  async getAccounts() {
    const cacheKey = 'accounts_all';
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    return withRetry(async () => {
      // Explicitly select columns WITHOUT session_data (which is huge - 1-5MB each)
      const { data, error } = await supabase
        .from('accounts')
        .select('id, name, description, phone_number, status, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      const accounts = data || [];
      cacheManager.set(cacheKey, accounts);

      return accounts;
    }, 'getAccounts');
  },

  async getAccount(id) {
    const cacheKey = `account_${id}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Exclude session_data to avoid huge payloads
      const { data, error } = await supabase
        .from('accounts')
        .select('id, name, description, phone_number, status, created_at, updated_at')
        .eq('id', id)
        .single();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      cacheManager.set(cacheKey, data);
      return data;
    } catch (error) {
      logger.error(`Error fetching account ${id}:`, error);
      throw error;
    }
  },

  async updateAccount(id, updates) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('accounts')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate related caches
      cacheManager.invalidate(`account_${id}`);
      cacheManager.invalidatePattern('^accounts');

      logger.debug(`Account updated: ${id}`);
      return data[0];
    }, `updateAccount(${id})`);
  },

  async deleteAccount(id) {
    try {
      const { error } = await supabase
        .from('accounts')
        .delete()
        .eq('id', id);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      // Invalidate related caches
      cacheManager.invalidate(`account_${id}`);
      cacheManager.invalidatePattern('^accounts');
      cacheManager.invalidatePattern(`^webhooks_${id}`);
      cacheManager.invalidatePattern(`^messages_${id}`);

      logger.info(`Account deleted: ${id}`);
      return true;
    } catch (error) {
      logger.error(`Error deleting account ${id}:`, error);
      throw error;
    }
  },

  // Session Management
  async getSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('session_data')
        .eq('id', accountId)
        .single();

      if (error) return null;
      return data?.session_data || null;
    } catch (error) {
      logger.error(`Error fetching session data for ${accountId}:`, error);
      return null;
    }
  },

  async saveSessionData(accountId, sessionData) {
    try {
      const { error } = await supabase
        .from('accounts')
        .update({
          session_data: sessionData,
          last_session_saved: new Date().toISOString()
        })
        .eq('id', accountId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error(`Error saving session data for ${accountId}:`, error);
      throw error;
    }
  },

  async clearSessionData(accountId) {
    try {
      const { error } = await supabase
        .from('accounts')
        .update({
          session_data: null,
          last_session_saved: null
        })
        .eq('id', accountId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error(`Error clearing session data for ${accountId}:`, error);
      throw error;
    }
  },

  // Webhook management
  async createWebhook(webhookData) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .insert([webhookData])
        .select();

      if (error) throw error;

      // Invalidate webhooks cache for this account
      cacheManager.invalidate(`webhooks_${webhookData.account_id}`);

      logger.info(`Webhook created: ${webhookData.id} for account ${webhookData.account_id}`);
      return data[0];
    } catch (error) {
      logger.error('Error creating webhook:', error);
      throw error;
    }
  },

  // Get all webhooks (for dashboard indicators)
  async getAllWebhooks() {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('id, account_id, is_active');

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching all webhooks:', error);
      return [];
    }
  },

  async getWebhooks(accountId) {
    const cacheKey = `webhooks_${accountId}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const webhooks = data || [];
      cacheManager.set(cacheKey, webhooks);

      return webhooks;
    } catch (error) {
      logger.error(`Error fetching webhooks for account ${accountId}:`, error);
      throw error;
    }
  },

  async getWebhook(id) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error(`Error fetching webhook ${id}:`, error);
      throw error;
    }
  },

  async updateWebhook(id, updates) {
    try {
      const { data, error } = await supabase
        .from('webhooks')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) throw error;

      // Invalidate cache
      if (data && data[0]) {
        cacheManager.invalidate(`webhooks_${data[0].account_id}`);
      }

      logger.debug(`Webhook updated: ${id}`);
      return data[0];
    } catch (error) {
      logger.error(`Error updating webhook ${id}:`, error);
      throw error;
    }
  },

  async deleteWebhook(id) {
    try {
      // Get webhook info before deleting
      let webhookAccountId = null;
      try {
        const { data: existing } = await supabase
          .from('webhooks')
          .select('id, account_id')
          .eq('id', id)
          .single();
        webhookAccountId = existing?.account_id || null;
      } catch (_) { }

      // Try to delete
      let { error } = await supabase
        .from('webhooks')
        .delete()
        .eq('id', id);

      // Handle foreign key constraint
      if (error && error.code === '23503') {
        logger.warn(`Webhook delete blocked by FK, nullifying references: ${id}`);
        const nullify = await supabase
          .from('message_logs')
          .update({ webhook_id: null })
          .eq('webhook_id', id);

        if (nullify.error) {
          logger.error('Failed to nullify message_logs.webhook_id:', nullify.error);
          throw error;
        }

        // Retry delete
        const retry = await supabase
          .from('webhooks')
          .delete()
          .eq('id', id);
        error = retry.error;
      }

      if (error) throw error;

      // Invalidate cache
      if (webhookAccountId) {
        cacheManager.invalidate(`webhooks_${webhookAccountId}`);
      }

      logger.info(`Webhook deleted: ${id}`);
      return true;
    } catch (error) {
      logger.error(`Error deleting webhook ${id}:`, error);
      throw error;
    }
  },

  // Message logging with queue - Can be disabled via DISABLE_MESSAGE_LOGGING=true
  async logMessage(messageData) {
    // Skip logging if disabled to save Supabase egress
    if (process.env.DISABLE_MESSAGE_LOGGING === 'true') {
      return messageData;
    }
    messageQueue.add(messageData);
    return messageData;
  },

  // Immediate message logging (bypass queue for critical messages)
  async logMessageImmediate(messageData) {
    // Skip logging if disabled to save Supabase egress
    if (process.env.DISABLE_MESSAGE_LOGGING === 'true') {
      return messageData;
    }
    try {
      const { data, error } = await supabase
        .from('message_logs')
        .insert([messageData])
        .select();

      if (error) throw error;

      // Invalidate message cache for this account
      cacheManager.invalidatePattern(`^messages_${messageData.account_id}`);

      return data[0];
    } catch (error) {
      logger.error('Error logging message immediately:', error);
      throw error;
    }
  },

  async getMessageLogs(accountId, limit = 100) {
    const cacheKey = `messages_${accountId}_${limit}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('message_logs')
        .select('*')
        .eq('account_id', accountId)
        .neq('sender', 'status@broadcast')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      const messages = data || [];
      cacheManager.set(cacheKey, messages, 30000); // 30 second cache for messages

      return messages;
    } catch (error) {
      logger.error(`Error fetching message logs for account ${accountId}:`, error);
      throw error;
    }
  },

  async getAllMessageLogs(limit = 100, offset = 0) {
    const cacheKey = `all_messages_${limit}_${offset}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('message_logs')
        .select('*')
        .neq('sender', 'status@broadcast')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      const messages = data || [];
      cacheManager.set(cacheKey, messages, 30000); // 30 second cache

      return messages;
    } catch (error) {
      logger.error('Error fetching all message logs:', error);
      throw error;
    }
  },

  async getMessageStats(accountId) {
    const cacheKey = `stats_${accountId}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Run parallel count queries to minimize egress (fetching only counts, not data)
      const [total, incoming, outgoing, success, failed, outgoing_success] = await Promise.all([
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).neq('sender', 'status@broadcast'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('direction', 'incoming').neq('sender', 'status@broadcast'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('direction', 'outgoing').neq('sender', 'status@broadcast'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'success').neq('sender', 'status@broadcast'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'failed').neq('sender', 'status@broadcast'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('direction', 'outgoing').eq('status', 'success').neq('sender', 'status@broadcast')
      ]);

      const stats = {
        total: total.count || 0,
        incoming: incoming.count || 0,
        outgoing: outgoing.count || 0,
        success: success.count || 0,
        failed: failed.count || 0,
        outgoing_success: outgoing_success.count || 0
      };

      cacheManager.set(cacheKey, stats, 5 * 60 * 1000); // 5 minute cache for stats

      return stats;
    } catch (error) {
      logger.error(`Error fetching message stats for account ${accountId}:`, error);
      return { total: 0, incoming: 0, outgoing: 0, success: 0, failed: 0, outgoing_success: 0 };
    }
  },

  // Fetch conversation history for a specific contact (with caching)
  async getConversationHistory(accountId, contactId, limit = 5) {
    // Use in-memory cache to reduce DB queries
    const cacheKey = `conv_${accountId}_${contactId}_${limit}`;
    const cached = cacheManager.get(cacheKey);
    
    if (cached) {
      return cached;
    }
    
    // If message logging is disabled, return empty history
    if (process.env.DISABLE_MESSAGE_LOGGING === 'true') {
      return [];
    }
    
    try {
      // Use contactId as-is - it should already be the full JID (e.g., 123@s.whatsapp.net or 123@lid)
      // Query using chat_id which is consistently the full JID
      const { data, error } = await supabase
        .from('message_logs')
        .select('direction, message, created_at')
        .eq('account_id', accountId)
        .eq('chat_id', contactId)
        .order('created_at', { ascending: false })
        .limit(limit);
      
      logger.debug(`[DB] getConversationHistory for ${contactId}: found ${data?.length || 0} messages`);

      if (error) throw error;

      // Return in chronological order (oldest first)
      const history = (data || []).reverse();
      
      // Cache for 5 seconds (short to ensure fresh data during conversation)
      cacheManager.set(cacheKey, history, 5000);
      
      return history;
    } catch (error) {
      logger.error(`Error fetching conversation history for ${accountId}/${contactId}:`, error);
      return [];
    }
  },

  // Flush pending messages
  async flushMessageQueue() {
    return await messageQueue.flush();
  },

  // Get queue status
  getQueueStatus() {
    return {
      queueSize: messageQueue.getQueueSize(),
      processing: messageQueue.processing,
      lastFlush: messageQueue.lastFlush
    };
  },

  // Get cache stats
  getCacheStats() {
    return cacheManager.getStats();
  },

  // Clear cache
  clearCache() {
    cacheManager.clear();
    logger.info('Cache cleared');
  },

  // ============================================================================
  // AI Auto Reply Configuration (per account)
  // ============================================================================

  // Get all AI configs (for dashboard indicators)
  async getAllAiConfigs() {
    try {
      const { data, error } = await supabase
        .from('ai_auto_replies')
        .select('account_id, is_active, provider');

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching all AI configs:', error);
      return [];
    }
  },

  async getAiConfig(accountId) {
    try {
      // Try cache first
      const cacheKey = `ai_config_${accountId}`;
      const cached = cacheManager.get(cacheKey);
      if (cached) return cached;

      const { data, error } = await supabase
        .from('ai_auto_replies')
        .select('*')
        .eq('account_id', accountId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null; // no config yet
        }
        throw error;
      }

      // Cache the result (5 minutes)
      if (data) {
        cacheManager.set(cacheKey, data, 300000);
      }

      return data;
    } catch (error) {
      logger.error(`Error fetching AI config for ${accountId}:`, error);
      return null;
    }
  },

  // Backwards-compatible alias used by older chatbot manager code
  async getChatbotConfig(accountId) {
    return await this.getAiConfig(accountId);
  },

  async saveAiConfig(config) {
    try {
      const { data, error } = await supabase
        .from('ai_auto_replies')
        .upsert(config, { onConflict: 'account_id' })
        .select();

      if (error) throw error;

      // Invalidate cache
      if (config.account_id) {
        cacheManager.invalidate(`ai_config_${config.account_id}`);
      }

      return data?.[0] || null;
    } catch (error) {
      logger.error('Error saving AI config:', error);
      throw error;
    }
  },

  async deleteAiConfig(accountId) {
    try {
      const { error } = await supabase
        .from('ai_auto_replies')
        .delete()
        .eq('account_id', accountId);

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`ai_config_${accountId}`);

      return true;
    } catch (error) {
      logger.error(`Error deleting AI config for ${accountId}:`, error);
      throw error;
    }
  },

  // ============================================================================
  // Session Management (for persistent WhatsApp authentication)
  // ============================================================================

  /**
   * Save WhatsApp session data to database
   * @param {string} accountId - Account UUID
   * @param {string} sessionData - Base64 encoded session data
   */
  async saveSessionData(accountId, sessionData) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('accounts')
        .update({
          session_data: sessionData,
          last_session_saved: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', accountId)
        .select();

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`account_${accountId}`);
      cacheManager.invalidatePattern('^accounts');

      return data[0];
    }, `saveSessionData(${accountId})`);
  },

  /**
   * Get WhatsApp session data from database
   * @param {string} accountId - Account UUID
   * @returns {string|null} Base64 encoded session data or null
   */
  async getSessionData(accountId) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('session_data')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      return data?.session_data || null;
    }, `getSessionData(${accountId})`).catch(error => {
      logger.error(`Error fetching session data for ${accountId}:`, error);
      return null;
    });
  },

  /**
   * Clear WhatsApp session data from database (logout)
   * @param {string} accountId - Account UUID
   */
  async clearSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .update({
          session_data: null,
          last_session_saved: null,
          status: 'disconnected',
          updated_at: new Date().toISOString()
        })
        .eq('id', accountId)
        .select();

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`account_${accountId}`);
      cacheManager.invalidatePattern('^accounts');

      logger.info(`Session data cleared for account: ${accountId}`);
      return data[0];
    } catch (error) {
      logger.error(`Error clearing session data for ${accountId}:`, error);
      throw error;
    }
  },

  /**
   * Check if account has saved session
   * @param {string} accountId - Account UUID
   * @returns {boolean}
   */
  async hasSessionData(accountId) {
    return withRetry(async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('session_data, last_session_saved')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      const hasData = !!(data?.session_data);
      const sessionSize = data?.session_data ? data.session_data.length : 0;
      
      logger.debug(`hasSessionData(${accountId}): hasData=${hasData}, size=${sessionSize}, lastSaved=${data?.last_session_saved}`);
      
      return hasData;
    }, `hasSessionData(${accountId})`).catch(error => {
      logger.error(`Error checking session data for ${accountId}:`, error);
      return false;
    });
  },

  // ============================================================================
  // Webhook Delivery Queue (durable retries)
  // ============================================================================

  async enqueueWebhookDelivery({ accountId, webhook, payload, maxRetries }) {
    try {
      const record = {
        account_id: accountId,
        webhook_id: webhook.id,
        webhook_url: webhook.url,
        webhook_secret: webhook.secret || null,
        payload,
        max_retries: maxRetries,
        status: 'pending',
        next_attempt_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .insert([record])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }

      return data?.[0] || null;
    } catch (error) {
      logger.error('Error enqueuing webhook delivery:', error);
      throw error;
    }
  },

  async getDueWebhookDeliveries(limit = 10) {
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .select('*')
        .in('status', ['pending', 'failed'])
        .lte('next_attempt_at', now)
        .order('next_attempt_at', { ascending: true })
        .limit(limit);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return data || [];
    } catch (error) {
      logger.error('Error fetching due webhook deliveries:', error);
      return [];
    }
  },

  async markWebhookDeliveryProcessing(job) {
    try {
      const { data, error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'processing',
          attempt_count: job.attempt_count + 1,
          last_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id)
        .in('status', ['pending', 'failed'])
        .select();

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return data?.[0] || null;
    } catch (error) {
      logger.error(`Error marking webhook delivery ${job.id} processing:`, error);
      return null;
    }
  },

  async completeWebhookDelivery(jobId, responseStatus) {
    try {
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'success',
          response_status: responseStatus,
          last_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return true;
    } catch (error) {
      logger.error(`Error completing webhook delivery ${jobId}:`, error);
      return false;
    }
  },

  async failWebhookDelivery(job, errorMessage, nextAttemptAt, isDeadLetter = false) {
    try {
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: isDeadLetter ? 'dead_letter' : 'failed',
          last_error: errorMessage,
          next_attempt_at: nextAttemptAt,
          updated_at: new Date().toISOString()
        })
        .eq('id', job.id);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
      return true;
    } catch (error) {
      logger.error(`Error failing webhook delivery ${job.id}:`, error);
      return false;
    }
  },

  async resetStuckWebhookDeliveries(minutes = 5) {
    try {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      const { error } = await supabase
        .from('webhook_delivery_queue')
        .update({
          status: 'failed',
          next_attempt_at: new Date().toISOString(),
          last_error: 'Recovered from unexpected shutdown'
        })
        .eq('status', 'processing')
        .lte('updated_at', cutoff);

      if (error) {
        if (isWebhookQueueMissingError(error)) {
          throw new MissingWebhookQueueTableError();
        }
        throw error;
      }
    } catch (error) {
      logger.error('Error resetting stuck webhook deliveries:', error);
      throw error;
    }
  },

  async getWebhookQueueStats() {
    const statuses = ['pending', 'processing', 'failed', 'dead_letter'];
    const stats = {};

    for (const status of statuses) {
      try {
        const { count, error } = await supabase
          .from('webhook_delivery_queue')
          .select('id', { count: 'exact', head: true })
          .eq('status', status);

        if (error) {
          if (isWebhookQueueMissingError(error)) {
            throw new MissingWebhookQueueTableError();
          }
          throw error;
        }
        stats[status] = count || 0;
      } catch (error) {
        if (error instanceof MissingWebhookQueueTableError) {
          throw error;
        }
        logger.error(`Error counting webhook queue status ${status}:`, error);
        stats[status] = 0;
      }
    }

    return stats;
  },

  async getDailyMessageStats(days = 7) {
    const cacheKey = `daily_stats_${days}`;
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Try to use the optimized PostgreSQL function first
      const { data: funcData, error: funcError } = await supabase
        .rpc('get_daily_message_stats', { days_count: days });

      if (!funcError && funcData) {
        // Initialize all days (in case some have no data)
        const dailyStats = {};
        for (let i = 0; i < days; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().split('T')[0];
          dailyStats[dateStr] = { date: dateStr, incoming: 0, outgoing: 0, total: 0 };
        }

        // Merge in the actual data
        funcData.forEach(row => {
          const dateStr = row.date;
          if (dailyStats[dateStr]) {
            dailyStats[dateStr].incoming = parseInt(row.incoming) || 0;
            dailyStats[dateStr].outgoing = parseInt(row.outgoing) || 0;
            dailyStats[dateStr].total = parseInt(row.total) || 0;
          }
        });

        const result = Object.values(dailyStats).sort((a, b) => a.date.localeCompare(b.date));
        cacheManager.set(cacheKey, result, 600000); // Cache for 10 minutes
        return result;
      }

      // Fallback to original method if function doesn't exist
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const { data, error } = await supabase
        .from('message_logs')
        .select('created_at, direction')
        .gte('created_at', startDate.toISOString())
        .neq('sender', 'status@broadcast');

      if (error) throw error;

      // Process data in JS to group by day
      const dailyStats = {};
      // Initialize last 7 days
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        dailyStats[dateStr] = { date: dateStr, incoming: 0, outgoing: 0, total: 0 };
      }

      data.forEach(msg => {
        const dateStr = new Date(msg.created_at).toISOString().split('T')[0];
        if (dailyStats[dateStr]) {
          dailyStats[dateStr].total++;
          if (msg.direction === 'incoming') dailyStats[dateStr].incoming++;
          else dailyStats[dateStr].outgoing++;
        }
      });

      const result = Object.values(dailyStats).sort((a, b) => a.date.localeCompare(b.date));
      cacheManager.set(cacheKey, result, 600000); // Cache for 10 minutes

      return result;
    } catch (error) {
      logger.error('Error fetching daily message stats:', error);
      return [];
    }
  },

  // Get all accounts stats in a single query (avoids N+1 problem)
  async getAllAccountsStats() {
    const cacheKey = 'all_accounts_stats';
    const cached = cacheManager.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Try to use the optimized PostgreSQL function
      const { data, error } = await supabase.rpc('get_all_accounts_stats');

      if (error) {
        // Fallback: the function might not exist yet
        logger.warn('get_all_accounts_stats function not available, using fallback');
        return null;
      }

      // Convert to a map for easy lookup
      const statsMap = {};
      data.forEach(row => {
        statsMap[row.account_id] = {
          total: parseInt(row.total) || 0,
          incoming: parseInt(row.incoming) || 0,
          outgoing: parseInt(row.outgoing) || 0,
          success: parseInt(row.success) || 0,
          failed: parseInt(row.failed) || 0,
          outgoing_success: parseInt(row.outgoing_success) || 0
        };
      });

      cacheManager.set(cacheKey, statsMap, 60000); // Cache for 1 minute
      return statsMap;
    } catch (error) {
      logger.error('Error fetching all accounts stats:', error);
      return null;
    }
  },

  // ============================================================================
  // LEAD CAPTURE WORKFLOWS
  // ============================================================================

  // Get all workflows for an account
  async getWorkflows(accountId) {
    try {
      const { data, error } = await supabase
        .from('lead_workflows')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching workflows:', error);
      return [];
    }
  },

  // Get a single workflow
  async getWorkflow(workflowId) {
    try {
      const { data, error } = await supabase
        .from('lead_workflows')
        .select('*')
        .eq('id', workflowId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error fetching workflow:', error);
      return null;
    }
  },

  // Get active workflow for an account (highest priority active workflow)
  async getActiveWorkflowForAccount(accountId) {
    try {
      const { data, error } = await supabase
        .from('lead_workflows')
        .select('*')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
      return data || null;
    } catch (error) {
      logger.error('Error fetching active workflow:', error);
      return null;
    }
  },

  // Create a new workflow
  async createWorkflow(workflow) {
    try {
      const { data, error } = await supabase
        .from('lead_workflows')
        .insert([workflow])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating workflow:', error);
      throw error;
    }
  },

  // Update a workflow
  async updateWorkflow(workflowId, updates) {
    try {
      const { data, error } = await supabase
        .from('lead_workflows')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', workflowId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating workflow:', error);
      throw error;
    }
  },

  // Delete a workflow
  async deleteWorkflow(workflowId) {
    try {
      const { error } = await supabase
        .from('lead_workflows')
        .delete()
        .eq('id', workflowId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error deleting workflow:', error);
      throw error;
    }
  },

  // ============================================================================
  // LEAD SESSIONS
  // ============================================================================

  // Get active lead session for a contact
  async getLeadSession(accountId, contactId) {
    try {
      const { data, error } = await supabase
        .from('lead_sessions')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data || null;
    } catch (error) {
      logger.error('Error fetching lead session:', error);
      return null;
    }
  },

  // Create a new lead session
  async createLeadSession(session) {
    try {
      const { data, error } = await supabase
        .from('lead_sessions')
        .insert([{
          account_id: session.account_id,
          workflow_id: session.workflow_id,
          contact_id: session.contact_id,
          current_node_id: session.current_node_id,
          collected_data: session.collected_data || {},
          conversation_history: session.conversation_history || [],
          status: session.status || 'active'
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating lead session:', error);
      throw error;
    }
  },

  // Update a lead session
  async updateLeadSession(session) {
    try {
      const updateData = {
        current_node_id: session.current_node_id,
        collected_data: session.collected_data,
        conversation_history: session.conversation_history,
        status: session.status,
        ai_fallback_active: session.ai_fallback_active,
        ai_fallback_context: session.ai_fallback_context,
        completed_at: session.completed_at,
        updated_at: new Date().toISOString()
      };

      // V2 workflow fields
      if (session.awaiting_field !== undefined) {
        updateData.awaiting_field = session.awaiting_field;
      }
      if (session.retry_count !== undefined) {
        updateData.retry_count = session.retry_count;
      }

      const { data, error } = await supabase
        .from('lead_sessions')
        .update(updateData)
        .eq('id', session.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating lead session:', error);
      throw error;
    }
  },

  // Expire a lead session
  async expireLeadSession(sessionId) {
    try {
      const { error } = await supabase
        .from('lead_sessions')
        .update({
          status: 'expired',
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId);

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error expiring lead session:', error);
      return false;
    }
  },

  // Get all sessions for a workflow
  async getWorkflowSessions(workflowId, status = null) {
    try {
      let query = supabase
        .from('lead_sessions')
        .select('*')
        .eq('workflow_id', workflowId);

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching workflow sessions:', error);
      return [];
    }
  },

  // ============================================================================
  // LEAD DATA
  // ============================================================================

  // Save completed lead data
  async saveLeadData(leadData) {
    try {
      const { data, error } = await supabase
        .from('lead_data')
        .insert([leadData])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error saving lead data:', error);
      throw error;
    }
  },

  // Get leads for an account
  async getLeads(accountId, options = {}) {
    try {
      let query = supabase
        .from('lead_data')
        .select(`
          *,
          lead_workflows!inner(name)
        `)
        .eq('account_id', accountId);

      if (options.status) {
        query = query.eq('status', options.status);
      }

      if (options.workflowId) {
        query = query.eq('workflow_id', options.workflowId);
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(options.limit || 100);

      if (error) throw error;

      // Flatten the workflow name
      return (data || []).map(lead => ({
        ...lead,
        workflow_name: lead.lead_workflows?.name || 'Unknown Workflow',
        lead_workflows: undefined
      }));
    } catch (error) {
      logger.error('Error fetching leads:', error);
      return [];
    }
  },

  // Update lead status
  async updateLeadStatus(leadId, status, notes = null) {
    try {
      const updates = {
        status,
        updated_at: new Date().toISOString()
      };
      if (notes) updates.notes = notes;

      const { data, error } = await supabase
        .from('lead_data')
        .update(updates)
        .eq('id', leadId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating lead status:', error);
      throw error;
    }
  },

  // Get lead statistics for an account
  async getLeadStats(accountId) {
    try {
      const { data, error } = await supabase
        .from('lead_data')
        .select('status')
        .eq('account_id', accountId);

      if (error) throw error;

      const stats = {
        total: data.length,
        new: 0,
        contacted: 0,
        qualified: 0,
        converted: 0,
        lost: 0
      };

      data.forEach(lead => {
        if (stats[lead.status] !== undefined) {
          stats[lead.status]++;
        }
      });

      return stats;
    } catch (error) {
      logger.error('Error fetching lead stats:', error);
      return { total: 0, new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 };
    }
  },

  // ============================================================================
  // CHATBOT FLOWS
  // ============================================================================

  // Get all chatbot flows
  async getChatbotFlows(accountId = null) {
    try {
      let query = supabase
        .from('chatbot_flows')
        .select('*')
        .order('created_at', { ascending: false });

      if (accountId) {
        query = query.eq('account_id', accountId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching chatbot flows:', error);
      return [];
    }
  },

  // Get single chatbot flow with nodes and connections
  async getChatbotFlow(flowId) {
    try {
      const { data: flow, error: flowError } = await supabase
        .from('chatbot_flows')
        .select('*')
        .eq('id', flowId)
        .single();

      if (flowError) throw flowError;

      const { data: nodes } = await supabase
        .from('flow_nodes')
        .select('*')
        .eq('flow_id', flowId)
        .order('created_at', { ascending: true });

      const { data: connections } = await supabase
        .from('flow_connections')
        .select('*')
        .eq('flow_id', flowId);

      return {
        ...flow,
        nodes: nodes || [],
        connections: connections || []
      };
    } catch (error) {
      logger.error('Error fetching chatbot flow:', error);
      return null;
    }
  },

  // Create chatbot flow
  async createChatbotFlow(flowData) {
    try {
      const { data, error } = await supabase
        .from('chatbot_flows')
        .insert([{
          account_id: flowData.account_id,
          name: flowData.name,
          description: flowData.description || '',
          trigger_type: flowData.trigger_type || 'keyword',
          trigger_keywords: flowData.trigger_keywords || [],
          is_active: flowData.is_active !== false,
          // AI LLM Configuration
          llm_provider: flowData.llm_provider || null,
          llm_api_key: flowData.llm_api_key || null,
          llm_model: flowData.llm_model || null,
          llm_instructions: flowData.llm_instructions || '',
          // Webhook Configuration
          webhook_url: flowData.webhook_url || null,
          webhook_headers: flowData.webhook_headers || {},
          // Flow type: 'basic' (traditional) or 'ai' (AI-powered data extraction)
          flow_type: flowData.flow_type || 'basic',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating chatbot flow:', error);
      throw error;
    }
  },

  // Update chatbot flow
  async updateChatbotFlow(flowId, updates) {
    try {
      const { data, error } = await supabase
        .from('chatbot_flows')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', flowId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating chatbot flow:', error);
      throw error;
    }
  },

  // Delete chatbot flow (cascade deletes nodes and connections)
  async deleteChatbotFlow(flowId) {
    try {
      // Delete connections first
      await supabase.from('flow_connections').delete().eq('flow_id', flowId);
      // Delete nodes
      await supabase.from('flow_nodes').delete().eq('flow_id', flowId);
      // Delete flow
      const { error } = await supabase.from('chatbot_flows').delete().eq('id', flowId);
      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error deleting chatbot flow:', error);
      throw error;
    }
  },

  // Create flow node
  async createFlowNode(nodeData) {
    try {
      const { data, error } = await supabase
        .from('flow_nodes')
        .insert([{
          flow_id: nodeData.flow_id,
          node_type: nodeData.node_type,
          name: nodeData.name || nodeData.node_type,
          position_x: nodeData.position_x || 0,
          position_y: nodeData.position_y || 0,
          config: nodeData.config || {},
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating flow node:', error);
      throw error;
    }
  },

  // Update flow node
  async updateFlowNode(nodeId, updates) {
    try {
      const { data, error } = await supabase
        .from('flow_nodes')
        .update(updates)
        .eq('id', nodeId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating flow node:', error);
      throw error;
    }
  },

  // Delete flow node
  async deleteFlowNode(nodeId) {
    try {
      // Delete related connections
      await supabase.from('flow_connections').delete().or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);
      const { error } = await supabase.from('flow_nodes').delete().eq('id', nodeId);
      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error deleting flow node:', error);
      throw error;
    }
  },

  // Create flow connection
  async createFlowConnection(connectionData) {
    try {
      const { data, error } = await supabase
        .from('flow_connections')
        .insert([{
          flow_id: connectionData.flow_id,
          source_node_id: connectionData.source_node_id,
          target_node_id: connectionData.target_node_id,
          source_handle: connectionData.source_handle || 'default',
          condition: connectionData.condition || null
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating flow connection:', error);
      throw error;
    }
  },

  // Delete flow connection
  async deleteFlowConnection(connectionId) {
    try {
      const { error } = await supabase.from('flow_connections').delete().eq('id', connectionId);
      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error deleting flow connection:', error);
      throw error;
    }
  },

  // Save entire flow (nodes + connections)
  async saveFlowDesign(flowId, nodes, connections) {
    try {
      const { v4: uuidv4 } = require('uuid');

      // Delete existing nodes and connections
      await supabase.from('flow_connections').delete().eq('flow_id', flowId);
      await supabase.from('flow_nodes').delete().eq('flow_id', flowId);

      // Create a mapping from frontend IDs to new UUIDs
      const idMapping = {};

      // Insert new nodes with proper UUIDs
      if (nodes.length > 0) {
        const nodesWithFlowId = nodes.map(n => {
          // Generate a new UUID for this node
          const newId = uuidv4();
          // Store mapping from old ID to new UUID
          idMapping[n.id] = newId;

          return {
            id: newId,
            flow_id: flowId,
            node_type: n.node_type,
            name: n.name,
            position_x: n.position_x,
            position_y: n.position_y,
            config: n.config || {},
            created_at: new Date().toISOString()
          };
        });

        const { error: nodesError } = await supabase
          .from('flow_nodes')
          .insert(nodesWithFlowId);
        if (nodesError) throw nodesError;
      }

      // Insert new connections with mapped UUIDs
      if (connections.length > 0) {
        const connectionsWithFlowId = connections.map(c => ({
          flow_id: flowId,
          source_node_id: idMapping[c.source_node_id] || c.source_node_id,
          target_node_id: idMapping[c.target_node_id] || c.target_node_id,
          source_handle: c.source_handle || 'default',
          condition: c.condition || null
        }));

        const { error: connError } = await supabase
          .from('flow_connections')
          .insert(connectionsWithFlowId);
        if (connError) throw connError;
      }

      // Update flow timestamp
      await supabase
        .from('chatbot_flows')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', flowId);

      return true;
    } catch (error) {
      logger.error('Error saving flow design:', error);
      throw error;
    }
  },

  // Get active flows for an account (for message matching)
  async getActiveFlowsForAccount(accountId) {
    try {
      const { data, error } = await supabase
        .from('chatbot_flows')
        .select('*, flow_nodes(*), flow_connections(*)')
        .eq('account_id', accountId)
        .eq('is_active', true);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching active flows:', error);
      return [];
    }
  },

  // Log chatbot conversation
  async logChatbotConversation(data) {
    try {
      const { error } = await supabase
        .from('chatbot_conversations')
        .insert([{
          flow_id: data.flow_id,
          account_id: data.account_id,
          contact_number: data.contact_number,
          current_node_id: data.current_node_id,
          context: data.context || {},
          status: data.status || 'active',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);
      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error logging chatbot conversation:', error);
      return false;
    }
  },

  // Get or create conversation state
  async getConversationState(accountId, contactNumber) {
    try {
      const { data, error } = await supabase
        .from('chatbot_conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_number', contactNumber)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      logger.error('Error getting conversation state:', error);
      return null;
    }
  },

  // Update conversation state
  async updateConversationState(conversationId, updates) {
    try {
      const { data, error } = await supabase
        .from('chatbot_conversations')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error updating conversation state:', error);
      return null;
    }
  },

  // Log AI flow completion
  async logAIFlowCompletion(data) {
    try {
      const { error } = await supabase
        .from('ai_flow_completions')
        .insert([{
          flow_id: data.flow_id,
          flow_name: data.flow_name,
          account_id: data.account_id,
          contact_id: data.contact_id,
          collected_data: data.collected_data || {},
          conversation_history: data.conversation_history || [],
          webhook_delivered: data.webhook_delivered || false,
          webhook_response_code: data.webhook_response_code,
          completed_at: data.completed_at || new Date().toISOString(),
          created_at: new Date().toISOString()
        }]);
      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error logging AI flow completion:', error);
      return false;
    }
  },

  // Get AI flow completions for analytics
  async getAIFlowCompletions(accountId, options = {}) {
    try {
      let query = supabase
        .from('ai_flow_completions')
        .select('*')
        .eq('account_id', accountId)
        .order('completed_at', { ascending: false });

      if (options.limit) {
        query = query.limit(options.limit);
      }

      if (options.flowId) {
        query = query.eq('flow_id', options.flowId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching AI flow completions:', error);
      return [];
    }
  },

  // ============================================================================
  // ACCOUNT NUMBER SETTINGS (with caching for speed)
  // ============================================================================

  // Get number settings - uses cache for fast lookups
  async getNumberSettings(accountId, phoneNumber) {
    try {
      // Normalize phone number (remove non-digits)
      const normalizedPhone = phoneNumber.replace(/\D/g, '');
      const cacheKey = `number_settings:${accountId}:${normalizedPhone}`;

      // Check cache first
      const cached = cacheManager.get(cacheKey);
      if (cached !== null) {
        return cached;
      }

      // Query database
      const { data, error } = await supabase
        .from('account_number_settings')
        .select('*')
        .eq('account_id', accountId)
        .eq('phone_number', normalizedPhone)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      // Default settings if not found (all enabled)
      const settings = data || {
        webhook_enabled: true,
        chatbot_enabled: true,
        flow_enabled: true
      };

      // Cache for 5 minutes
      cacheManager.set(cacheKey, settings, 300000);

      return settings;
    } catch (error) {
      logger.error('Error getting number settings:', error);
      // Return defaults on error (don't block processing)
      return { webhook_enabled: true, chatbot_enabled: true, flow_enabled: true };
    }
  },

  // Get all number settings for an account
  async getAllNumberSettings(accountId) {
    try {
      const { data, error } = await supabase
        .from('account_number_settings')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error getting all number settings:', error);
      return [];
    }
  },

  // Add or update number settings
  async upsertNumberSettings(accountId, phoneNumber, settings) {
    try {
      const normalizedPhone = phoneNumber.replace(/\D/g, '');

      const { data, error } = await supabase
        .from('account_number_settings')
        .upsert({
          account_id: accountId,
          phone_number: normalizedPhone,
          webhook_enabled: settings.webhook_enabled !== false,
          chatbot_enabled: settings.chatbot_enabled !== false,
          flow_enabled: settings.flow_enabled !== false,
          notes: settings.notes || null,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'account_id,phone_number'
        })
        .select()
        .single();

      if (error) throw error;

      // Invalidate cache
      const cacheKey = `number_settings:${accountId}:${normalizedPhone}`;
      cacheManager.invalidate(cacheKey);

      return data;
    } catch (error) {
      logger.error('Error upserting number settings:', error);
      throw error;
    }
  },

  // Bulk upsert number settings (for n8n batch updates)
  async bulkUpsertNumberSettings(accountId, numbersArray) {
    try {
      const records = numbersArray.map(item => ({
        account_id: accountId,
        phone_number: (item.phone_number || item.phone || item.number || '').replace(/\D/g, ''),
        webhook_enabled: item.webhook_enabled !== false,
        chatbot_enabled: item.chatbot_enabled !== false,
        flow_enabled: item.flow_enabled !== false,
        notes: item.notes || null,
        updated_at: new Date().toISOString()
      }));

      const { data, error } = await supabase
        .from('account_number_settings')
        .upsert(records, {
          onConflict: 'account_id,phone_number'
        })
        .select();

      if (error) throw error;

      // Invalidate cache for all affected numbers
      records.forEach(r => {
        cacheManager.invalidate(`number_settings:${accountId}:${r.phone_number}`);
      });

      return data;
    } catch (error) {
      logger.error('Error bulk upserting number settings:', error);
      throw error;
    }
  },

  // Delete number settings
  async deleteNumberSettings(accountId, phoneNumber) {
    try {
      const normalizedPhone = phoneNumber.replace(/\D/g, '');

      const { error } = await supabase
        .from('account_number_settings')
        .delete()
        .eq('account_id', accountId)
        .eq('phone_number', normalizedPhone);

      if (error) throw error;

      // Invalidate cache
      cacheManager.invalidate(`number_settings:${accountId}:${normalizedPhone}`);

      return true;
    } catch (error) {
      logger.error('Error deleting number settings:', error);
      throw error;
    }
  },

  // Quick check helpers (use cached data)
  async isWebhookEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.webhook_enabled !== false;
  },

  async isChatbotEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.chatbot_enabled !== false;
  },

  async isFlowEnabledForNumber(accountId, phoneNumber) {
    const settings = await this.getNumberSettings(accountId, phoneNumber);
    return settings.flow_enabled !== false;
  },
};

module.exports = {
  supabase,
  db,
  MissingWebhookQueueTableError
};
