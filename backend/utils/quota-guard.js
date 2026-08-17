// ==========================================================================
// VISION AI — Quota Guard (Shared)
// Single source of truth for checking whether a user can still fire API calls.
// Used by camera-worker.js and gemini-worker.js to avoid duplicate logic.
// ==========================================================================

const { getPlanAlertLimit, getPlanApiLimit } = require('./shared-utils');

/**
 * Checks whether a user has remaining quota for both API calls and alerts.
 *
 * @param {string} userId
 * @param {string} plan  - e.g. 'Free', 'Starter', 'Pro'
 * @param {object} redis - ioredis client
 * @param {object} supabase - supabase-js client
 * @returns {{ allowed: boolean, reason: string, expired: boolean }}
 */
async function checkUserQuota(userId, plan, redis, supabase) {
    const planLower = (plan || 'free').toLowerCase();
    const todayStr = new Date().toISOString().split('T')[0];

    try {
        if (planLower === 'free') {
            const { getWeekKey } = require('./shared-utils');
            const weekKey = getWeekKey();
            const [apiStr, alertStr] = await Promise.all([
                redis.get(`api_usage:user:${userId}:weekly:${weekKey}`),
                redis.get(`alerts_usage:user:${userId}:weekly:${weekKey}`)
            ]);
            const apiUsed    = apiStr   ? parseInt(apiStr, 10)   : 0;
            const alertsUsed = alertStr ? parseInt(alertStr, 10) : 0;
            const apiLimit   = getPlanApiLimit('free');
            const alertLimit = getPlanAlertLimit('free');

            if (apiUsed >= apiLimit || alertsUsed >= alertLimit) {
                return {
                    allowed: false,
                    expired: false,
                    reason: `Free trial weekly quota exhausted (API: ${apiUsed}/${apiLimit}, Alerts: ${alertsUsed}/${alertLimit})`
                };
            }
        } else {
            const alertLimit  = getPlanAlertLimit(plan);
            const apiLimit    = getPlanApiLimit(plan);
            
            const [alertStr, apiStr] = await Promise.all([
                redis.get(`alerts_usage:user:${userId}:daily:${todayStr}`),
                redis.get(`api_usage:user:${userId}:daily:${todayStr}`)
            ]);

            const alertsUsed  = alertStr ? parseInt(alertStr, 10) : 0;
            const apiUsed     = apiStr ? parseInt(apiStr, 10) : 0;

            if (alertsUsed >= alertLimit || apiUsed >= apiLimit) {
                return {
                    allowed: false,
                    expired: false,
                    reason: `Daily quota reached (Alerts: ${alertsUsed}/${alertLimit}, API: ${apiUsed}/${apiLimit})`
                };
            }
        }

        return { allowed: true, expired: false, reason: '' };
    } catch (e) {
        // On error, allow the call through — don't block on Redis/DB failures
        console.error('[QuotaGuard] Error checking quota:', e.message);
        return { allowed: true, expired: false, reason: 'quota-check-error (allowing through)' };
    }
}

/**
 * Increments the alert counter for a user and returns the new count.
 */
async function incrementAlertCount(userId, plan, redis) {
    const planLower = (plan || 'free').toLowerCase();
    const todayStr  = new Date().toISOString().split('T')[0];

    if (planLower === 'free') {
        const { getWeekKey } = require('./shared-utils');
        const weekKey = getWeekKey();
        const count = await redis.incr(`alerts_usage:user:${userId}:weekly:${weekKey}`);
        await redis.expire(`alerts_usage:user:${userId}:weekly:${weekKey}`, 86400 * 8);
        return count;
    } else {
        const count = await redis.incr(`alerts_usage:user:${userId}:daily:${todayStr}`);
        await redis.expire(`alerts_usage:user:${userId}:daily:${todayStr}`, 86400 * 2);
        return count;
    }
}

module.exports = { checkUserQuota, incrementAlertCount };
