const { Queue } = require('bullmq');
const Redis = require('ioredis');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── Redis connection — URL loaded from .env (REDIS_URL) ──────────────────────
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    console.error('[QueueManager] CRITICAL: REDIS_URL is not set in .env. Aborting.');
    process.exit(1);
}

const redisConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    // Retry up to 60 times with up to 2s between retries
    retryStrategy(times) {
        if (times > 60) {
            console.error('[QueueManager] Redis: max retries exceeded, giving up.');
            return null;
        }
        return Math.min(times * 200, 2000);
    },
    reconnectOnError(err) {
        return err.message.includes('READONLY');
    }
});

redisConnection.on('connect', () => console.log('[QueueManager] Redis Cloud connected.'));
redisConnection.on('ready', () => console.log('[QueueManager] Redis Cloud ready ✅'));
redisConnection.on('error', (err) => console.error('[QueueManager] Redis error:', err.message));
redisConnection.on('reconnecting', () => console.log('[QueueManager] Redis reconnecting...'));

// BullMQ Queue for Gemini jobs
const geminiQueue = new Queue('gemini-tasks', { connection: redisConnection });

/**
 * Track a successful API request in the global usage budget.
 * This is the single source of truth for global counters.
 */
async function trackApiUsage() {
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7); // e.g., '2026-07'
    const monthlyKey = `api_usage:monthly:${month}`;
    const dailyKey = `api_usage:daily:${today}`;
    await Promise.all([
        redisConnection.incr(monthlyKey).then(() => redisConnection.expire(monthlyKey, 86400 * 60)), // 60-day TTL
        redisConnection.incr(dailyKey).then(() => redisConnection.expire(dailyKey, 86400 * 2))
    ]);
}

module.exports = {
    redisConnection,
    geminiQueue,
    trackApiUsage
};
