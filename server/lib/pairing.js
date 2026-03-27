const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAW2BOOX_DATA_DIR || path.join(require('os').homedir(), '.claw2boox');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DEVICES = 1; // Current limit: 1 device. Change this to support multiple.

// In-memory store, persisted to JSON file
let store = {
  devices: [],    // { id, token, manufacturer, model, serial_hash, display_name, paired_at, last_seen_at }
  pairCodes: [],  // { code, created_at, used }
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      // Ensure arrays exist (backward compat)
      if (!Array.isArray(store.devices)) store.devices = [];
      if (!Array.isArray(store.pairCodes)) store.pairCodes = [];
    }
  } catch (e) {
    console.warn('[pairing] Could not load data file, starting fresh:', e.message);
    store = { devices: [], pairCodes: [] };
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e) {
    console.error('[pairing] Failed to save data:', e.message);
  }
}

function initDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  load();
  cleanExpiredCodes();
}

function cleanExpiredCodes() {
  const cutoff = Date.now() - PAIR_CODE_TTL_MS;
  const before = store.pairCodes.length;
  store.pairCodes = store.pairCodes.filter((c) => c.created_at >= cutoff);
  if (store.pairCodes.length !== before) save();
}

function generatePairCode() {
  cleanExpiredCodes();

  if (store.devices.length >= MAX_DEVICES) {
    return { error: `Maximum paired devices reached (${MAX_DEVICES}). Unpair a device first.` };
  }

  // Generate 6-digit numeric code
  const code = String(crypto.randomInt(100000, 999999));

  // Invalidate any existing unused codes
  store.pairCodes = store.pairCodes.filter((c) => c.used);

  store.pairCodes.push({ code, created_at: Date.now(), used: false });
  save();

  return { code, expires_in_seconds: PAIR_CODE_TTL_MS / 1000 };
}

function verifyAndPair(code, deviceInfo) {
  cleanExpiredCodes();

  // Validate device is BOOX (manufacturer: ONYX)
  if (!deviceInfo.manufacturer || deviceInfo.manufacturer.toUpperCase() !== 'ONYX') {
    return { error: 'Device verification failed: only BOOX devices are supported.' };
  }

  // Check pair code
  const pairCode = store.pairCodes.find((c) => c.code === code && !c.used);
  if (!pairCode) {
    return { error: 'Invalid or expired pairing code.' };
  }

  // Check TTL
  if (Date.now() - pairCode.created_at > PAIR_CODE_TTL_MS) {
    store.pairCodes = store.pairCodes.filter((c) => c.code !== code);
    save();
    return { error: 'Pairing code has expired.' };
  }

  // Check device limit
  if (store.devices.length >= MAX_DEVICES) {
    return { error: `Maximum paired devices reached (${MAX_DEVICES}).` };
  }

  // Generate device token
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = crypto.randomUUID();
  const serialHash = crypto.createHash('sha256').update(deviceInfo.serial || '').digest('hex');

  const device = {
    id: deviceId,
    token,
    manufacturer: deviceInfo.manufacturer,
    model: deviceInfo.model || 'Unknown',
    serial_hash: serialHash,
    display_name: deviceInfo.displayName || `BOOX ${deviceInfo.model || 'Device'}`,
    paired_at: new Date().toISOString(),
    last_seen_at: null,
  };

  store.devices.push(device);

  // Mark code as used
  pairCode.used = true;
  save();

  return {
    device_id: deviceId,
    token,
    display_name: device.display_name,
  };
}

function validateToken(token) {
  if (!token) return null;
  const device = store.devices.find((d) => d.token === token);
  if (device) {
    device.last_seen_at = new Date().toISOString();
    // Debounce saves — don't write on every request
    if (!validateToken._saveTimer) {
      validateToken._saveTimer = setTimeout(() => {
        save();
        validateToken._saveTimer = null;
      }, 10000);
    }
  }
  return device || null;
}

function listDevices() {
  return store.devices.map(({ id, manufacturer, model, display_name, paired_at, last_seen_at }) => ({
    id, manufacturer, model, display_name, paired_at, last_seen_at,
  }));
}

function unpairDevice(deviceId) {
  const before = store.devices.length;
  store.devices = store.devices.filter((d) => d.id !== deviceId);
  if (store.devices.length !== before) {
    save();
    return true;
  }
  return false;
}

function getDeviceCount() {
  return store.devices.length;
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
