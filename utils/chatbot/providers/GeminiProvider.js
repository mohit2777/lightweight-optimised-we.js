const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const logger = require('../../logger');

class GeminiProvider extends BaseProvider {
  async generateResponse(messages, systemPrompt) {
    try {
      // Use gemini-2.5-flash as default, it's the new standard for speed and efficiency
      const model = this.config.model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.config.api_key}`;
      
      let geminiContent = [];
      let systemInstruction = null;

      // Handle System Prompt
      // For Gemini 1.5 models, we can use the system_instruction field
      if (systemPrompt) {
        systemInstruction = {
          parts: [{ text: systemPrompt }]
        };
      }

      // Convert messages
      messages.forEach(msg => {
        const role = msg.role === 'user' ? 'user' : 'model';
        geminiContent.push({
          role: role,
          parts: [{ text: msg.content }]
        });
      });

      const payload = {
        contents: geminiContent,
        generationConfig: {
          temperature: this.config.temperature || 0.7,
          maxOutputTokens: 500,
        },
        // Relax safety settings to prevent over-blocking in normal conversations
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
        ]
      };

      if (systemInstruction) {
        payload.systemInstruction = systemInstruction;
      }

      const response = await axios.post(url, payload, { timeout: 15000 });
      
      if (response.data.candidates && response.data.candidates.length > 0) {
        const candidate = response.data.candidates[0];
        
        // Check for finish reason
        if (candidate.finishReason) {
            if (candidate.finishReason === 'SAFETY') {
                throw new Error('Response blocked by safety filters. Try adjusting the prompt.');
            }
            if (candidate.finishReason !== 'STOP') {
                logger.warn(`Gemini stopped with reason: ${candidate.finishReason}`);
            }
        }

        if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
          return candidate.content.parts[0].text;
        }
      }
      
      return null;
    } catch (error) {
      const errorDetails = error.response?.data?.error || error.message;
      logger.error('Gemini API Error:', JSON.stringify(errorDetails, null, 2));
      
      const newError = new Error(`Gemini Error: ${errorDetails.message || error.message}`);
      if (error.response) {
          newError.response = error.response; // Attach original response for upstream handling
      }
      throw newError;
    }
  }
}

module.exports = GeminiProvider;
