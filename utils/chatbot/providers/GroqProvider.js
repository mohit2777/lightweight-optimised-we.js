const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const logger = require('../../logger');

/**
 * Groq Provider - Free tier LLM provider with fast inference
 * Free API key available at: https://console.groq.com
 * 
 * Free models include:
 * - llama-3.3-70b-versatile (Recommended)
 * - llama-3.1-70b-versatile
 * - llama-3.1-8b-instant (Fastest)
 * - mixtral-8x7b-32768
 * - gemma2-9b-it
 */
class GroqProvider extends BaseProvider {
  async generateResponse(messages, systemPrompt) {
    try {
      const model = this.config.model || 'llama-3.3-70b-versatile';
      
      const payloadMessages = [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        ...messages
      ];

      const payload = {
        model: model,
        messages: payloadMessages,
        temperature: this.config.temperature || 0.7,
        max_tokens: 500,
        top_p: 1,
        stream: false
      };

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.api_key}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.data.choices && response.data.choices.length > 0) {
        return response.data.choices[0].message.content;
      }
      
      return null;
    } catch (error) {
      const errorDetails = error.response?.data?.error || error.message;
      logger.error('Groq API Error:', JSON.stringify(errorDetails, null, 2));
      
      const newError = new Error(`Groq Error: ${errorDetails.message || error.message}`);
      if (error.response) {
        newError.response = error.response;
      }
      throw newError;
    }
  }
}

module.exports = GroqProvider;
