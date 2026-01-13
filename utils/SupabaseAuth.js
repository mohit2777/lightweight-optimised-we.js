/**
 * SupabaseAuth - Reliable WhatsApp session storage in Supabase
 * Optimized version - minimal RAM usage, reliable persistence
 */

const logger = require('./logger');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const BaseAuthStrategy = require('whatsapp-web.js/src/authStrategies/BaseAuthStrategy');
const zlib = require('zlib');
const util = require('util');

const gzip = util.promisify(zlib.gzip);
const gunzip = util.promisify(zlib.gunzip);

// Lazy load db to support both full and lite mode
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

// Limits
const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB max
const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3MB per file

// Only essential dirs for WhatsApp session
const ESSENTIAL_DIRS = ['IndexedDB', 'Local Storage'];

/**
 * Pre-restore session from Supabase before client init
 * Call this BEFORE creating the Client
 */
async function preRestoreSession(accountId, dataPath = './wa-sessions-temp') {
  const sessionPath = path.join(dataPath, accountId);

  try {
    await fs.mkdir(dataPath, { recursive: true });
    await fs.mkdir(sessionPath, { recursive: true });

    logger.info(`[Session] Checking Supabase for: ${accountId}`);

    const db = getDb();
    const sessionData = await db.getSessionData(accountId);
    if (!sessionData) {
      logger.info(`[Session] No saved session for: ${accountId}`);
      return { restored: false, sessionPath };
    }

    // Decode outer wrapper
    let payloadJson;
    try {
      payloadJson = Buffer.from(sessionData, 'base64').toString('utf-8');
    } catch (e) {
      logger.error('[Session] Failed to decode base64');
      await getDb().clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (e) {
      logger.error('[Session] Corrupted session JSON');
      await getDb().clearSessionData(accountId);
      return { restored: false, sessionPath };
    }

    let files;

    // Decompress session data
    if (payload.data) {
      try {
        const compressed = Buffer.from(payload.data, 'base64');
        const decompressed = await gunzip(compressed);
        const sessionObj = JSON.parse(decompressed.toString('utf-8'));
        files = sessionObj.files;
      } catch (err) {
        logger.error('[Session] Decompression failed:', err.message);
        await getDb().clearSessionData(accountId);
        return { restored: false, sessionPath };
      }
    } else {
      logger.warn('[Session] Unknown format');
      return { restored: false, sessionPath };
    }

    if (!files || Object.keys(files).length === 0) {
      logger.warn('[Session] Empty session');
      return { restored: false, sessionPath };
    }

    const fileCount = Object.keys(files).length;
    logger.info(`[Session] Restoring ${fileCount} files...`);

    let restored = 0;
    for (const [relPath, b64Content] of Object.entries(files)) {
      try {
        const fullPath = path.join(sessionPath, relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, Buffer.from(b64Content, 'base64'));
        restored++;
      } catch (e) {
        logger.warn(`[Session] Failed to restore: ${relPath}`);
      }
    }

    logger.info(`[Session] ✅ Restored ${restored}/${fileCount} files`);
    return { restored: true, sessionPath };

  } catch (error) {
    logger.error(`[Session] Restore error:`, error.message);
    return { restored: false, sessionPath };
  }
}

function hasPreRestoredSession(sessionPath) {
  try {
    const indexedDb = path.join(sessionPath, 'Default', 'IndexedDB');
    if (fsSync.existsSync(indexedDb)) {
      const files = fsSync.readdirSync(indexedDb);
      return files.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

class SupabaseAuth extends BaseAuthStrategy {
  constructor(options = {}) {
    super();
    this.accountId = options.accountId;
    this.clientId = options.accountId;
    this.dataPath = options.dataPath || './wa-sessions-temp';
    this.saveTimer = null;
    this.isSaving = false;

    if (!this.accountId) {
      throw new Error('accountId is required');
    }
  }

  // Static method for pre-restore
  static preRestoreSession = preRestoreSession;

  setup(client) {
    super.setup(client);
  }

  async afterAuthReady() {
    logger.info(`[Session] Auth ready for ${this.accountId}`);

    // Wait 60 seconds for session stability (official recommendation)
    logger.info(`[Session] Waiting 60s for session stability...`);

    this.saveTimer = setTimeout(async () => {
      logger.info(`[Session] Initial save starting...`);
      await this.saveSession();
    }, 60000);
  }

  async beforeBrowserInitialized() {
    const sessionPath = path.join(this.dataPath, this.accountId);

    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.mkdir(sessionPath, { recursive: true });

      logger.info(`[Session] Data dir: ${sessionPath}`);

      this.client.options.puppeteer = {
        ...this.client.options.puppeteer,
        userDataDir: sessionPath
      };

      // Check if already restored
      if (hasPreRestoredSession(sessionPath)) {
        logger.info(`[Session] Session files already exist`);
        return;
      }

      // Try to restore from Supabase
      logger.info(`[Session] No local files, restoring from Supabase...`);
      await preRestoreSession(this.accountId, this.dataPath);

    } catch (error) {
      logger.error('[Session] Setup error:', error.message);
    }
  }

  async logout() {
    logger.info(`[Session] Logout for ${this.accountId}`);
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }

  async destroy() {
    logger.info(`[Session] Destroy for ${this.accountId}`);
    if (this.saveTimer) clearTimeout(this.saveTimer);

    try {
      await fs.rm(path.join(this.dataPath, this.accountId), { recursive: true, force: true });
    } catch (e) {}
  }

  /**
   * Collect essential files only (IndexedDB + Local Storage)
   */
  async collectEssentialFiles(sessionPath) {
    const files = {};
    let totalSize = 0;

    const defaultPath = path.join(sessionPath, 'Default');

    for (const essentialDir of ESSENTIAL_DIRS) {
      const dirPath = path.join(defaultPath, essentialDir);

      try {
        await fs.access(dirPath);
      } catch {
        continue;
      }

      const stats = { totalSize: 0 };
      await this.collectDirFiles(dirPath, sessionPath, files, stats);
      totalSize += stats.totalSize;
    }

    return { files, totalSize };
  }

  async collectDirFiles(dir, baseDir, files, stats) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (stats.totalSize > MAX_TOTAL_SIZE) break;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath);

        if (entry.isDirectory()) {
          await this.collectDirFiles(fullPath, baseDir, files, stats);
        } else {
          // Skip lock files
          if (['LOCK', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) {
            continue;
          }

          try {
            const stat = await fs.stat(fullPath);
            if (stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;

            const content = await fs.readFile(fullPath);
            files[relPath] = content.toString('base64');
            stats.totalSize += content.length;
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    } catch (error) {
      // Dir doesn't exist
    }
  }

  async saveSession() {
    if (this.isSaving) {
      logger.info(`[Session] Save already in progress`);
      return false;
    }

    this.isSaving = true;

    try {
      const sessionPath = path.join(this.dataPath, this.accountId);
      const defaultPath = path.join(sessionPath, 'Default');

      try {
        await fs.access(defaultPath);
      } catch {
        logger.warn(`[Session] No Default folder`);
        return false;
      }

      logger.info(`[Session] Collecting files...`);
      const { files, totalSize } = await this.collectEssentialFiles(sessionPath);
      const fileCount = Object.keys(files).length;

      if (fileCount === 0) {
        logger.warn('[Session] No essential files found');
        return false;
      }

      logger.info(`[Session] Got ${fileCount} files (${(totalSize / 1024).toFixed(0)}KB)`);

      // Compress
      const data = { files, ts: Date.now(), id: this.accountId };
      const json = JSON.stringify(data);
      const compressed = await gzip(json);

      const payload = JSON.stringify({
        type: 'session_v5',
        data: compressed.toString('base64'),
        saved: new Date().toISOString()
      });

      const final = Buffer.from(payload).toString('base64');
      const sizeKB = (final.length / 1024).toFixed(2);

      logger.info(`[Session] Saving ${sizeKB}KB to Supabase...`);
      await getDb().saveSessionData(this.accountId, final);
      logger.info(`[Session] ✅ Saved (${sizeKB}KB, ${fileCount} files)`);

      return true;
    } catch (error) {
      logger.error(`[Session] Save error:`, error.message);
      return false;
    } finally {
      this.isSaving = false;
    }
  }
}

module.exports = { SupabaseAuth, preRestoreSession };
