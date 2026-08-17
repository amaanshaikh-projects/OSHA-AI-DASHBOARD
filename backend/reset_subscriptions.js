require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');

const ADMIN_EMAIL = 'amaanshaikh.contact@gmail.com';

async function runReset() {
    console.log("========================================");
    console.log("   INITIATING FULL SUBSCRIPTION RESET");
    console.log("========================================");
    console.log(`Administrator exception: ${ADMIN_EMAIL}\n`);

    // 1. Setup Connections
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const redis = new Redis(process.env.REDIS_URL);
    
    try {
        // 2. Fetch all profiles EXCEPT the administrator
        console.log("Fetching target users...");
        const { data: profiles, error: profileErr } = await supabase
            .from('profiles')
            .select('id, email')
            .neq('email', ADMIN_EMAIL);

        if (profileErr) throw profileErr;
        
        const userIds = profiles.map(p => p.id);
        console.log(`Found ${userIds.length} users to reset.\n`);

        if (userIds.length === 0) {
            console.log("No users to reset. Exiting.");
            process.exit(0);
        }

        // 3. Reset Profiles
        console.log("Resetting Profiles to Free/Active...");
        const { error: updateErr } = await supabase
            .from('profiles')
            .update({
                subscription_plan: 'Free',
                subscription_status: 'Active'
            })
            .in('id', userIds);

        if (updateErr) throw updateErr;
        console.log("Profiles reset successfully.\n");

        // 4. Reset Subscriptions table
        console.log("Deleting old subscription records...");
        const { error: delSubErr } = await supabase
            .from('subscriptions')
            .delete()
            .in('user_id', userIds);
            
        if (delSubErr) throw delSubErr;

        console.log("Inserting new Free subscription records...");
        const newSubscriptions = userIds.map(uid => ({
            user_id: uid,
            plan_name: 'Free',
            subscription_status: 'Active',
            billing_interval: null
        }));

        const { error: insertSubErr } = await supabase
            .from('subscriptions')
            .insert(newSubscriptions);

        if (insertSubErr) throw insertSubErr;
        console.log("Subscriptions reset successfully.\n");

        // 5. Redis Quota Cleanup
        console.log("Fetching associated cameras for Redis cleanup...");
        const { data: cameras, error: camErr } = await supabase
            .from('cameras')
            .select('id')
            .in('user_id', userIds);

        if (camErr) throw camErr;
        
        const cameraIds = cameras.map(c => c.id);
        console.log(`Found ${cameraIds.length} associated cameras.\n`);

        console.log("Clearing Redis quota keys...");
        let keysDeleted = 0;
        
        // Find all quota keys for these users
        for (const uid of userIds) {
            // Redis keys pattern: quota:user:{userId}:*
            const userKeys = await redis.keys(`quota:user:${uid}:*`);
            if (userKeys.length > 0) {
                await redis.del(...userKeys);
                keysDeleted += userKeys.length;
            }
        }

        // Find all safemode keys for these cameras
        for (const cid of cameraIds) {
            const safemodeKeys = await redis.keys(`quota:safemode:${cid}`);
            if (safemodeKeys.length > 0) {
                await redis.del(...safemodeKeys);
                keysDeleted += safemodeKeys.length;
            }
        }

        console.log(`Deleted ${keysDeleted} quota-related keys from Redis.\n`);

        console.log("========================================");
        console.log("   RESET COMPLETED SUCCESSFULLY");
        console.log("========================================");
        
    } catch (e) {
        console.error("FATAL ERROR DURING RESET:", e);
    } finally {
        redis.quit();
        process.exit(0);
    }
}

runReset();
