const axios = require('axios');
const logger = require('./logger');
const { db } = require('../config/database');

// Simple provider-agnostic AI auto-reply service
class AiAutoReplyService {
  async getConfig(accountId) {
    return db.getAiConfig(accountId);
  }

  async saveConfig(accountId, payload) {
    const config = {
      account_id: accountId,
      provider: payload.provider,
      api_key: payload.api_key,
      model: payload.model,
      system_prompt: payload.system_prompt || '',
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
      is_active: !!payload.is_active,
      updated_at: new Date().toISOString(),
      created_at: payload.created_at || new Date().toISOString()
    };
    return db.saveAiConfig(config);
  }

  async deleteConfig(accountId) {
    return db.deleteAiConfig(accountId);
  }

  // Core entrypoint used from WhatsApp manager
  async generateReply({ accountId, contactId, message }) {
    const config = await db.getAiConfig(accountId);
    if (!config || !config.is_active) {
      return null;
    }

    if (!config.api_key || !config.model || !config.provider) {
      logger.warn(`AI config incomplete for account ${accountId}`);
      return null;
    }

    const history = await db.getConversationHistory(accountId, contactId, 10);

    const start = Date.now();
    let replyText = null;
    try {
      switch (config.provider) {
        case 'openai':
          replyText = await this.callOpenAi({ config, history, message });
          break;
        case 'gemini':
          replyText = await this.callGemini({ config, history, message });
          break;
        case 'anthropic':
          replyText = await this.callAnthropic({ config, history, message });
          break;
        case 'openrouter':
        case 'openrouter-free':
          replyText = await this.callOpenRouter({ config, history, message });
          break;
        case 'groq':
          replyText = await this.callGroq({ config, history, message });
          break;
        default:
          logger.warn(`Unsupported AI provider: ${config.provider}`);
          return null;
      }
    } catch (error) {
      logger.error(`AI reply error for account ${accountId}:`, error.response?.data || error.message);
      return null;
    }

    const latency = Date.now() - start;
    logger.info(`AI reply generated for ${accountId}/${contactId} in ${latency}ms`);
    return replyText || null;
  }

  buildMessages({ config, history, message }) {
    const messages = [];

    if (config.system_prompt) {
      messages.push({ role: 'system', content: config.system_prompt });
    }

    for (const h of history) {
      messages.push({
        role: h.direction === 'incoming' ? 'user' : 'assistant',
        content: h.message || ''
      });
    }

    messages.push({ role: 'user', content: message });
    return messages;
  }

  async callOpenAi({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }

  async callGemini({ config, history, message }) {
    const contents = [];

    if (config.system_prompt) {
      contents.push({ role: 'user', parts: [{ text: config.system_prompt }] });
    }

    for (const h of history) {
      contents.push({
        role: h.direction === 'incoming' ? 'user' : 'model',
        parts: [{ text: h.message || '' }]
      });
    }

    contents.push({ role: 'user', parts: [{ text: message }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.api_key)}`;
    const response = await axios.post(
      url,
      {
        contents,
        generationConfig: {
          temperature: config.temperature ?? 0.7
        }
      },
      { timeout: 20000 }
    );

    const candidates = response.data.candidates || [];
    const first = candidates[0]?.content?.parts?.[0]?.text;
    return (first || '').trim() || null;
  }

  async callAnthropic({ config, history, message }) {
    const messages = [];

    for (const h of history) {
      messages.push({
        role: h.direction === 'incoming' ? 'user' : 'assistant',
        content: h.message || ''
      });
    }

    messages.push({ role: 'user', content: message });

    const payload = {
      model: config.model,
      max_tokens: 512,
      temperature: config.temperature ?? 0.7,
      messages,
      system: config.system_prompt || undefined
    };

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      payload,
      {
        headers: {
          'x-api-key': config.api_key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const content = response.data.content?.[0]?.text;
    return (content || '').trim() || null;
  }

  async callOpenRouter({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          'HTTP-Referer': 'https://github.com',
          'X-Title': 'WA Multi Automation',
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }

  async callGroq({ config, history, message }) {
    const messages = this.buildMessages({ config, history, message });
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: config.model || 'llama-3.3-70b-versatile',
        messages,
        temperature: config.temperature ?? 0.7,
        max_tokens: 1024
      },
      {
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || null;
  }

  // Test endpoint helper used by dashboard
  async testConfig({ accountId, provider, model, api_key, system_prompt, temperature, message }) {
    const tempConfig = {
      account_id: accountId,
      provider,
      model,
      api_key,
      system_prompt: system_prompt || '',
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      is_active: true
    };

    const history = await db.getConversationHistory(accountId, 'test', 3);

    switch (provider) {
      case 'openai':
        return this.callOpenAi({ config: tempConfig, history, message });
      case 'gemini':
        return this.callGemini({ config: tempConfig, history, message });
      case 'anthropic':
        return this.callAnthropic({ config: tempConfig, history, message });
      case 'openrouter':
      case 'openrouter-free':
        return this.callOpenRouter({ config: tempConfig, history, message });
      case 'groq':
        return this.callGroq({ config: tempConfig, history, message });
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

module.exports = new AiAutoReplyService();
