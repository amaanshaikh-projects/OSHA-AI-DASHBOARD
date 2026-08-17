const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../config.js');
const { redisConnection } = require('./queue-manager.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function runProfileEngine() {
    console.log('[ProfileEngine] Starting hourly profile sync...');
    try {
        // Fetch cameras where routine learning is enabled
        const { data: cameras, error } = await supabase
            .from('cameras')
            .select('id, rtsp_url, camera_profile')
            .eq('routine_learning_enabled', true);

        if (error) throw error;
        if (!cameras || cameras.length === 0) {
            console.log('[ProfileEngine] No cameras have routine learning enabled. Sleeping.');
            return;
        }

        for (const cam of cameras) {
            console.log(`[ProfileEngine] Processing camera ${cam.id}...`);
            
            // Fetch hourly aggregated stats from Redis (max 24 hours = 24 samples)
            const motionDataRaw = await redisConnection.lrange(`profile_stats:cam:${cam.id}:motion`, 0, -1);
            const lightingDataRaw = await redisConnection.lrange(`profile_stats:cam:${cam.id}:lighting`, 0, -1);

            const motionData = motionDataRaw.map(parseFloat).filter(n => !isNaN(n) && n > 0);
            const lightingData = lightingDataRaw.map(parseFloat).filter(n => !isNaN(n) && n > 0);

            // We need at least 1 hour of data to make a reliable baseline
            if (motionData.length < 1) {
                console.log(`[ProfileEngine] Camera ${cam.id} has no profile stats yet. Skipping.`);
                continue;
            }

            // Average out the hourly p95s to get a solid baseline
            let avgMotion = motionData.reduce((a, b) => a + b, 0) / motionData.length;
            let learnedMotion = avgMotion * 1.5; // Add buffer
            
            // Constrain motion bounds based on camera type
            const isRTSP = cam.rtsp_url && !cam.rtsp_url.startsWith('webcam://');
            const minMotion = isRTSP ? 0.003 : 0.001;
            const maxMotion = 0.015; // Don't let the threshold get so high it ignores everything
            learnedMotion = Math.min(Math.max(learnedMotion, minMotion), maxMotion);

            // Calculate Noise Floor (Lighting)
            let learnedLighting = 45;
            if (lightingData.length > 0) {
                let avgLighting = lightingData.reduce((a, b) => a + b, 0) / lightingData.length;
                learnedLighting = avgLighting * 1.2;
                learnedLighting = Math.min(Math.max(learnedLighting, 30), 80);
            }

            // Build Profile Object
            const profile = cam.camera_profile || {};
            profile.motion_baseline = learnedMotion;
            profile.noise_floor = learnedLighting;
            profile.last_updated = new Date().toISOString();

            console.log(`[ProfileEngine] Generated Profile for ${cam.id}:`, profile);

            // Update Database
            const { error: updateError } = await supabase
                .from('cameras')
                .update({ camera_profile: profile })
                .eq('id', cam.id);

            if (updateError) {
                console.error(`[ProfileEngine] Failed to update camera ${cam.id}:`, updateError.message);
            }
        }
        
        console.log('[ProfileEngine] Cycle complete.');
    } catch (e) {
        console.error('[ProfileEngine] Error running cycle:', e.message);
    }
}

function startProfileEngine() {
    // Run once on startup, then every 1 hour (3600000 ms)
    setTimeout(() => {
        runProfileEngine();
        setInterval(runProfileEngine, 60 * 60 * 1000);
    }, 5000);
}

module.exports = { startProfileEngine };
