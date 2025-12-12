const { db, MissingChatbotsTableError } = require('../../config/database');
const logger = require('../logger');
const OpenAIProvider = require('./providers/OpenAIProvider');
const GeminiProvider = require('./providers/GeminiProvider');
const AnthropicProvider = require('./providers/AnthropicProvider');
const OpenRouterProvider = require('./providers/OpenRouterProvider');

class ChatbotManager {
  constructor() {
    this.processing = new Set(); // Track active processing per user
    this.providers = {
      'openai': OpenAIProvider,
      'gemini': GeminiProvider,
      'anthropic': AnthropicProvider,
      'openrouter': OpenRouterProvider
    };
  }

  /**
   * Process an incoming message and generate a response
   * @param {string} accountId - The WhatsApp account ID
   * @param {object} message - The incoming message object from whatsapp-web.js
   * @param {string} sender - The sender's phone number
   * @returns {Promise<string|null>} The generated response or null
   */
  async processMessage(accountId, message, sender) {
    const lockKey = `${accountId}:${sender}`;
    
    // 1. Concurrency Control (Simple Lock)
    if (this.processing.has(lockKey)) {
      logger.debug(`Chatbot busy for ${lockKey}, skipping`);
      return null;
    }

    this.processing.add(lockKey);

    try {
      // 2. Fetch Configuration
      const config = await db.getChatbotConfig(accountId);
      if (!config) {
        logger.debug(`[Chatbot] No config found for account ${accountId}`);
        return null;
      }
      
      if (!config.is_active) {
        logger.debug(`[Chatbot] Chatbot is disabled for account ${accountId}`);
        return null;
      }

      // 3. Validate Provider
      const ProviderClass = this.providers[config.provider];
      if (!ProviderClass) {
        logger.warn(`[Chatbot] Unknown provider: ${config.provider} for account ${accountId}`);
        return null;
      }

      const provider = new ProviderClass(config);
      if (!provider.validateConfig()) {
        logger.warn(`[Chatbot] Invalid chatbot config for account ${accountId}`);
        return null;
      }

      // 4. Build Context (History)
      // Use optimized DB query for history
      const history = await this.getConversationHistory(accountId, sender);
      logger.debug(`[Chatbot] Fetched ${history.length} history items for ${sender}`);
      
      // Add current message to history
      const currentMessage = {
        role: 'user',
        content: message.body
      };
      
      const messages = [...history, currentMessage];

      // 5. Send Typing Indicator (if possible)
      try {
        const chat = await message.getChat();
        await chat.sendStateTyping();
      } catch (typingError) {
        // Ignore typing errors
      }

      // 6. Generate Response
      logger.info(`[Chatbot] Generating AI response for ${accountId} via ${config.provider}`);
      const response = await provider.generateResponse(messages, config.system_prompt);

      // Clear typing state
      try {
        const chat = await message.getChat();
        await chat.clearState();
      } catch (e) {}

      return response;

    } catch (error) {
      // Handle missing table error gracefully
      if (error instanceof MissingChatbotsTableError || error.code === 'PGRST205' || (error.message && error.message.includes('chatbots'))) {
        logger.error(`[Chatbot] CRITICAL: The 'chatbots' table is missing in Supabase. Please run the migration script 'supabase-schema.sql'.`);
        return null;
      }
      
      logger.error(`Chatbot processing error for ${accountId}:`, error);
      return null;
    } finally {
      this.processing.delete(lockKey);
    }
  }

  /**
   * Fetch and format conversation history
   * @param {string} accountId 
   * @param {string} sender 
   * @returns {Promise<Array<{role: string, content: string}>>}
   */
  async getConversationHistory(accountId, sender) {
    try {
      // Use the optimized DB method
      const logs = await db.getConversationHistory(accountId, sender, 10);

      return logs.map(log => ({
        role: log.direction === 'incoming' ? 'user' : 'assistant',
        content: log.message
      }));

    } catch (error) {
      logger.error(`Error fetching history for ${accountId}:`, error);
      return [];
    }
  }

  /**
   * Test a chatbot configuration
   * @param {object} config - The configuration to test
   * @param {string} message - The test message
   * @returns {Promise<string>} The generated response
   */
  async testConfig(config, message) {
    try {
      const ProviderClass = this.providers[config.provider];
      if (!ProviderClass) {
        throw new Error(`Unknown provider: ${config.provider}`);
      }

      const provider = new ProviderClass(config);
      if (!provider.validateConfig()) {
        throw new Error('Invalid configuration: Missing API Key or Model');
      }

      const messages = [{ role: 'user', content: message }];
      return await provider.generateResponse(messages, config.system_prompt);
    } catch (error) {
      // Enhance error message for the frontend
      if (error.response) {
        // Axios error
        const status = error.response.status;
        const data = error.response.data;
        let details = '';
        
        if (typeof data === 'object') {
            // Try to extract meaningful error message from common provider formats
            if (data.error && data.error.message) details = data.error.message;
            else if (data.error) details = JSON.stringify(data.error);
            else details = JSON.stringify(data);
        } else {
            details = data;
        }

        if (status === 401) throw new Error(`Authentication Failed (401): Check your API Key.`);
        if (status === 429) throw new Error(`Rate Limit Exceeded (429): You are sending too many requests.`);
        if (status === 500) throw new Error(`Provider Server Error (500): The AI provider is having issues.`);
        
        throw new Error(`API Error (${status}): ${details}`);
      }
      throw error;
    }
  }
}

module.exports = new ChatbotManager();
