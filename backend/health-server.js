const http = require('http');

function startHealthServer(port, workerName, getMetricsCallback) {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/ready') {
            const memory = process.memoryUsage();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                worker: workerName,
                uptime: process.uptime(),
                memory: {
                    rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
                    heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB'
                },
                ...((getMetricsCallback && getMetricsCallback()) || {})
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        console.log(`[${workerName}] Health server listening on port ${port}`);
    });

    return server;
}

module.exports = { startHealthServer };
