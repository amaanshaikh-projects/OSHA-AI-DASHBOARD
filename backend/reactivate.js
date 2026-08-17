const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
    const { data, error } = await supabase.from('cameras').update({ status: 'active' }).neq('status', 'nonexistent_status');
    if (error) {
        console.error("Error:", error);
    } else {
        console.log("Success");
    }
}
main();
