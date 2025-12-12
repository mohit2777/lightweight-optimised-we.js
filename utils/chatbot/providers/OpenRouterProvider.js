const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const logger = require('../../logger');

class OpenRouterProvider extends BaseProvider {
  async generateResponse(messages, systemPrompt) {
    try {
      const model = this.config.model || 'openai/gpt-4o';
      
      // OpenRouter uses the standard OpenAI chat completions format
      const payloadMessages = [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        ...messages
      ];

      const payload = {
        model: model,
        messages: payloadMessages,
        temperature: this.config.temperature || 0.7,
        // OpenRouter specific optional parameters
        provider: {
          // Optional: Force specific providers if needed
          // order: ["OpenAI", "Anthropic"],
          // allow_fallbacks: true
        }
      };

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.api_key}`,
            'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000', // Required by OpenRouter for rankings
            'X-Title': 'WhatsApp Multi-Automation', // Required by OpenRouter for rankings
            'Content-Type': 'application/json'
          },
          timeout: 45000 // OpenRouter can sometimes be slower as it routes requests
        }
      );

      if (response.data.choices && response.data.choices.length > 0) {
        return response.data.choices[0].message.content;
      }
      
      return null;
    } catch (error) {
      const errorDetails = error.response?.data?.error || error.message;
      logger.error('OpenRouter API Error:', JSON.stringify(errorDetails, null, 2));
      
      const newError = new Error(`OpenRouter Error: ${errorDetails.message || error.message}`);
      if (error.response) {
          newError.response = error.response;
      }
      throw newError;
    }
  }
}

module.exports = OpenRouterProvider;
