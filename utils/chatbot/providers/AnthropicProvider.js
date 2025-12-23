const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const logger = require('../../logger');

class AnthropicProvider extends BaseProvider {
  async generateResponse(messages, systemPrompt) {
    try {
      const model = this.config.model || 'claude-3-opus-20240229';
      
      // Anthropic expects: { role: 'user'|'assistant', content: '...' }
      // System prompt is a top-level parameter.
      
      const payload = {
        model: model,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content
        })),
        max_tokens: 500,
        temperature: this.config.temperature || 0.7
      };

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        payload,
        {
          headers: {
            'x-api-key': this.config.api_key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      return response.data.content[0].text;
    } catch (error) {
      logger.error('Anthropic API Error:', error.response?.data || error.message);
      throw new Error(`Anthropic Error: ${error.response?.data?.error?.message || error.message}`);
    }
  }
}

module.exports = AnthropicProvider;
