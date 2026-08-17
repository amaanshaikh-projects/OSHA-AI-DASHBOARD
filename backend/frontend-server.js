/**
 * VISION AI — Frontend Static Server
 * Serves /frontend at http://localhost:3000
 * Backend API runs separately at http://localhost:8000
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT         = 3000;
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css",
    ".js":   "text/javascript",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2":"font/woff2",
    ".ttf":  "font/ttf",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts":   "video/mp2t",
};

// Clean URL -> HTML file mappings
const HTML_ROUTES = {
    "/":            "index.html",
    "/index":       "index.html",
    "/dashboard":   "dashboard.html",
    "/ask":         "ask.html",
};

const server = http.createServer((req, res) => {
    const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";

    // CORS headers (allows frontend to talk to backend on :8000)
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Resolve file path
    let filePath;
    if (HTML_ROUTES[urlPath]) {
        filePath = path.join(FRONTEND_DIR, HTML_ROUTES[urlPath]);
    } else {
        filePath = path.join(FRONTEND_DIR, urlPath);
    }

    // Path traversal guard
    if (!filePath.startsWith(FRONTEND_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Try appending .html before giving up
            fs.readFile(filePath + ".html", (err2, data2) => {
                if (err2) {
                    res.writeHead(404, { "Content-Type": "text/plain" });
                    res.end("404 Not Found");
                } else {
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(data2);
                }
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log("[Frontend Server] Serving at http://localhost:" + PORT);
    console.log("[Frontend Server] Root: " + FRONTEND_DIR);
    console.log("[Frontend Server] Backend API: http://localhost:8000");
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error("[Frontend Server] Port " + PORT + " already in use.");
    } else {
        console.error("[Frontend Server] Error:", err.message);
    }
    process.exit(1);
});
