const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const logger = require('../../logger');

class OpenAIProvider extends BaseProvider {
  async generateResponse(messages, systemPrompt) {
    try {
      const model = this.config.model || 'gpt-4o-mini';
      // Check for reasoning models (o1, o3, o4 series)
      const isReasoning = model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
      
      let payloadMessages = [];
      
      if (isReasoning) {
        // Reasoning models (o1/o3) use 'developer' role instead of 'system'
        payloadMessages = [
          { role: 'developer', content: systemPrompt || 'You are a helpful assistant.' },
          ...messages
        ];
      } else {
        // Standard models use 'system' role
        payloadMessages = [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          ...messages
        ];
      }

      const payload = {
        model: model,
        messages: payloadMessages
      };

      // Add parameters based on model type
      if (isReasoning) {
        // Reasoning models use max_completion_tokens and don't support temperature
        payload.max_completion_tokens = 1000; 
      } else {
        // Standard models
        payload.temperature = this.config.temperature || 0.7;
        payload.max_tokens = 500;
      }

      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.api_key}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      const errorDetails = error.response?.data?.error || error.message;
      logger.error('OpenAI API Error:', JSON.stringify(errorDetails, null, 2));
      
      const newError = new Error(`OpenAI Error: ${errorDetails.message || error.message}`);
      if (error.response) {
          newError.response = error.response; // Attach original response for upstream handling
      }
      throw newError;
    }
  }
}

module.exports = OpenAIProvider;
