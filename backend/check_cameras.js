const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
    const { data: cameras, error } = await supabase.from('cameras').select('*');
    console.log("Cameras:", cameras);
    console.log("Error:", error);
}
main();
