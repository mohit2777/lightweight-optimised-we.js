const axios = require('axios');
const EventEmitter = require('events');
const logger = require('./logger');

// Lazy load database to support both full and lite mode
let _db = null;
let MissingWebhookQueueTableError = null;

function getDb() {
  if (!_db) {
    try {
      const dbModule = require('../config/database.lite');
      _db = dbModule.db;
      MissingWebhookQueueTableError = dbModule.MissingWebhookQueueTableError;
    } catch {
      const dbModule = require('../config/database');
      _db = dbModule.db;
      MissingWebhookQueueTableError = dbModule.MissingWebhookQueueTableError;
    }
  }
  return _db;
}

class PermanentWebhookError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PermanentWebhookError';
    this.status = status;
    this.isPermanent = true;
  }
}

class WebhookDeliveryService extends EventEmitter {
  constructor() {
    super();
    this.interval = parseInt(process.env.WEBHOOK_WORKER_INTERVAL_MS, 10) || 3000;
    this.batchSize = parseInt(process.env.WEBHOOK_WORKER_BATCH_SIZE, 10) || 10;
    this.defaultMaxRetries = parseInt(process.env.WEBHOOK_MAX_RETRIES, 10) || 5;
    this.baseBackoffMs = parseInt(process.env.WEBHOOK_BACKOFF_MS, 10) || 2000;
    this.maxBackoffMs = parseInt(process.env.WEBHOOK_MAX_BACKOFF_MS, 10) || 60000;
    this.timer = null;
    this.isProcessing = false;
    this.started = false;
    this.disabled = false;
    this.disableReason = '';
  }

  async start() {
    if (this.started || this.disabled) {
      return;
    }

    try {
      await getDb().resetStuckWebhookDeliveries();
    } catch (error) {
      if (MissingWebhookQueueTableError && error instanceof MissingWebhookQueueTableError) {
        this.disableService('Missing database table webhook_delivery_queue. Apply the latest SQL migration.');
        return;
      }
      throw error;
    }

    this.timer = setInterval(() => this.processQueue(), this.interval);
    this.started = true;
    logger.info('WebhookDeliveryService started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    logger.info('WebhookDeliveryService stopped');
  }

  disableService(reason) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.disabled = true;
    this.disableReason = reason;
    logger.error(`WebhookDeliveryService disabled: ${reason}`);
  }

  async queueDeliveries(accountId, webhooks, messageData) {
    if (this.disabled) {
      return;
    }

    if (!Array.isArray(webhooks) || webhooks.length === 0) {
      return;
    }

    // Determine event type from messageData
    const eventType = messageData.event || 'message';

    // Filter webhooks that are subscribed to this event type
    const subscribedWebhooks = webhooks.filter(webhook => {
      const events = webhook.events || ['message'];
      // Support both exact match and wildcard
      return events.includes(eventType) || events.includes('*') || events.includes('all');
    });

    if (subscribedWebhooks.length === 0) {
      return;
    }

    const sanitizedPayload = JSON.parse(JSON.stringify(messageData));

    try {
      await Promise.all(subscribedWebhooks.map(webhook => {
        return getDb().enqueueWebhookDelivery({
          accountId,
          webhook,
          payload: this.buildPayload(webhook, sanitizedPayload),
          maxRetries: webhook.max_retries || this.defaultMaxRetries
        });
      }));
    } catch (error) {
      if (MissingWebhookQueueTableError && error instanceof MissingWebhookQueueTableError) {
        this.disableService('Missing webhook_delivery_queue table while enqueueing deliveries');
        this.logMigrationHint();
      } else {
        throw error;
      }
    }
  }

  async processQueue() {
    if (this.isProcessing || this.disabled) {
      return;
    }

    this.isProcessing = true;

    try {
      const jobs = await getDb().getDueWebhookDeliveries(this.batchSize);
      if (!jobs.length) {
        return;
      }

      await Promise.allSettled(jobs.map(job => this.processJob(job)));
    } catch (error) {
      if (MissingWebhookQueueTableError && error instanceof MissingWebhookQueueTableError) {
        this.disableService('Missing webhook_delivery_queue table while processing queue');
        this.logMigrationHint();
      } else {
        logger.error('Webhook queue processing error:', error);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async processJob(job) {
    if (this.disabled) {
      return;
    }

    let claimedJob;
    try {
      claimedJob = await getDb().markWebhookDeliveryProcessing(job);
    } catch (error) {
      if (MissingWebhookQueueTableError && error instanceof MissingWebhookQueueTableError) {
        this.disableService('Missing webhook_delivery_queue table while updating job state');
        this.logMigrationHint();
        return;
      }
      throw error;
    }

    if (!claimedJob) {
      return;
    }

    const startTime = Date.now();

    try {
      const response = await this.sendWebhookRequest(claimedJob);
      await getDb().completeWebhookDelivery(claimedJob.id, response.status);

      await getDb().logMessage({
        account_id: claimedJob.account_id,
        direction: 'webhook',
        status: 'success',
        webhook_id: claimedJob.webhook_id,
        webhook_url: claimedJob.webhook_url,
        response_status: response.status,
        processing_time_ms: Date.now() - startTime,
        created_at: new Date().toISOString()
      });

      this.emit('delivery-success', {
        job: claimedJob,
        status: response.status
      });
    } catch (error) {
      const backoffMs = this.getBackoffDelay(claimedJob.attempt_count);
      const isDeadLetter = error.isPermanent || claimedJob.attempt_count >= (claimedJob.max_retries || this.defaultMaxRetries);
      const nextAttempt = isDeadLetter ? null : new Date(Date.now() + backoffMs).toISOString();

      try {
        await getDb().failWebhookDelivery(
          claimedJob,
          error.message,
          nextAttempt,
          isDeadLetter
        );
      } catch (dbError) {
        if (MissingWebhookQueueTableError && dbError instanceof MissingWebhookQueueTableError) {
          this.disableService('Missing webhook_delivery_queue table while recording failure');
          this.logMigrationHint();
          return;
        }
        throw dbError;
      }

      await getDb().logMessage({
        account_id: claimedJob.account_id,
        direction: 'webhook',
        status: isDeadLetter ? 'failed' : 'pending',
        webhook_id: claimedJob.webhook_id,
        webhook_url: claimedJob.webhook_url,
        error_message: error.message,
        response_status: error.status || null,
        retry_count: claimedJob.attempt_count,
        processing_time_ms: Date.now() - startTime,
        created_at: new Date().toISOString()
      });

      this.emit('delivery-failed', {
        job: claimedJob,
        error,
        deadLetter: isDeadLetter
      });
    }
  }

  async sendWebhookRequest(job) {
    const payload = job.payload;
    const isN8n = this.isN8n(job.webhook_url);
    const timeout = isN8n ? 5000 : 10000;
    const maxPayloadSize = 50 * 1024 * 1024; // 50MB
    const payloadSize = Buffer.byteLength(JSON.stringify(payload));

    if (payloadSize > maxPayloadSize) {
      throw new PermanentWebhookError(`Payload too large (${(payloadSize / 1024 / 1024).toFixed(2)}MB)`, 413);
    }

    try {
      const response = await axios.post(job.webhook_url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': job.webhook_secret || '',
          'X-Account-ID': job.account_id,
          'User-Agent': 'WhatsApp-Multi-Automation/3.0'
        },
        timeout,
        maxContentLength: maxPayloadSize,
        maxBodyLength: maxPayloadSize,
        validateStatus: () => true
      });

      if (response.status >= 500) {
        throw new Error(`Webhook server error ${response.status}`);
      }

      if (response.status >= 400) {
        throw new PermanentWebhookError(`Webhook rejected with status ${response.status}`, response.status);
      }

      return response;
    } catch (error) {
      if (error instanceof PermanentWebhookError) {
        throw error;
      }

      if (error.response && error.response.status >= 400 && error.response.status < 500) {
        throw new PermanentWebhookError(`Webhook rejected with status ${error.response.status}`, error.response.status);
      }

      throw error;
    }
  }

  buildPayload(webhook, messageData) {
    const eventType = messageData.event || 'message';

    if (this.isN8n(webhook.url)) {
      // Handle message_ack events (read receipts)
      if (eventType === 'message_ack') {
        return {
          event: 'message_ack',
          account_id: messageData.account_id,
          message_id: messageData.message_id,
          recipient: messageData.recipient,
          status: messageData.ack_name, // 'sent', 'delivered', 'read'
          status_code: messageData.ack, // 2=sent, 3=delivered, 4=read
          timestamp: messageData.timestamp,
          optimized: true
        };
      }

      // Handle regular message events
      const {
        account_id,
        direction,
        sender,
        recipient,
        message,
        timestamp,
        type,
        chat_id,
        is_group,
        media
      } = messageData;

      return {
        event: 'message',
        account_id,
        direction,
        sender,
        recipient,
        message,
        timestamp,
        type,
        chat_id,
        is_group,
        media,
        optimized: true
      };
    }

    return messageData;
  }

  isN8n(url) {
    return /n8n|nodemation/i.test(url || '');
  }

  getBackoffDelay(attempt) {
    const exp = Math.pow(2, Math.max(attempt - 1, 0));
    return Math.min(this.baseBackoffMs * exp, this.maxBackoffMs);
  }

  logMigrationHint() {
    logger.error('Apply the new webhook queue schema in supabase-schema.sql (webhook_delivery_queue table and indexes), then restart the service.');
  }
}

module.exports = new WebhookDeliveryService();
