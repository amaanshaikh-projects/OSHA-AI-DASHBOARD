const { redisConnection } = require('./queue-manager.js');
const { getPlanApiLimit } = require('../utils/shared-utils.js');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

class QuotaManager {
    /**
     * Recalculates the per-camera allocation for all active cameras of a user.
     * Must be called whenever cameras are added, removed, enabled, or disabled, or when plan changes.
     */
    async recalculateAllocation(userId) {
        try {
            // Get user's active cameras
            const { data: cameras } = await supabase
                .from('cameras')
                .select('id')
                .eq('user_id', userId)
                .eq('status', 'Online')
                .order('id', { ascending: true }); // Deterministic ordering

            const activeCount = cameras ? cameras.length : 0;
            if (activeCount === 0) return;

            // Get user's plan
            const { data: profile } = await supabase
                .from('profiles')
                .select('subscription_plan, subscription_status')
                .eq('id', userId)
                .single();

            const plan = profile?.subscription_plan || 'Free';
            // If Free or expired, skip complex allocation
            if (plan.toLowerCase() === 'free' || profile?.subscription_status === 'Trial Expired') return;

            const totalQuota = getPlanApiLimit(plan);
            
            const baseAllocation = Math.floor(totalQuota / activeCount);
            let remainder = totalQuota % activeCount;

            const todayStr = this._getResetDateString();

            for (let i = 0; i < cameras.length; i++) {
                const camId = cameras[i].id;
                let alloc = baseAllocation;
                if (remainder > 0) {
                    alloc += 1;
                    remainder -= 1;
                }

                // Store allocation in Redis
                await redisConnection.set(`quota:user:${userId}:cam:${camId}:alloc:${todayStr}`, alloc, 'EX', 86400 * 2);
                
                // Remove Safe Mode flag if usage is below new allocation
                const usageStr = await redisConnection.get(`quota:user:${userId}:cam:${camId}:usage:${todayStr}`);
                const usage = usageStr ? parseInt(usageStr, 10) : 0;
                
                if (usage < alloc) {
                    await redisConnection.del(`quota:safemode:${camId}`);
                } else {
                    await redisConnection.set(`quota:safemode:${camId}`, '1', 'EX', 86400 * 2);
                }
            }
            console.log(`[QuotaManager] Recalculated allocation for User ${userId}. ${activeCount} cameras. Total: ${totalQuota}`);
        } catch (e) {
            console.error(`[QuotaManager] Error recalculating allocation for ${userId}:`, e.message);
        }
    }

    /**
     * Increment usage for a specific camera after a successful Gemini API call.
     * Places the camera in Safe Mode if it hits its allocation.
     */
    async incrementApiUsage(userId, camId) {
        try {
            const todayStr = this._getResetDateString();
            
            // Check plan to ignore Free plan limits (handled elsewhere)
            const allocStr = await redisConnection.get(`quota:user:${userId}:cam:${camId}:alloc:${todayStr}`);
            if (!allocStr) return; // Unallocated or Free plan

            const allocation = parseInt(allocStr, 10);
            const usage = await redisConnection.incr(`quota:user:${userId}:cam:${camId}:usage:${todayStr}`);
            
            // Set TTL on first increment
            if (usage === 1) {
                await redisConnection.expire(`quota:user:${userId}:cam:${camId}:usage:${todayStr}`, 86400 * 2);
            }

            if (usage >= allocation) {
                // Atomic SET NX EX: only sets if key doesn't exist, with auto-expiry
                const wasSet = await redisConnection.set(`quota:safemode:${camId}`, '1', 'NX', 'EX', 86400 * 2);
                if (wasSet) {
                    console.warn(`[QuotaManager] Camera ${camId} reached daily API quota (${usage}/${allocation}). Entering Safe Mode.`);
                }
            }
        } catch (e) {
            console.error(`[QuotaManager] Error incrementing API usage for ${camId}:`, e.message);
        }
    }

    /**
     * Fast check to see if a camera is in Safe Mode.
     * Used by CameraWorker to block Gemini tasks.
     */
    async isCameraInSafeMode(camId) {
        try {
            const safeMode = await redisConnection.get(`quota:safemode:${camId}`);
            return !!safeMode;
        } catch (e) {
            return false; // Fail open if Redis fails
        }
    }

    /**
     * Gets the reset date string based on UTC midnight.
     * (Assuming UTC midnight for now as the default).
     */
    _getResetDateString() {
        return new Date().toISOString().split('T')[0];
    }

    /**
     * Optional: Perform a daily cleanup of stale safe-mode keys or proactive tasks.
     * Note: Redis 'EX' TTL already handles expirations of daily keys automatically.
     * This loop is a safety net.
     */
    startDailyResetLoop() {
        setInterval(() => {
            const todayStr = this._getResetDateString();
            console.log(`[QuotaManager] Daily reset check for ${todayStr}. Redis TTL handles expirations.`);
        }, 12 * 60 * 60 * 1000); // Check every 12 hours
    }
}

module.exports = new QuotaManager();
