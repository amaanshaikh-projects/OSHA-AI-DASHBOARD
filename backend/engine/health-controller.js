const { redisConnection } = require('./queue-manager.js');
const { getWeekKey, getPlanApiLimit } = require('../utils/shared-utils');

class HealthController {
    static BURST_THRESHOLD = 40; // 40 requests per minute

    async getHealth(camId) {
        let scoreStr = await redisConnection.get(`health_score:cam:${camId}`);
        let score = scoreStr ? parseInt(scoreStr, 10) : 100;
        
        let level = 'HEALTHY';
        if (score < 40) level = 'SAFE_MODE';
        else if (score < 60) level = 'LIMITED';
        else if (score < 80) level = 'WARNING';
        
        return { score, level };
    }

    async setHealth(camId, score, reason) {
        score = Math.max(0, Math.min(100, score));
        await redisConnection.set(`health_score:cam:${camId}`, score, 'EX', 86400 * 7); // 7-day TTL prevents orphaned keys
        if (reason) {
            await this.logEvent(camId, `Health updated to ${score}. Reason: ${reason}`);
            console.log(`[HealthController] ${camId}: ${reason}`);
        }
        return score;
    }

    async logEvent(camId, eventStr) {
        const timestamp = new Date().toISOString();
        const msg = `[${timestamp}] ${eventStr}`;
        await redisConnection.rpush(`health_events:cam:${camId}`, msg);
        await redisConnection.ltrim(`health_events:cam:${camId}`, -50, -1);
    }

    /**
     * BUG FIX: Read-only limit check (no counter increment).
     * Used as a pre-flight gate in camera-worker BEFORE enqueuing a Gemini job.
     * This prevents failed Gemini calls from consuming the user's API quota.
     * The actual increment happens via recordApiRequest() only on success.
     */
    async checkApiLimits(camId, dailyLimit = 200, userPlan = 'Free', userId = null) {
        let { score, level } = await this.getHealth(camId);

        if (userPlan.toLowerCase() === 'free' && userId) {
            const { getPlanApiLimit, getWeekKey } = require('../utils/shared-utils');
            const weekKey = getWeekKey();
            const weeklyKey = `api_usage:user:${userId}:weekly:${weekKey}`;
            const currentCountStr = await redisConnection.get(weeklyKey);
            const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;
            const freeTierLimit = getPlanApiLimit('free');

            if (currentCount >= freeTierLimit) {
                level = 'TRIAL_EXPIRED';
            }
        } else {
            const today = new Date().toISOString().split('T')[0];
            const dailyCountStr = await redisConnection.get(`api_usage:cam:${camId}:daily:${today}`);
            const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;

            const now = Date.now();
            const minuteWindow = Math.floor(now / 60000);
            const burstCountStr = await redisConnection.get(`api_usage:cam:${camId}:minute:${minuteWindow}`);
            const burstCount = burstCountStr ? parseInt(burstCountStr, 10) : 0;

            if (dailyCount >= dailyLimit) {
                if (level !== 'SAFE_MODE') {
                    score = await this.setHealth(camId, 30, `Daily limit reached (${dailyCount}/${dailyLimit} reqs/day). Entering Safe Mode.`);
                    level = 'SAFE_MODE';
                }
            } else if (burstCount >= HealthController.BURST_THRESHOLD) {
                if (level !== 'SAFE_MODE') {
                    score = await this.setHealth(camId, 30, `Burst detected (${burstCount} reqs/min). Entering Safe Mode.`);
                    level = 'SAFE_MODE';
                }
            }

            // Daily Reset Check
            if (dailyCount === 0 && score < 100) {
                score = await this.setHealth(camId, 100, `New day started. Resetting health to 100.`);
                level = 'HEALTHY';
            }
        }

        return { score, level };
    }

    async recordApiRequest(camId, dailyLimit = 200, userPlan = 'Free', userId = null) {
        const now = Date.now();
        const today = new Date().toISOString().split('T')[0];
        
        // Fetch current health
        let { score, level } = await this.getHealth(camId);

        if (userPlan.toLowerCase() === 'free' && userId) {
            // Weekly limit for Free Trial (resets automatically each week via Redis TTL)
            const { getPlanApiLimit, getWeekKey } = require('../utils/shared-utils');
            const weekKey = getWeekKey();
            const weeklyKey = `api_usage:user:${userId}:weekly:${weekKey}`;
            const currentCountStr = await redisConnection.get(weeklyKey);
            const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;
            const freeTierLimit = getPlanApiLimit('free');
            
            if (currentCount >= freeTierLimit) {
                level = 'TRIAL_EXPIRED';
            } else {
                await redisConnection.incr(weeklyKey);
                await redisConnection.expire(weeklyKey, 86400 * 8); // 8-day TTL
            }
        } else {
            // Per-user daily tracking (for enforcing API limits)
            if (userId) {
                const userDailyKey = `api_usage:user:${userId}:daily:${today}`;
                await redisConnection.incr(userDailyKey);
                await redisConnection.expire(userDailyKey, 86400 * 2);
            }

            // NOTE: Global api_usage:monthly and api_usage:daily are incremented
            // exclusively by trackApiUsage() in queue-manager.js on success.
            // Do NOT increment them here to avoid double-counting.

            // Per-camera tracking
            const dailyCount = await redisConnection.incr(`api_usage:cam:${camId}:daily:${today}`);
            await redisConnection.expire(`api_usage:cam:${camId}:daily:${today}`, 86400 * 2);
            
            // Burst tracking (Rolling 60s window)
            const minuteWindow = Math.floor(now / 60000);
            const burstCount = await redisConnection.incr(`api_usage:cam:${camId}:minute:${minuteWindow}`);
            await redisConnection.expire(`api_usage:cam:${camId}:minute:${minuteWindow}`, 120);

            // Daily Reset Check
            if (dailyCount === 1 && score < 100) {
                score = await this.setHealth(camId, 100, `New day started. Resetting health to 100.`);
                level = 'HEALTHY';
            }

            // Daily Limit Check
            if (dailyCount >= dailyLimit) {
                if (level !== 'SAFE_MODE') {
                    score = await this.setHealth(camId, 30, `Daily limit reached (${dailyCount}/${dailyLimit} reqs/day). Entering Safe Mode.`);
                    level = 'SAFE_MODE';
                }
            }
            // Burst Check
            else if (burstCount >= HealthController.BURST_THRESHOLD) {
                if (level !== 'SAFE_MODE') {
                    score = await this.setHealth(camId, 30, `Burst detected (${burstCount} reqs/min). Entering Safe Mode.`);
                    level = 'SAFE_MODE';
                }
            }
        }
        
        return { score, level };
    }

    
    async recordApiSuccess(camId) {
        let { score } = await this.getHealth(camId);
        if (score < 100) {
            // Recover 1 point per success
            await this.setHealth(camId, score + 1);
        }
    }

    async recordApiError(camId, errorMsg) {
        let { score } = await this.getHealth(camId);
        await this.setHealth(camId, score - 5, `API Error: ${errorMsg}`);
    }

    async getAdaptiveStabilityWindow(camId) {
        const { level } = await this.getHealth(camId);
        if (level === 'WARNING') return 2000;
        if (level === 'LIMITED') return 4000;
        if (level === 'SAFE_MODE') return 10000;
        return 1000; // HEALTHY
    }

    async getDashboardStats(camId, plan = 'Free') {
        const { score, level } = await this.getHealth(camId);
        
        let usage = 0;
        let limit = getPlanApiLimit(plan);

        if (plan.toLowerCase() === 'free') {
            const weekKey = getWeekKey();
            const val = await redisConnection.get(`api_usage:cam:${camId}:weekly:${weekKey}`);
            usage = val ? parseInt(val, 10) : 0;
        } else {
            const todayStr = new Intl.DateTimeFormat('en-CA').format(new Date()); 
            const val = await redisConnection.get(`api_usage:cam:${camId}:daily:${todayStr}`);
            usage = val ? parseInt(val, 10) : 0;
        }

        const minuteWindow = Math.floor(Date.now() / 60000);
        const currentBurst = await redisConnection.get(`api_usage:cam:${camId}:minute:${minuteWindow}`) || 0;
        const events = await redisConnection.lrange(`health_events:cam:${camId}`, 0, -1);
        
        const safeMode = await redisConnection.get(`quota:safemode:${camId}`);

        return {
            score,
            level: safeMode ? 'SAFE_MODE' : level, // Override level if in Safe Mode
            requestsToday: usage,
            apiLimit: limit,
            requestsLastMinute: parseInt(currentBurst, 10),
            events: events.reverse() // Most recent first
        };
    }
}

module.exports = new HealthController();
