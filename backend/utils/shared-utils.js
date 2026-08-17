// ==========================================================================
// VISION AI — Shared Utilities
// Centralised helpers used across gemini-worker, routine-learner, camera-worker
// ==========================================================================

/**
 * Cosine similarity between two numeric arrays.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Returns a 1-hour time window string like "14:00-15:00" for a given Date.
 */
function getTimeWindow(date) {
    const h = date.getHours();
    return `${h.toString().padStart(2, '0')}:00-${(h + 1).toString().padStart(2, '0')}:00`;
}

/**
 * Returns an ISO week key like "2026-W30" for a given Date (or now).
 * Used to key free-trial weekly counters in Redis — when the week rolls over,
 * the key changes and a new 8-day TTL counter starts from zero automatically.
 */
function getWeekKey(date = new Date()) {
    // ISO week: week containing Thursday of the same year
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7; // Mon=1 ... Sun=7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

/**
 * Returns the daily alert limit for a given subscription plan string.
 * Single source of truth — update here to change limits everywhere.
 *
 * Free:    10 alerts  (lifetime, not daily)
 * Starter: 30 alerts  per day  → enters SAFE_MODE if exceeded
 * Pro:    75 alerts  per day  → enters SAFE_MODE if exceeded
 */
function getPlanAlertLimit(plan) {
    const p = (plan || 'free').toLowerCase();
    if (p === 'starter') return 30;
    if (p === 'pro')     return 75;
    return 10; // Free trial (lifetime cap)
}

/**
 * Returns the API call limit for a given subscription plan string.
 *
 * Starter: 225 API calls per camera per day
 * Pro: 225 API calls per camera per day
 * Free: 30 API calls per camera per week
 */
function getPlanApiLimit(plan) {
    const p = (plan || 'free').toLowerCase();
    if (p === 'starter') return 225;
    if (p === 'pro') return 225;
    return 30; // 30 max per week for free trial
}

module.exports = { cosineSimilarity, getTimeWindow, getWeekKey, getPlanAlertLimit, getPlanApiLimit };
