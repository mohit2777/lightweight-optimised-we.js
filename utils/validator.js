const Joi = require('joi');

// Validation schemas
const schemas = {
  // Account validation
  createAccount: Joi.object({
    name: Joi.string().min(1).max(255).required(),
    description: Joi.string().max(1000).allow('', null).optional()
  }),

  updateAccount: Joi.object({
    name: Joi.string().min(1).max(255).optional(),
    description: Joi.string().max(1000).allow('', null).optional(),
    status: Joi.string().valid('initializing', 'qr_ready', 'ready', 'disconnected', 'auth_failed', 'error').optional(),
    phone_number: Joi.string().max(50).allow('', null).optional(),
    error_message: Joi.string().max(1000).allow('', null).optional()
  }),

  // Webhook validation
  createWebhook: Joi.object({
    account_id: Joi.string().uuid().required(),
    url: Joi.string().uri().max(500).required(),
    secret: Joi.string().max(255).allow('', null).optional(),
    is_active: Joi.boolean().optional().default(true)
  }),

  updateWebhook: Joi.object({
    url: Joi.string().uri().max(500).optional(),
    secret: Joi.string().max(255).allow('', null).optional(),
    is_active: Joi.boolean().optional()
  }),

  // Message validation
  sendMessage: Joi.object({
    account_id: Joi.string().uuid().required(),
    number: Joi.string().min(1).max(50).required(),
    message: Joi.string().min(1).max(10000).required()
  }),

  sendMedia: Joi.object({
    account_id: Joi.string().uuid().required(),
    number: Joi.string().min(1).max(50).required(),
    media: Joi.object({
      data: Joi.string().optional(),
      url: Joi.string().uri().optional(),
      mimetype: Joi.string().max(100).when('data', {
        is: Joi.exist(),
        then: Joi.required(),
        otherwise: Joi.optional()
      }),
      filename: Joi.string().max(255).optional()
    }).required().custom((value, helpers) => {
      if (!value.data && !value.url) {
        return helpers.error('object.missing', { message: 'Either data or url must be provided' });
      }
      return value;
    }),
    caption: Joi.string().max(1000).allow('', null).optional(),
    options: Joi.object({
      sendMediaAsDocument: Joi.boolean().optional(),
      sendAudioAsVoice: Joi.boolean().optional()
    }).optional().default({})
  }),

  webhookReply: Joi.object({
    account_id: Joi.string().uuid().required(),
    number: Joi.string().min(1).max(50).required(),
    webhook_secret: Joi.string().required(),
    message: Joi.string().max(10000).optional(),
    media: Joi.object({
      data: Joi.string().optional(),
      url: Joi.string().uri().optional(),
      mimetype: Joi.string().max(100).optional(),
      filename: Joi.string().max(255).optional()
    }).optional(),
    caption: Joi.string().max(1000).allow('', null).optional()
  }),

  // Query params validation
  messageLogs: Joi.object({
    limit: Joi.number().integer().min(1).max(1000).optional().default(100),
    offset: Joi.number().integer().min(0).optional().default(0)
  }),

  // Login validation
  login: Joi.object({
    username: Joi.string().min(1).max(50).required(),
    password: Joi.string().min(1).max(100).required()
  })
};

// Validation middleware factory
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    // Replace request data with validated and sanitized data
    req[property] = value;
    next();
  };
};

// Phone number validation and formatting
const isValidPhoneNumber = (number) => {
  // Remove all non-digit characters
  const cleaned = number.replace(/[^\d]/g, '');
  // Valid phone number should have 10-15 digits
  return cleaned.length >= 10 && cleaned.length <= 15;
};

// Sanitize input to prevent XSS
const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    return input.trim().replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }
  return input;
};

// UUID validation
const isValidUUID = (uuid) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

module.exports = {
  schemas,
  validate,
  isValidPhoneNumber,
  sanitizeInput,
  isValidUUID
};
