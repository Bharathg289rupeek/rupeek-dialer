import { query } from '../db/connection.js';

let _cachedConfig = null;
let _cacheTime = 0;
const CACHE_TTL = 60000; // 1 min

export async function getRoutingConfig() {
  if (_cachedConfig && Date.now() - _cacheTime < CACHE_TTL) return _cachedConfig;
  const res = await query(`SELECT * FROM routing_config WHERE is_active = true LIMIT 1`);
  _cachedConfig = res.rows[0] || null;
  _cacheTime = Date.now();
  return _cachedConfig;
}

export function clearConfigCache() {
  _cachedConfig = null;
  _cacheTime = 0;
}

export function isBusinessHours(config) {
  const tz = process.env.TIMEZONE || 'Asia/Kolkata';
  const now = new Date();
  const istStr = now.toLocaleString('en-US', { timeZone: tz });
  const ist = new Date(istStr);

  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayDay = dayNames[ist.getDay()];
  const days = config?.business_days || ['mon','tue','wed','thu','fri','sat'];
  if (!days.includes(todayDay)) return false;

  const hh = ist.getHours();
  const mm = ist.getMinutes();
  const currentMin = hh * 60 + mm;

  const startParts = (config?.business_hours_start || '09:00').toString().split(':');
  const endParts = (config?.business_hours_end || '18:00').toString().split(':');
  const startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1] || 0);
  const endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1] || 0);

  return currentMin >= startMin && currentMin < endMin;
}

export function getNextBusinessDay(config) {
  const tz = process.env.TIMEZONE || 'Asia/Kolkata';
  const days = config?.business_days || ['mon','tue','wed','thu','fri','sat'];
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const startTime = (config?.business_hours_start || '09:00').toString();

  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(now.getTime() + i * 86400000);
    const dayStr = candidate.toLocaleString('en-US', { timeZone: tz, weekday: 'short' }).toLowerCase().slice(0, 3);
    if (days.includes(dayStr)) {
      const [hh, mm] = startTime.split(':');
      const dateStr = candidate.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
      return new Date(`${dateStr}T${hh}:${mm}:00+05:30`);
    }
  }
  // fallback: tomorrow 9am
  const tomorrow = new Date(now.getTime() + 86400000);
  const dateStr = tomorrow.toLocaleDateString('en-CA', { timeZone: tz });
  return new Date(`${dateStr}T09:00:00+05:30`);
}

export function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('+91')) return cleaned;
  if (cleaned.startsWith('91') && cleaned.length === 12) return '+' + cleaned;
  if (cleaned.length === 10) return '+91' + cleaned;
  return cleaned;
}
