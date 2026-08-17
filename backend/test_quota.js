const quotaManager = require('./engine/quota-manager.js');
const { redisConnection } = require('./engine/queue-manager.js');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function testQuota() {
    console.log("Starting Quota Test...");

    const userId = "550e8400-e29b-41d4-a716-446655440000";
    const camId1 = "cam_1";
    const camId2 = "cam_2";
    const camId3 = "cam_3";
    const todayStr = quotaManager._getResetDateString();

    try {
        // Mock user plan to Starter (540 calls)
        const { error: profileErr } = await supabase.from('profiles').upsert({
            id: userId,
            email: 'test@example.com',
            subscription_plan: 'Starter',
            subscription_status: 'active'
        });
        if (profileErr) throw new Error("Could not mock profile: " + profileErr.message);

        // Mock 3 active cameras
        const { error: camErr } = await supabase.from('cameras').upsert([
            { id: camId1, user_id: userId, status: 'Online' },
            { id: camId2, user_id: userId, status: 'Online' },
            { id: camId3, user_id: userId, status: 'Online' }
        ]);
        if (camErr) throw new Error("Could not mock cameras: " + camErr.message);

        // Calculate Allocation
        await quotaManager.recalculateAllocation(userId);

        // Check Redis for allocation values
        const alloc1 = await redisConnection.get(`quota:user:${userId}:cam:${camId1}:alloc:${todayStr}`);
        const alloc2 = await redisConnection.get(`quota:user:${userId}:cam:${camId2}:alloc:${todayStr}`);
        const alloc3 = await redisConnection.get(`quota:user:${userId}:cam:${camId3}:alloc:${todayStr}`);
        
        console.log(`Allocations (Expected 180 each): Cam1=${alloc1}, Cam2=${alloc2}, Cam3=${alloc3}`);
        if (alloc1 !== '180' || alloc2 !== '180' || alloc3 !== '180') {
            console.error("Allocation mismatch!");
        }

        // Simulate usage on Cam1
        for (let i = 0; i < 180; i++) {
            await quotaManager.incrementApiUsage(userId, camId1);
        }
        
        const usage1 = await redisConnection.get(`quota:user:${userId}:cam:${camId1}:usage:${todayStr}`);
        console.log(`Usage for Cam1: ${usage1}`);

        // Cam1 should be in safe mode now
        const safeMode1 = await quotaManager.isCameraInSafeMode(camId1);
        console.log(`Cam1 Safe Mode (Expected true): ${safeMode1}`);
        if (!safeMode1) console.error("Cam1 did not enter Safe Mode!");

        // Simulate 1 more usage on Cam1 to ensure it doesn't crash
        await quotaManager.incrementApiUsage(userId, camId1);

        // Cam2 should not be in safe mode
        const safeMode2 = await quotaManager.isCameraInSafeMode(camId2);
        console.log(`Cam2 Safe Mode (Expected false): ${safeMode2}`);
        if (safeMode2) console.error("Cam2 incorrectly entered Safe Mode!");

        // Cleanup
        await supabase.from('cameras').delete().in('id', [camId1, camId2, camId3]);
        await supabase.from('profiles').delete().eq('id', userId);
        
        const keys = await redisConnection.keys(`*quota*${userId}*`);
        if (keys.length > 0) await redisConnection.del(keys);
        await redisConnection.del(`quota:safemode:${camId1}`);
        
        console.log("Test complete.");
    } catch (e) {
        console.error("Test failed:", e.message);
    } finally {
        process.exit(0);
    }
}

testQuota();
