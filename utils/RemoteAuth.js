/**
 * RemoteAuth Strategy for whatsapp-web.js
 * Stores WhatsApp session data in Supabase database instead of filesystem
 * Solves Render.com ephemeral storage issues
 * 
 * Based on Ranger-4 implementation - simpler and more reliable
 */

const logger = require('./logger');
const fs = require('fs').promises;
const path = require('path');
const BaseAuthStrategy = require('whatsapp-web.js/src/authStrategies/BaseAuthStrategy');

// Lazy load db
let _db = null;
function getDb() {
  if (!_db) {
    try {
      _db = require('../config/database.lite').db;
    } catch {
      _db = require('../config/database').db;
    }
  }
  return _db;
}

class RemoteAuth extends BaseAuthStrategy {
  constructor(options = {}) {
    super();
    this.accountId = options.accountId;
    this.clientId = options.accountId; // Required by whatsapp-web.js
    this.dataPath = options.dataPath || './wa-sessions-temp';
    this.sessionName = options.sessionName || 'session';
    
    if (!this.accountId) {
      throw new Error('accountId is required for RemoteAuth');
    }
  }

  setup(client) {
    super.setup(client);
  }

  /**
   * Required by whatsapp-web.js - Called after authentication is ready
   */
  async afterAuthReady() {
    logger.info(`[RemoteAuth] Auth ready for ${this.accountId}`);
  }

  /**
   * Required by whatsapp-web.js - Returns paths for session storage
   */
  async extractLocalAuthPaths() {
    return {
      dataPath: this.dataPath,
      clientPath: path.join(this.dataPath, this.clientId)
    };
  }

  async beforeBrowserInitialized() {
    // Create temporary directory for session files
    const sessionPath = path.join(this.dataPath, this.accountId);
    
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.mkdir(sessionPath, { recursive: true });
      
      logger.info(`[RemoteAuth] Temporary session directory created: ${sessionPath}`);
    } catch (error) {
      logger.error('[RemoteAuth] Error creating temp directory:', error);
    }
  }

  async logout() {
    logger.info(`[RemoteAuth] Logging out account: ${this.accountId}`);
    
    try {
      // Clear session from database
      await getDb().clearSessionData(this.accountId);
      
      // Clear temporary files
      const sessionPath = path.join(this.dataPath, this.accountId);
      try {
        await fs.rm(sessionPath, { recursive: true, force: true });
      } catch (error) {
        logger.warn('[RemoteAuth] Could not delete temp session files:', error.message);
      }
      
      logger.info(`[RemoteAuth] Session cleared for account: ${this.accountId}`);
    } catch (error) {
      logger.error('[RemoteAuth] Error during logout:', error);
      throw error;
    }
  }

  async destroy() {
    logger.info(`[RemoteAuth] Destroying session for account: ${this.accountId}`);
    await this.logout();
  }

  /**
   * Extract session data from WhatsApp client
   */
  clientId() {
    return this.accountId;
  }

  /**
   * Get session path for temporary storage
   */
  getSessionPath() {
    return path.join(this.dataPath, this.accountId);
  }

  /**
   * Load session from database
   */
  async restore(client) {
    try {
      logger.info(`[RemoteAuth] Attempting to restore session for: ${this.accountId}`);
      
      // Get session data from database
      const sessionData = await getDb().getSessionData(this.accountId);
      
      if (!sessionData) {
        logger.info(`[RemoteAuth] No session found in database for: ${this.accountId}`);
        return null;
      }

      // Decode and restore session
      const sessionObj = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf-8'));
      
      logger.info(`[RemoteAuth] Session restored from database for: ${this.accountId}`);
      return sessionObj;
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error restoring session for ${this.accountId}:`, error);
      return null;
    }
  }

  /**
   * Save session to database
   */
  async save(session) {
    try {
      logger.info(`[RemoteAuth] Saving session to database for: ${this.accountId}`);
      
      if (!session || typeof session !== 'object') {
        logger.warn('[RemoteAuth] Invalid session data, skipping save');
        return;
      }

      // Verify session has required fields (WABrowserId, WASecretBundle, etc.)
      if (!session.WABrowserId || !session.WASecretBundle) {
        logger.warn(`[RemoteAuth] Incomplete session data for ${this.accountId}, missing critical fields`);
        return;
      }

      // Encode session data to base64
      const sessionJson = JSON.stringify(session);
      const sessionBase64 = Buffer.from(sessionJson).toString('base64');
      
      // Save to database with retry logic
      let retries = 3;
      while (retries > 0) {
        try {
          await getDb().saveSessionData(this.accountId, sessionBase64);
          logger.info(`[RemoteAuth] Session saved successfully for: ${this.accountId}`);
          return;
        } catch (dbError) {
          retries--;
          if (retries === 0) throw dbError;
          logger.warn(`[RemoteAuth] Database save failed, retrying... (${retries} left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error saving session for ${this.accountId}:`, error);
      // Don't throw - allow connection to continue even if save fails
    }
  }

  /**
   * Delete session from database
   */
  async delete() {
    try {
      logger.info(`[RemoteAuth] Deleting session for: ${this.accountId}`);
      
      await getDb().clearSessionData(this.accountId);
      
      logger.info(`[RemoteAuth] Session deleted for: ${this.accountId}`);
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error deleting session for ${this.accountId}:`, error);
      throw error;
    }
  }
}

module.exports = RemoteAuth;
