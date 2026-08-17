const Redis = require('ioredis');

const REDIS_URL = 'redis://default:557k9fG3jzVJEomADasPzwEEvTnJfv9N@milk-chivalrous-bee-83197.db.redis.io:17529';
const client = new Redis(REDIS_URL);
client.on('error', (err) => console.log('Redis Client Error', err));

async function main() {
    await client.publish('config_updates', 'refresh');
    console.log('Published refresh message');
    client.quit();
}
main();
