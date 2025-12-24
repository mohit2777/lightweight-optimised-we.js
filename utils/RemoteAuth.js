/**
 * RemoteAuth Strategy for whatsapp-web.js
 * Stores WhatsApp session data in Supabase database instead of filesystem
 * Solves Render.com ephemeral storage issues
 */

const { db } = require('../config/database');
const logger = require('./logger');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const BaseAuthStrategy = require('whatsapp-web.js/src/authStrategies/BaseAuthStrategy');
const zlib = require('zlib');
const util = require('util');
const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

/**
 * Pre-restore session files from database BEFORE client initialization
 * This is called from whatsappManager BEFORE creating the Client
 * @param {string} accountId - The account ID
 * @param {string} dataPath - Base path for session storage
 * @returns {Promise<{restored: boolean, sessionPath: string}>}
 */
async function preRestoreSession(accountId, dataPath = './wa-sessions-temp') {
  const sessionPath = path.join(dataPath, accountId);
  
  try {
    // Create directories
    await fs.mkdir(dataPath, { recursive: true });
    await fs.mkdir(sessionPath, { recursive: true });
    
    logger.info(`[PreRestore] Checking session for: ${accountId}`);
    
    const sessionData = await db.getSessionData(accountId);
    
    if (!sessionData) {
      logger.info(`[PreRestore] No session found in database for: ${accountId}`);
      return { restored: false, sessionPath };
    }

    const payloadJson = Buffer.from(sessionData, 'base64').toString('utf-8');
    let payloadObj;
    
    try {
      payloadObj = JSON.parse(payloadJson);
    } catch (e) {
      logger.error('[PreRestore] Failed to parse session payload');
      return { restored: false, sessionPath };
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
        logger.error('[PreRestore] Decompression failed:', err);
        return { restored: false, sessionPath };
      }
    } 
    // Handle V1 (Uncompressed)
    else if (payloadObj.type === 'folder_dump') {
      files = payloadObj.files;
    } 
    // Handle Legacy/Unknown
    else {
      logger.warn('[PreRestore] Unknown session format, cannot restore');
      return { restored: false, sessionPath };
    }

    if (!files || Object.keys(files).length === 0) {
      logger.warn('[PreRestore] No files found in session data');
      return { restored: false, sessionPath };
    }

    const fileCount = Object.keys(files).length;
    logger.info(`[PreRestore] Restoring ${fileCount} files to ${sessionPath}`);

    // Write all files
    for (const [relativePath, contentBase64] of Object.entries(files)) {
      const fullPath = path.join(sessionPath, relativePath);
      const dir = path.dirname(fullPath);
      
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, Buffer.from(contentBase64, 'base64'));
    }
    
    logger.info(`[PreRestore] Session restored successfully for ${accountId}`);
    return { restored: true, sessionPath };
    
  } catch (error) {
    logger.error(`[PreRestore] Error restoring session for ${accountId}:`, error);
    return { restored: false, sessionPath };
  }
}

/**
 * Check if session files already exist (pre-restored)
 */
function hasPreRestoredSession(sessionPath) {
  try {
    // Check for key session files that indicate valid pre-restored session
    const defaultPath = path.join(sessionPath, 'Default');
    const localStoragePath = path.join(defaultPath, 'Local Storage', 'leveldb');
    
    // Check if directory exists and has CURRENT file (LevelDB marker)
    if (fsSync.existsSync(localStoragePath)) {
      const files = fsSync.readdirSync(localStoragePath);
      const hasLevelDB = files.some(f => f === 'CURRENT' || f.endsWith('.ldb'));
      if (hasLevelDB) {
        logger.info(`[RemoteAuth] Pre-restored session detected at ${sessionPath}`);
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
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
      
      logger.info(`[RemoteAuth] Setting userDataDir: ${sessionPath}`);

      // CRITICAL: Tell Puppeteer to use this directory for storage
      // This ensures that the browser saves data to the folder we are backing up
      this.client.options.puppeteer = {
        ...this.client.options.puppeteer,
        userDataDir: sessionPath
      };
      
      // Check if session was already pre-restored (by whatsappManager)
      // If so, skip DB fetch to avoid timing issues
      if (hasPreRestoredSession(sessionPath)) {
        logger.info(`[RemoteAuth] Session already pre-restored, skipping DB fetch`);
        return;
      }
      
      // Fallback: try to restore from DB if not pre-restored
      // (This is slow and may not finish before browser needs the files)
      logger.warn(`[RemoteAuth] Session not pre-restored, attempting DB restore (may be slow)...`);
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
   * Helper to recursively read files with size limits
   */
  async readDirRecursive(dir, baseDir, stats = { totalSize: 0, fileCount: 0 }) {
    const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB max total session size
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB max per file
    
    const files = await fs.readdir(dir, { withFileTypes: true });
    let results = {};

    for (const file of files) {
      // Stop if we've exceeded max size
      if (stats.totalSize > MAX_TOTAL_SIZE) {
        logger.warn(`[RemoteAuth] Session size limit reached (${(stats.totalSize / 1024 / 1024).toFixed(2)}MB), stopping collection`);
        break;
      }
      
      const fullPath = path.join(dir, file.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (file.isDirectory()) {
        // Skip non-essential cache directories - be more aggressive to save memory
        const skipDirs = [
          'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnCache',
          'blob_storage', 'VideoDecodeStats', 'shared_proto_db', 'WebStorage',
          'Crashpad', 'BrowserMetrics'
        ];
        if (skipDirs.includes(file.name)) {
          continue;
        }
        
        const subResults = await this.readDirRecursive(fullPath, baseDir, stats);
        Object.assign(results, subResults);
      } else {
        // Skip lock files, logs, and temporary files
        const skipFiles = ['SingletonLock', 'LOCK', 'lockfile', 'LOG', 'LOG.old', 'DevToolsActivePort'];
        const skipExtensions = ['.lock', '.log', '-journal', '.tmp'];
        
        if (skipFiles.includes(file.name) || 
            skipExtensions.some(ext => file.name.endsWith(ext)) ||
            file.name.startsWith('.org.chromium.') ||
            (file.name.startsWith('.') && file.name !== '.'))
        {
          continue;
        }
        
        // Check file size before reading
        try {
          const fileStat = await fs.stat(fullPath);
          if (fileStat.size > MAX_FILE_SIZE) {
            logger.debug(`[RemoteAuth] Skipping large file: ${relativePath} (${(fileStat.size / 1024).toFixed(0)}KB)`);
            continue;
          }
          if (fileStat.size === 0) {
            continue; // Skip empty files
          }
        } catch (e) {
          continue;
        }
        
        // Read file with retry logic
        let content = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            content = await fs.readFile(fullPath);
            break;
          } catch (err) {
            if (err.code === 'EBUSY' && attempt < 1) {
              await new Promise(r => setTimeout(r, 100));
              continue;
            }
            break;
          }
        }
        
        if (content) {
          stats.totalSize += content.length;
          stats.fileCount++;
          results[relativePath] = content.toString('base64');
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
      // Check memory before starting
      const memUsage = process.memoryUsage();
      const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
      if (heapUsedMB > 400) {
        logger.warn(`[RemoteAuth] Memory too high (${heapUsedMB.toFixed(0)}MB), skipping session save`);
        return;
      }
      
      const sessionPath = this.getSessionPath();
      // logger.debug(`[RemoteAuth] Scanning session files in ${sessionPath}`);
      
      // Check if directory exists
      try {
        await fs.access(sessionPath);
      } catch {
        logger.warn(`[RemoteAuth] Session path does not exist: ${sessionPath}`);
        return;
      }

      logger.info(`[RemoteAuth] Collecting session files from ${sessionPath}...`);
      const stats = { totalSize: 0, fileCount: 0 };
      const files = await this.readDirRecursive(sessionPath, sessionPath, stats);
      const fileCount = Object.keys(files).length;
      const fileNames = Object.keys(files);
      
      logger.info(`[RemoteAuth] Collected ${fileCount} files (${(stats.totalSize / 1024).toFixed(0)}KB raw)`);
      
      if (fileCount === 0) {
        logger.warn('[RemoteAuth] No session files found to save');
        return;
      }
      
      // Validate we have essential session files (Cookies or IndexedDB data)
      const hasEssentialFiles = fileNames.some(f => 
        f.includes('Cookies') || 
        f.includes('IndexedDB') || 
        f.includes('Local Storage') ||
        f.includes('leveldb')
      );
      
      if (!hasEssentialFiles) {
        logger.warn(`[RemoteAuth] Session incomplete - missing essential files (found: ${fileCount} files)`);
        return;
      }

      logger.info(`[RemoteAuth] Compressing ${fileCount} files...`);
      
      const sessionData = {
        files: files,
        timestamp: Date.now()
      };

      // Use try-catch for JSON stringify (can fail with circular refs)
      let sessionJson;
      try {
        sessionJson = JSON.stringify(sessionData);
      } catch (e) {
        logger.error(`[RemoteAuth] Failed to stringify session data:`, e.message);
        return;
      }
      
      logger.info(`[RemoteAuth] JSON size: ${(sessionJson.length / 1024).toFixed(0)}KB, compressing...`);
      
      const compressed = await gzip(sessionJson);
      
      // Free up memory
      sessionJson = null;
      
      const compressedBase64 = compressed.toString('base64');

      const storagePayload = JSON.stringify({
        type: 'folder_dump_v2',
        data: compressedBase64
      });
      
      const finalBase64 = Buffer.from(storagePayload).toString('base64');
      
      // Free up memory before DB call
      const finalSize = finalBase64.length;
      
      logger.info(`[RemoteAuth] Saving to database (${(finalSize / 1024).toFixed(2)}KB compressed)...`);
      
      await db.saveSessionData(this.accountId, finalBase64);
      
      logger.info(`[RemoteAuth] ✅ Session saved successfully (${(finalSize / 1024).toFixed(2)}KB)`);
      
      // Trigger garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
    } catch (error) {
      logger.error(`[RemoteAuth] Error saving session to DB:`, error.message);
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

// Export both the class and the pre-restore function
module.exports = RemoteAuth;
module.exports.preRestoreSession = preRestoreSession;
module.exports.hasPreRestoredSession = hasPreRestoredSession;

