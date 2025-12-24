/**
 * RemoteAuth Strategy for whatsapp-web.js
 * Stores WhatsApp session data in Supabase database
 * 
 * SIMPLIFIED & ROBUST VERSION - Saves ALL essential session files
 * No aggressive filtering - captures everything needed for session persistence
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

// Session size limits
const MAX_TOTAL_SIZE = 5 * 1024 * 1024; // 5MB max total
const MAX_FILE_SIZE = 1024 * 1024; // 1MB max per file

/**
 * Pre-restore session files from database BEFORE client initialization
 * Called from whatsappManager BEFORE creating the Client
 */
async function preRestoreSession(accountId, dataPath = './wa-sessions-temp') {
  const sessionPath = path.join(dataPath, accountId);
  
  try {
    await fs.mkdir(dataPath, { recursive: true });
    await fs.mkdir(sessionPath, { recursive: true });
    
    logger.info(`[Session] Checking database for session: ${accountId}`);
    
    const sessionData = await db.getSessionData(accountId);
    
    if (!sessionData) {
      logger.info(`[Session] No saved session found for: ${accountId}`);
      return { restored: false, sessionPath };
    }

    // Decode and parse
    const payloadJson = Buffer.from(sessionData, 'base64').toString('utf-8');
    let payloadObj;
    
    try {
      payloadObj = JSON.parse(payloadJson);
    } catch (e) {
      logger.error('[Session] Failed to parse session data - corrupted');
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    let files;

    // Handle compressed format (V2)
    if (payloadObj.type === 'session_v2' && payloadObj.data) {
      try {
        const compressedBuffer = Buffer.from(payloadObj.data, 'base64');
        const decompressed = await gunzip(compressedBuffer);
        const sessionObj = JSON.parse(decompressed.toString('utf-8'));
        files = sessionObj.files;
        logger.info(`[Session] Decompressed session: ${Object.keys(files).length} files`);
      } catch (err) {
        logger.error('[Session] Decompression failed:', err.message);
        await db.clearSessionData(accountId);
        return { restored: false, sessionPath };
      }
    } 
    // Handle legacy formats
    else if (payloadObj.type === 'folder_dump_v2' && payloadObj.data) {
      try {
        const compressedBuffer = Buffer.from(payloadObj.data, 'base64');
        const decompressed = await gunzip(compressedBuffer);
        const sessionObj = JSON.parse(decompressed.toString('utf-8'));
        files = sessionObj.files;
      } catch (err) {
        logger.error('[Session] Legacy decompression failed');
        await db.clearSessionData(accountId);
        return { restored: false, sessionPath };
      }
    }
    else if (payloadObj.type === 'folder_dump') {
      files = payloadObj.files;
    }
    else {
      logger.warn('[Session] Unknown session format');
      await db.clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    if (!files || Object.keys(files).length === 0) {
      logger.warn('[Session] Empty session data');
      return { restored: false, sessionPath };
    }

    const fileCount = Object.keys(files).length;
    logger.info(`[Session] Restoring ${fileCount} files to disk...`);

    // Restore all files
    let restoredCount = 0;
    for (const [relativePath, contentBase64] of Object.entries(files)) {
      try {
        const fullPath = path.join(sessionPath, relativePath);
        const dir = path.dirname(fullPath);
        
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, Buffer.from(contentBase64, 'base64'));
        restoredCount++;
      } catch (err) {
        logger.warn(`[Session] Failed to restore file: ${relativePath}`);
      }
    }
    
    logger.info(`[Session] ✅ Restored ${restoredCount}/${fileCount} files for ${accountId}`);
    return { restored: true, sessionPath };
    
  } catch (error) {
    logger.error(`[Session] Restore error for ${accountId}:`, error.message);
    return { restored: false, sessionPath };
  }
}

/**
 * Check if session files exist on disk
 */
function hasPreRestoredSession(sessionPath) {
  try {
    // Check for IndexedDB - the key WhatsApp storage
    const indexedDbPath = path.join(sessionPath, 'Default', 'IndexedDB');
    if (fsSync.existsSync(indexedDbPath)) {
      const contents = fsSync.readdirSync(indexedDbPath);
      if (contents.length > 0) {
        logger.info(`[Session] Found existing session files at ${sessionPath}`);
        return true;
      }
    }
    
    // Also check Local Storage
    const localStoragePath = path.join(sessionPath, 'Default', 'Local Storage', 'leveldb');
    if (fsSync.existsSync(localStoragePath)) {
      const files = fsSync.readdirSync(localStoragePath);
      if (files.length > 0) {
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
    this.clientId = options.accountId;
    this.dataPath = options.dataPath || './wa-sessions-temp';
    this.sessionRestored = false;
    
    if (!this.accountId) {
      throw new Error('accountId is required for RemoteAuth');
    }
  }

  setup(client) {
    super.setup(client);
  }

  async afterAuthReady() {
    logger.info(`[Session] Auth ready for ${this.accountId}`);
    // Save session after authentication
    setTimeout(() => this.saveSession(), 3000);
  }

  async beforeBrowserInitialized() {
    const sessionPath = path.join(this.dataPath, this.accountId);
    
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.mkdir(sessionPath, { recursive: true });
      
      logger.info(`[Session] Using data directory: ${sessionPath}`);

      // Set Chrome to use this directory
      this.client.options.puppeteer = {
        ...this.client.options.puppeteer,
        userDataDir: sessionPath
      };
      
      // Check if already restored
      if (hasPreRestoredSession(sessionPath)) {
        logger.info(`[Session] Session already on disk, ready to use`);
        this.sessionRestored = true;
        return;
      }
      
      // Try to restore from database
      logger.info(`[Session] No local session, checking database...`);
      const result = await preRestoreSession(this.accountId, this.dataPath);
      this.sessionRestored = result.restored;
      
    } catch (error) {
      logger.error('[Session] Setup error:', error.message);
    }
  }

  async logout() {
    logger.info(`[Session] Logout called for ${this.accountId} - preserving session data`);
    // Do NOT clear session data automatically
    // Only clear local temp files
    const sessionPath = path.join(this.dataPath, this.accountId);
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  }

  async destroy() {
    logger.info(`[Session] Destroy called for ${this.accountId}`);
    // Clean local files only
    const sessionPath = path.join(this.dataPath, this.accountId);
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  }

  getSessionPath() {
    return path.join(this.dataPath, this.accountId);
  }

  /**
   * Collect all session files - simplified and robust
   * Focuses on what WhatsApp actually needs: IndexedDB, LocalStorage, Cookies
   */
  async collectSessionFiles(dir, baseDir, stats = { totalSize: 0, files: {} }) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (stats.totalSize > MAX_TOTAL_SIZE) {
          logger.warn(`[Session] Size limit reached: ${(stats.totalSize / 1024 / 1024).toFixed(2)}MB`);
          break;
        }
        
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        
        if (entry.isDirectory()) {
          // Include these directories
          const includeDirs = [
            'Default',
            'IndexedDB',
            'Local Storage',
            'Session Storage',
            'leveldb',
            'https_web.whatsapp.com_0.indexeddb.leveldb'
          ];
          
          // Skip these directories (cache, not needed for auth)
          const skipDirs = [
            'Cache', 
            'Code Cache', 
            'GPUCache', 
            'DawnCache',
            'ShaderCache',
            'GrShaderCache',
            'blob_storage',
            'shared_proto_db',
            'VideoDecodeStats',
            'WebStorage',
            'Crashpad',
            'Service Worker',
            'Network',
            'optimization_guide_model_store'
          ];
          
          if (skipDirs.includes(entry.name)) {
            continue;
          }
          
          // Recurse into Default or any included directory
          if (entry.name === 'Default' || includeDirs.includes(entry.name)) {
            await this.collectSessionFiles(fullPath, baseDir, stats);
          }
        } else {
          // Skip these files (temporary/lock files)
          const skipFiles = [
            'SingletonLock',
            'SingletonCookie', 
            'SingletonSocket',
            'DevToolsActivePort'
          ];
          
          // Skip these extensions
          const skipExtensions = [
            '-journal',
            '.tmp'
          ];
          
          if (skipFiles.includes(entry.name)) continue;
          if (skipExtensions.some(ext => entry.name.endsWith(ext))) continue;
          if (entry.name.startsWith('.')) continue;
          
          // Check file size
          try {
            const fileStat = await fs.stat(fullPath);
            if (fileStat.size === 0) continue;
            if (fileStat.size > MAX_FILE_SIZE) {
              logger.debug(`[Session] Skipping large file: ${relativePath} (${(fileStat.size/1024).toFixed(0)}KB)`);
              continue;
            }
            
            // Read file
            const content = await fs.readFile(fullPath);
            stats.files[relativePath] = content.toString('base64');
            stats.totalSize += content.length;
          } catch (err) {
            // Skip files we can't read (locked, etc)
            continue;
          }
        }
      }
      
      return stats;
    } catch (error) {
      logger.error(`[Session] Error collecting files:`, error.message);
      return stats;
    }
  }

  /**
   * Save session to database
   */
  async saveSession() {
    try {
      const sessionPath = this.getSessionPath();
      
      // Verify directory exists
      try {
        await fs.access(sessionPath);
      } catch {
        logger.warn(`[Session] No session directory found: ${sessionPath}`);
        return false;
      }

      logger.info(`[Session] Collecting session files...`);
      const stats = await this.collectSessionFiles(sessionPath, sessionPath);
      const fileCount = Object.keys(stats.files).length;
      
      if (fileCount === 0) {
        logger.warn('[Session] No files collected');
        return false;
      }
      
      // Verify we have essential files
      const fileNames = Object.keys(stats.files);
      const hasIndexedDB = fileNames.some(f => f.includes('IndexedDB'));
      const hasLocalStorage = fileNames.some(f => f.includes('Local Storage'));
      
      if (!hasIndexedDB && !hasLocalStorage) {
        logger.warn(`[Session] Missing essential files (IndexedDB or LocalStorage)`);
        logger.debug(`[Session] Files collected: ${fileNames.join(', ')}`);
        return false;
      }

      logger.info(`[Session] Collected ${fileCount} files (${(stats.totalSize/1024).toFixed(0)}KB)`);
      
      // Compress
      const sessionData = {
        files: stats.files,
        timestamp: Date.now(),
        accountId: this.accountId
      };
      
      const jsonString = JSON.stringify(sessionData);
      const compressed = await gzip(jsonString);
      const compressedBase64 = compressed.toString('base64');
      
      // Wrap in storage format
      const payload = JSON.stringify({
        type: 'session_v2',
        data: compressedBase64,
        savedAt: new Date().toISOString()
      });
      
      const finalBase64 = Buffer.from(payload).toString('base64');
      const finalSizeKB = (finalBase64.length / 1024).toFixed(2);
      
      logger.info(`[Session] Saving to database (${finalSizeKB}KB compressed)...`);
      
      await db.saveSessionData(this.accountId, finalBase64);
      
      logger.info(`[Session] ✅ Session saved successfully (${finalSizeKB}KB, ${fileCount} files)`);
      return true;
      
    } catch (error) {
      logger.error(`[Session] Save error:`, error.message);
      return false;
    }
  }

  /**
   * Restore session from database (used if pre-restore didn't happen)
   */
  async restoreSession() {
    return await preRestoreSession(this.accountId, this.dataPath);
  }
}

module.exports = {
  RemoteAuth,
  preRestoreSession,
  hasPreRestoredSession
};

