// ==========================================================================
// VISION AI — Embedder Service (Singleton)
// Lazy-loads the Xenova/all-MiniLM-L6-v2 model once and reuses it everywhere.
// Both gemini-worker.js and routine-learner.js must import from here.
// ==========================================================================

const { pipeline } = require('@xenova/transformers');

let embedder = null;

/**
 * Returns the shared embedding pipeline, initializing it on first call.
 * Subsequent calls return the already-loaded instance immediately.
 */
async function getEmbedder() {
    if (!embedder) {
        console.log('[EmbedderService] Loading all-MiniLM-L6-v2 model...');
        embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[EmbedderService] Model loaded ✅');
    }
    return embedder;
}

module.exports = { getEmbedder };
