/**
 * Lightweight Database Module - Minimal RAM Version
 * Only loads essential features, lazy-loads everything else
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Missing Supabase configuration');
  process.exit(1);
}

// Minimal Supabase client
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 2 } }
});

// Tiny cache - max 50 items, 2 min TTL
class TinyCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 50;
    this.ttl = 120000;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, exp: Date.now() + this.ttl });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.exp) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  invalidate(key) { this.cache.delete(key); }
  clear() { this.cache.clear(); }
  getStats() { return { size: this.cache.size }; }
}

const cache = new TinyCache();

// Error classes
class MissingWebhookQueueTableError extends Error {
  constructor() { super('webhook_delivery_queue table not found'); this.name = 'MissingWebhookQueueTableError'; }
}

function isWebhookQueueMissing(err) {
  return err?.code === 'PGRST205' && /webhook_delivery_queue/i.test(err?.message || '');
}

// Minimal message queue - disabled by default
let messageQueue = null;

function getMessageQueue() {
  if (process.env.DISABLE_MESSAGE_LOGGING === 'true') return null;
  if (!messageQueue) {
    messageQueue = {
      queue: [],
      timer: null,
      add(msg) {
        this.queue.push(msg);
        if (this.queue.length >= 20) this.flush();
      },
      async flush() {
        if (this.queue.length === 0) return;
        const batch = this.queue.splice(0, 20);
        try {
          await supabase.from('message_logs').insert(batch);
        } catch (e) {
          logger.warn('Message log failed:', e.message);
        }
      },
      start() {
        if (!this.timer) this.timer = setInterval(() => this.flush(), 10000);
      },
      stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      },
      getQueueSize() { return this.queue.length; }
    };
    messageQueue.start();
  }
  return messageQueue;
}

// Core database functions - minimal set
const db = {
  // ========== ACCOUNTS ==========
  async createAccount(data) {
    const { data: result, error } = await supabase.from('whatsapp_accounts').insert([data]).select();
    if (error) throw error;
    cache.invalidate('accounts');
    return result[0];
  },

  async getAccounts() {
    const cached = cache.get('accounts');
    if (cached) return cached;
    
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .select('id, name, description, phone_number, status, created_at, updated_at')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    cache.set('accounts', data || []);
    return data || [];
  },

  async getAccount(id) {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .select('id, name, description, phone_number, status, created_at, updated_at')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  },

  async updateAccount(id, updates) {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .update(updates)
      .eq('id', id)
      .select();
    if (error) throw error;
    cache.invalidate('accounts');
    return data?.[0];
  },

  async deleteAccount(id) {
    const { error } = await supabase.from('whatsapp_accounts').delete().eq('id', id);
    if (error) throw error;
    cache.invalidate('accounts');
    return true;
  },

  // ========== SESSION DATA ==========
  async getSessionData(accountId) {
    const { data, error } = await supabase
      .from('whatsapp_accounts')
      .select('session_data')
      .eq('id', accountId)
      .single();
    if (error) return null;
    return data?.session_data || null;
  },

  async saveSessionData(accountId, sessionData) {
    const { error } = await supabase
      .from('whatsapp_accounts')
      .update({ session_data: sessionData, last_session_saved: new Date().toISOString() })
      .eq('id', accountId);
    if (error) throw error;
    return true;
  },

  async clearSessionData(accountId) {
    const { error } = await supabase
      .from('whatsapp_accounts')
      .update({ session_data: null, last_session_saved: null })
      .eq('id', accountId);
    if (error) throw error;
    return true;
  },

  async hasSessionData(accountId) {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('session_data')
      .eq('id', accountId)
      .single();
    return !!(data?.session_data && data.session_data.length > 100);
  },

  // ========== WEBHOOKS ==========
  async getWebhooks(accountId) {
    const { data, error } = await supabase
      .from('webhooks')
      .select('*')
      .eq('account_id', accountId);
    if (error) throw error;
    return data || [];
  },

  async createWebhook(webhookData) {
    const { data, error } = await supabase.from('webhooks').insert([webhookData]).select();
    if (error) throw error;
    return data[0];
  },

  async getWebhook(id) {
    const { data, error } = await supabase.from('webhooks').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },

  async updateWebhook(id, updates) {
    const { data, error } = await supabase.from('webhooks').update(updates).eq('id', id).select();
    if (error) throw error;
    return data?.[0];
  },

  async deleteWebhook(id) {
    const { error } = await supabase.from('webhooks').delete().eq('id', id);
    if (error) throw error;
    return true;
  },

  // ========== MESSAGE LOGGING (minimal) ==========
  async logMessage(msg) {
    const mq = getMessageQueue();
    if (mq) mq.add(msg);
    return msg;
  },

  async getMessageLogs(accountId, limit = 50) {
    const { data, error } = await supabase
      .from('message_logs')
      .select('*')
      .eq('account_id', accountId)
      .neq('sender', 'status@broadcast')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  async getAllMessageLogs(limit = 50, offset = 0) {
    const { data, error } = await supabase
      .from('message_logs')
      .select('*')
      .neq('sender', 'status@broadcast')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return data || [];
  },

  async getMessageStats(accountId) {
    try {
      const [total, incoming, outgoing] = await Promise.all([
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('direction', 'incoming'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('direction', 'outgoing')
      ]);
      return {
        total: total.count || 0,
        incoming: incoming.count || 0,
        outgoing: outgoing.count || 0,
        success: total.count || 0,
        failed: 0
      };
    } catch (e) {
      return { total: 0, incoming: 0, outgoing: 0, success: 0, failed: 0 };
    }
  },

  async getDailyMessageStats(days = 7) {
    return []; // Skip for minimal RAM
  },

  // ========== WEBHOOK QUEUE (lazy) ==========
  async enqueueWebhookDelivery(delivery) {
    const { error } = await supabase.from('webhook_delivery_queue').insert([{
      account_id: delivery.accountId,
      webhook_id: delivery.webhook.id,
      webhook_url: delivery.webhook.url,
      webhook_secret: delivery.webhook.secret || null,
      payload: delivery.payload,
      status: 'pending',
      attempts: 0,
      max_retries: delivery.maxRetries || 3,
      created_at: new Date().toISOString(),
      next_retry_at: new Date().toISOString()
    }]);
    if (error && isWebhookQueueMissing(error)) throw new MissingWebhookQueueTableError();
    if (error) throw error;
  },

  async getDueWebhookDeliveries(limit = 5) {
    const { data, error } = await supabase
      .from('webhook_delivery_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error && isWebhookQueueMissing(error)) throw new MissingWebhookQueueTableError();
    if (error) throw error;
    return data || [];
  },

  async markWebhookDeliveryProcessing(job) {
    const { data, error } = await supabase
      .from('webhook_delivery_queue')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select();
    if (error && isWebhookQueueMissing(error)) throw new MissingWebhookQueueTableError();
    return data?.[0] || null;
  },

  async completeWebhookDelivery(id, status) {
    await supabase.from('webhook_delivery_queue').update({
      status: 'completed',
      response_status: status,
      completed_at: new Date().toISOString()
    }).eq('id', id);
  },

  async failWebhookDelivery(id, errorMsg, nextRetry) {
    const job = await supabase.from('webhook_delivery_queue').select('attempts, max_retries').eq('id', id).single();
    const attempts = (job.data?.attempts || 0) + 1;
    const maxRetries = job.data?.max_retries || 3;
    
    if (attempts >= maxRetries) {
      await supabase.from('webhook_delivery_queue').update({
        status: 'failed',
        last_error: errorMsg,
        attempts
      }).eq('id', id);
    } else {
      await supabase.from('webhook_delivery_queue').update({
        status: 'pending',
        last_error: errorMsg,
        attempts,
        next_retry_at: nextRetry
      }).eq('id', id);
    }
  },

  async resetStuckWebhookDeliveries() {
    await supabase
      .from('webhook_delivery_queue')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('status', 'processing');
  },

  async getWebhookQueueStats() {
    try {
      const [pending, failed] = await Promise.all([
        supabase.from('webhook_delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('webhook_delivery_queue').select('*', { count: 'exact', head: true }).eq('status', 'failed')
      ]);
      return { pending: pending.count || 0, failed: failed.count || 0 };
    } catch (e) {
      if (isWebhookQueueMissing(e)) throw new MissingWebhookQueueTableError();
      throw e;
    }
  },

  // ========== UTILITIES ==========
  getQueueStatus() {
    const mq = getMessageQueue();
    return { queueSize: mq?.getQueueSize() || 0 };
  },

  getCacheStats() { return cache.getStats(); },
  clearCache() { cache.clear(); },

  async flushMessageQueue() {
    const mq = getMessageQueue();
    if (mq) await mq.flush();
  }
};

module.exports = { db, supabase, MissingWebhookQueueTableError };
