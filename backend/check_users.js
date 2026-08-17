const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('./config.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
    const { data: users, error } = await supabase.from('users').select('*');
    console.log("Users:", users);
    console.log("Error:", error);
}
main();
