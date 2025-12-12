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
  parseInt(process.env.CACHE_TTL) || 60000
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

    try {
      let { error } = await supabase
        .from('message_logs')
        .insert(batch);

      // Handle unknown column errors gracefully
      if (error && error.code === 'PGRST204') {
        const unknownColMatch = error.message?.match(/'([^']+)' column/);
        const unknownCol = unknownColMatch ? unknownColMatch[1] : null;
        
        if (unknownCol) {
          logger.warn(`Retrying batch insert without unknown column: ${unknownCol}`);
          const sanitized = batch.map(m => {
            const copy = { ...m };
            delete copy[unknownCol];
            return copy;
          });
          
          const retry = await supabase.from('message_logs').insert(sanitized);
          error = retry.error;
        }
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
        .from('whatsapp_accounts')
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

    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('*')
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
    } catch (error) {
      logger.error('Error fetching accounts:', error);
      throw error;
    }
  },

  async getAccount(id) {
    const cacheKey = `account_${id}`;
    const cached = cacheManager.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('*')
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
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
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
    } catch (error) {
      logger.error(`Error updating account ${id}:`, error);
      throw error;
    }
  },

  async deleteAccount(id) {
    try {
      const { error } = await supabase
        .from('whatsapp_accounts')
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
      } catch (_) {}

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

  // Message logging with queue
  async logMessage(messageData) {
    messageQueue.add(messageData);
    return messageData;
  },

  // Immediate message logging (bypass queue for critical messages)
  async logMessageImmediate(messageData) {
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
      
      cacheManager.set(cacheKey, stats, 60000); // 60 second cache
      
      return stats;
    } catch (error) {
      logger.error(`Error fetching message stats for account ${accountId}:`, error);
      return { total: 0, incoming: 0, outgoing: 0, success: 0, failed: 0, outgoing_success: 0 };
    }
  },

  // Fetch conversation history for a specific contact
  async getConversationHistory(accountId, contactId, limit = 10) {
    try {
      const { data, error } = await supabase
        .from('message_logs')
        .select('direction, message, created_at')
        .eq('account_id', accountId)
        .or(`sender.eq.${contactId},recipient.eq.${contactId}`)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;

      // Return in chronological order (oldest first)
      return (data || []).reverse();
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

  async getAiConfig(accountId) {
    try {
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

      return data;
    } catch (error) {
      logger.error(`Error fetching AI config for ${accountId}:`, error);
      return null;
    }
  },

  async saveAiConfig(config) {
    try {
      const { data, error } = await supabase
        .from('ai_auto_replies')
        .upsert(config, { onConflict: 'account_id' })
        .select();

      if (error) throw error;
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
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
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

      logger.info(`Session data saved for account: ${accountId}`);
      return data[0];
    } catch (error) {
      logger.error(`Error saving session data for ${accountId}:`, error);
      throw error;
    }
  },

  /**
   * Get WhatsApp session data from database
   * @param {string} accountId - Account UUID
   * @returns {string|null} Base64 encoded session data or null
   */
  async getSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('session_data')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      return data?.session_data || null;
    } catch (error) {
      logger.error(`Error fetching session data for ${accountId}:`, error);
      return null;
    }
  },

  /**
   * Clear WhatsApp session data from database (logout)
   * @param {string} accountId - Account UUID
   */
  async clearSessionData(accountId) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
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
    try {
      const { data, error } = await supabase
        .from('whatsapp_accounts')
        .select('session_data, last_session_saved')
        .eq('id', accountId)
        .single();

      if (error) throw error;

      return !!(data?.session_data);
    } catch (error) {
      logger.error(`Error checking session data for ${accountId}:`, error);
      return false;
    }
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
};

module.exports = {
  supabase,
  db,
  MissingWebhookQueueTableError
};
