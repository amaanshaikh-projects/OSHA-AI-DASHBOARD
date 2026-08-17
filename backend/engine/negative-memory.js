const { getAppConfig } = require('../config.js');
const { redisConnection } = require('./queue-manager.js');

class NegativeMemoryEngine {
    get config() {
        return getAppConfig().negativeMemory || {
            enabled: true,
            ttlMs: 300000,
            cooldownBaseMs: 30000,
            maxSuppressionMs: 600000,
            maxRejectionsPerEvent: 10
        };
    }

    getKey(userId, camId, ruleId, ruleVersion, eventId, trackId) {
        return `negative_memory:${userId}:${camId}:${ruleId}:${ruleVersion}:${eventId}:${trackId}`;
    }

    /**
     * Store negative evidence memory in Redis.
     */
    async setMemory(userId, camId, ruleId, ruleVersion, eventId, trackId, stateData) {
        if (!this.config.enabled) return;
        
        const rejectionCount = stateData.consecutiveRejections || 1;
        
        // Calculate adaptive cooldown
        const baseCooldown = this.config.cooldownBaseMs;
        const cooldown = Math.min(baseCooldown * Math.pow(2, rejectionCount - 1), this.config.maxSuppressionMs);
        const cooldownExpiresAt = Date.now() + cooldown;

        const memoryPayload = {
            user_id: userId,
            camera_id: camId,
            rule_id: ruleId,
            rule_version: ruleVersion,
            event_id: eventId,
            track_id: trackId,
            status: "REJECTED",
            first_rejected_at: stateData.firstVerifiedTime || Date.now(),
            last_rejected_at: Date.now(),
            rejection_count: rejectionCount,
            cooldown_until: cooldownExpiresAt,
            last_bbox: stateData.baselineBox,
            previous_semantic_state: stateData.last_verified_state || {},
            reverification_allowed: false
        };

        const key = this.getKey(userId, camId, ruleId, ruleVersion, eventId, trackId);
        
        try {
            await redisConnection.set(key, JSON.stringify(memoryPayload), 'PX', this.config.ttlMs);
        } catch (error) {
            console.error(`[NegativeMemory] Error saving state to Redis:`, error.message);
        }

        return cooldownExpiresAt;
    }

    /**
     * Retrieve negative evidence memory from Redis.
     */
    async getMemory(userId, camId, ruleId, ruleVersion, eventId, trackId) {
        if (!this.config.enabled) return null;
        const key = this.getKey(userId, camId, ruleId, ruleVersion, eventId, trackId);
        try {
            const data = await redisConnection.get(key);
            if (data) return JSON.parse(data);
        } catch (error) {
            console.error(`[NegativeMemory] Error reading state from Redis:`, error.message);
        }
        return null;
    }

    /**
     * Clear negative evidence memory.
     */
    async invalidateMemory(userId, camId, ruleId, ruleVersion, eventId, trackId) {
        const key = this.getKey(userId, camId, ruleId, ruleVersion, eventId, trackId);
        try {
            await redisConnection.del(key);
            console.log(`[NEGATIVE_MEMORY] Event ${eventId} → negative evidence invalidated`);
        } catch (error) {
            console.error(`[NegativeMemory] Error invalidating state in Redis:`, error.message);
        }
    }
}

module.exports = new NegativeMemoryEngine();
