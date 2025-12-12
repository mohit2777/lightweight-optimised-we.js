/**
 * RemoteAuth Strategy for whatsapp-web.js
 * Stores WhatsApp session data in Supabase database instead of filesystem
 * Solves Render.com ephemeral storage issues
 */

const { db } = require('../config/database');
const logger = require('./logger');
const fs = require('fs').promises;
const path = require('path');
const BaseAuthStrategy = require('whatsapp-web.js/src/authStrategies/BaseAuthStrategy');
const zlib = require('zlib');
const util = require('util');
const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

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
    // Trigger an initial save after auth is ready
    setTimeout(() => this.saveSessionToDb(), 5000);
  }

  /**
   * Required by whatsapp-web.js - Returns paths for session storage
   */
  async extractLocalAuthPaths() {
    return {
      dataPath: this.dataPath,
      clientPath: path.join(this.dataPath, this.accountId)
    };
  }

  async beforeBrowserInitialized() {
    // Create temporary directory for session files
    const sessionPath = path.join(this.dataPath, this.accountId);
    
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.mkdir(sessionPath, { recursive: true });
      
      logger.info(`[RemoteAuth] Temporary session directory created: ${sessionPath}`);

      // CRITICAL: Tell Puppeteer to use this directory for storage
      // This ensures that the browser saves data to the folder we are backing up
      this.client.options.puppeteer = {
        ...this.client.options.puppeteer,
        userDataDir: sessionPath
      };
      
      // Restore session from DB
      await this.restoreSessionFromDb();
      
    } catch (error) {
      logger.error('[RemoteAuth] Error creating temp directory:', error);
    }
  }

  async logout() {
    logger.info(`[RemoteAuth] Logging out account: ${this.accountId}`);
    
    try {
      // Clear session from database
      await db.clearSessionData(this.accountId);
      
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
    // We don't necessarily want to logout on destroy, just clean up local files
    // await this.logout(); 
    
    // Just clean up local files
    const sessionPath = path.join(this.dataPath, this.accountId);
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn('[RemoteAuth] Could not delete temp session files on destroy:', error.message);
    }
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
   * Helper to recursively read files
   */
  async readDirRecursive(dir, baseDir) {
    const files = await fs.readdir(dir, { withFileTypes: true });
    let results = {};

    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (file.isDirectory()) {
        // Optimization: Skip cache directories to reduce database size
        // We only need Local Storage, IndexedDB, and Cookies for the session
        if (['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache', 'Service Worker'].includes(file.name)) {
          continue;
        }
        
        const subResults = await this.readDirRecursive(fullPath, baseDir);
        Object.assign(results, subResults);
      } else {
        // Skip lock files and temporary files
        if (file.name === 'SingletonLock' || file.name.endsWith('.lock') || file.name.startsWith('.org.chromium.')) {
          continue;
        }
        try {
          const content = await fs.readFile(fullPath);
          results[relativePath] = content.toString('base64');
        } catch (err) {
          logger.warn(`[RemoteAuth] Could not read file ${relativePath}: ${err.message}`);
        }
      }
    }
    return results;
  }

  /**
   * Save full session directory to DB with compression
   */
  async saveSessionToDb() {
    try {
      const sessionPath = this.getSessionPath();
      // logger.debug(`[RemoteAuth] Scanning session files in ${sessionPath}`);
      
      // Check if directory exists
      try {
        await fs.access(sessionPath);
      } catch {
        logger.warn(`[RemoteAuth] Session path does not exist: ${sessionPath}`);
        return;
      }

      const files = await this.readDirRecursive(sessionPath, sessionPath);
      const fileCount = Object.keys(files).length;
      
      if (fileCount === 0) {
        logger.warn('[RemoteAuth] No session files found to save');
        return;
      }

      // logger.debug(`[RemoteAuth] Compressing ${fileCount} files...`);
      
      const sessionData = {
        files: files,
        timestamp: Date.now()
      };

      const sessionJson = JSON.stringify(sessionData);
      const compressed = await gzip(sessionJson);
      const compressedBase64 = compressed.toString('base64');

      const storagePayload = JSON.stringify({
        type: 'folder_dump_v2',
        data: compressedBase64
      });
      
      const finalBase64 = Buffer.from(storagePayload).toString('base64');
      
      await db.saveSessionData(this.accountId, finalBase64);
      logger.info(`[RemoteAuth] Session saved to database successfully (${(finalBase64.length / 1024).toFixed(2)}KB)`);
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error saving session to DB:`, error);
    }
  }

  /**
   * Restore session from DB to file system
   */
  async restoreSessionFromDb() {
    try {
      logger.info(`[RemoteAuth] Attempting to restore session for: ${this.accountId}`);
      
      const sessionData = await db.getSessionData(this.accountId);
      
      if (!sessionData) {
        logger.info(`[RemoteAuth] No session found in database for: ${this.accountId}`);
        return false;
      }

      const payloadJson = Buffer.from(sessionData, 'base64').toString('utf-8');
      let payloadObj;
      
      try {
        payloadObj = JSON.parse(payloadJson);
      } catch (e) {
        logger.error('[RemoteAuth] Failed to parse session payload');
        return false;
      }

      let files;

      // Handle V2 (Compressed)
      if (payloadObj.type === 'folder_dump_v2' && payloadObj.data) {
        try {
          const compressedBuffer = Buffer.from(payloadObj.data, 'base64');
          const decompressed = await gunzip(compressedBuffer);
          const sessionObj = JSON.parse(decompressed.toString('utf-8'));
          files = sessionObj.files;
        } catch (err) {
          logger.error('[RemoteAuth] Decompression failed:', err);
          return false;
        }
      } 
      // Handle V1 (Uncompressed)
      else if (payloadObj.type === 'folder_dump') {
        files = payloadObj.files;
      } 
      // Handle Legacy/Unknown
      else {
        logger.warn('[RemoteAuth] Unknown session format, cannot restore');
        return false;
      }

      if (!files) {
        logger.warn('[RemoteAuth] No files found in session data');
        return false;
      }

      const sessionPath = this.getSessionPath();
      const fileCount = Object.keys(files).length;
      
      logger.info(`[RemoteAuth] Restoring ${fileCount} files to ${sessionPath}`);

      for (const [relativePath, contentBase64] of Object.entries(files)) {
        const fullPath = path.join(sessionPath, relativePath);
        const dir = path.dirname(fullPath);
        
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, Buffer.from(contentBase64, 'base64'));
      }
      
      logger.info(`[RemoteAuth] Session restored successfully`);
      return true;
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error restoring session for ${this.accountId}:`, error);
      return false;
    }
  }

  /**
   * Legacy save method (kept for compatibility but redirects to saveSessionToDb)
   */
  async save(session) {
    // We ignore the session object passed here as we want to save the files
    // But we can trigger the file save
    await this.saveSessionToDb();
  }
}

module.exports = RemoteAuth;

