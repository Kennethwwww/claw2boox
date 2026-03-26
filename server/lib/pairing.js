const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'claw2boox.db');
const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DEVICES = 1; // Current limit: 1 device. Change this to support multiple.

let db;

function initDB() {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      manufacturer TEXT NOT NULL,
      model TEXT NOT NULL,
      serial_hash TEXT NOT NULL,
      display_name TEXT,
      paired_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );
  `);

  // Clean up expired pair codes on startup
  cleanExpiredCodes();
}

function cleanExpiredCodes() {
  const cutoff = Date.now() - PAIR_CODE_TTL_MS;
  db.prepare('DELETE FROM pair_codes WHERE created_at < ?').run(cutoff);
}

function generatePairCode() {
  cleanExpiredCodes();

  const devices = db.prepare('SELECT COUNT(*) as count FROM devices').get();
  if (devices.count >= MAX_DEVICES) {
    return { error: `Maximum paired devices reached (${MAX_DEVICES}). Unpair a device first.` };
  }

  // Generate 6-digit numeric code
  const code = String(crypto.randomInt(100000, 999999));

  // Invalidate any existing unused codes
  db.prepare('DELETE FROM pair_codes WHERE used = 0').run();

  db.prepare('INSERT INTO pair_codes (code, created_at) VALUES (?, ?)').run(code, Date.now());

  return { code, expires_in_seconds: PAIR_CODE_TTL_MS / 1000 };
}

function verifyAndPair(code, deviceInfo) {
  cleanExpiredCodes();

  // Validate device is BOOX (manufacturer: ONYX)
  if (!deviceInfo.manufacturer || deviceInfo.manufacturer.toUpperCase() !== 'ONYX') {
    return { error: 'Device verification failed: only BOOX devices are supported.' };
  }

  // Check pair code
  const pairCode = db.prepare('SELECT * FROM pair_codes WHERE code = ? AND used = 0').get(code);
  if (!pairCode) {
    return { error: 'Invalid or expired pairing code.' };
  }

  // Check TTL
  if (Date.now() - pairCode.created_at > PAIR_CODE_TTL_MS) {
    db.prepare('DELETE FROM pair_codes WHERE code = ?').run(code);
    return { error: 'Pairing code has expired.' };
  }

  // Check device limit
  const devices = db.prepare('SELECT COUNT(*) as count FROM devices').get();
  if (devices.count >= MAX_DEVICES) {
    return { error: `Maximum paired devices reached (${MAX_DEVICES}).` };
  }

  // Generate device token
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = crypto.randomUUID();
  const serialHash = crypto.createHash('sha256').update(deviceInfo.serial || '').digest('hex');

  db.prepare(`
    INSERT INTO devices (id, token, manufacturer, model, serial_hash, display_name, paired_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    deviceId,
    token,
    deviceInfo.manufacturer,
    deviceInfo.model || 'Unknown',
    serialHash,
    deviceInfo.displayName || `BOOX ${deviceInfo.model || 'Device'}`,
    new Date().toISOString()
  );

  // Mark code as used
  db.prepare('UPDATE pair_codes SET used = 1 WHERE code = ?').run(code);

  return {
    device_id: deviceId,
    token,
    display_name: deviceInfo.displayName || `BOOX ${deviceInfo.model || 'Device'}`,
  };
}

function validateToken(token) {
  if (!token) return null;
  const device = db.prepare('SELECT * FROM devices WHERE token = ?').get(token);
  if (device) {
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);
  }
  return device || null;
}

function listDevices() {
  return db.prepare('SELECT id, manufacturer, model, display_name, paired_at, last_seen_at FROM devices').all();
}

function unpairDevice(deviceId) {
  const result = db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
  return result.changes > 0;
}

function getDeviceCount() {
  return db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
}

module.exports = {
  initDB,
  generatePairCode,
  verifyAndPair,
  validateToken,
  listDevices,
  unpairDevice,
  getDeviceCount,
  MAX_DEVICES,
};
