const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
    console.log("Checking database...");
    const { data: detections, error } = await supabase.from('detections').select('camera_name').limit(5);
    console.log("Detections:", detections);
    console.log("Error:", error);
}
main();
