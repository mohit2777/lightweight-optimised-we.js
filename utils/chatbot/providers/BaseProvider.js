class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Generate a response from the AI provider
   * @param {Array<{role: string, content: string}>} messages - History of messages
   * @param {string} systemPrompt - The system instruction
   * @returns {Promise<string>} The generated response
   */
  async generateResponse(messages, systemPrompt) {
    throw new Error('Method generateResponse() must be implemented');
  }

  /**
   * Validate the configuration
   * @returns {boolean}
   */
  validateConfig() {
    return !!this.config.api_key;
  }
}

module.exports = BaseProvider;
