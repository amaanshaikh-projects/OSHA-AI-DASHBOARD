const WebSocket = require('ws');
const http = require('http');

async function testWebSocketSecurity() {
    console.log("Starting WebSocket Security Test...");
    // Attempt connection without token
    const wsNoToken = new WebSocket('ws://localhost:8001');
    wsNoToken.on('close', (code, reason) => {
        if (code === 1008) {
            console.log("✅ PASS: Connection without token rejected as expected.");
        } else {
            console.log("❌ FAIL: Connection without token closed with unexpected code: " + code);
        }
    });

    // We can't easily generate valid Supabase JWTs without full auth credentials, 
    // but we can ensure that an invalid token fails correctly.
    const wsInvalid = new WebSocket('ws://localhost:8001?token=invalid_token_123');
    wsInvalid.on('close', (code, reason) => {
        if (code === 1008) {
            console.log("✅ PASS: Connection with invalid token rejected as expected.");
        } else {
            console.log("❌ FAIL: Connection with invalid token closed with unexpected code: " + code);
        }
    });
}

function testApiSecurity() {
    console.log("Starting API Security Test...");
    const req = http.request({
        hostname: 'localhost',
        port: 8000,
        path: '/api/user/usage?userId=some_other_user',
        method: 'GET',
        headers: {
            // Missing Authorization header
        }
    }, (res) => {
        if (res.statusCode === 401) {
            console.log("✅ PASS: API access without token rejected with 401.");
        } else {
            console.log("❌ FAIL: API access without token returned " + res.statusCode);
        }
    });
    req.end();
}

setTimeout(() => {
    testWebSocketSecurity();
    testApiSecurity();
}, 1000);
