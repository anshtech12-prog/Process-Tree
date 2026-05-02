/*
 * ============================================================
 * Process Tree Visualizer — Bridge Server
 * ============================================================
 *
 * Role
 * ----
 * Lightweight Node.js HTTP server that acts as the middle layer
 * between the native C backend and the browser-based frontend.
 *
 * Responsibilities
 * ----------------
 *  1. Auto-compile the C backend (`process_tree.c`) via GCC
 *  2. Execute the compiled binary to enumerate OS processes
 *  3. Expose process data and system metrics through REST API
 *  4. Serve the static frontend files (HTML / CSS / JS)
 *
 * API Endpoints
 * -------------
 *  GET  /api/processes   — Run C backend & return full process tree
 *  GET  /api/system      — System metrics (CPU, RAM, uptime, OS)
 *  GET  /api/history     — Last 20 snapshots (process count trend)
 *  GET  /api/status      — Server health check
 *  POST /api/kill/:pid   — Terminate a process by PID
 *
 * Data Flow
 * ---------
 *  Browser  ──GET /api/processes──▶  server.js
 *  server.js  ──exec()──▶  process_tree.exe  ──writes──▶  data/process.json
 *  server.js  ──reads JSON──▶  responds to browser
 *
 * Usage:  node server.js
 * URL:    http://localhost:3000
 *
 * Dependencies: None (uses only Node.js built-in modules)
 * ============================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');

/* ============================================================
 * Configuration
 * ============================================================ */
const PORT = 3000;
const BACKEND_DIR = path.join(__dirname, 'backend');
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const DATA_DIR = path.join(__dirname, 'data');
const EXE_PATH = path.join(BACKEND_DIR, 'process_tree.exe');
const C_SOURCE = path.join(BACKEND_DIR, 'process_tree.c');
const JSON_PATH = path.join(DATA_DIR, 'process.json');

/* MIME types for serving static files */
const MIME_TYPES = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

/* History buffer for process snapshots (last 20) */
const processHistory = [];

/* ============================================================
 * Ensure data directory exists
 * ============================================================ */
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ============================================================
 * Compile the C backend
 * ============================================================ */
function compileBackend() {
    return new Promise((resolve, reject) => {
        /* Check if source exists */
        if (!fs.existsSync(C_SOURCE)) {
            return reject(new Error(`C source not found: ${C_SOURCE}`));
        }

        /* Check if exe is already up-to-date */
        if (fs.existsSync(EXE_PATH)) {
            const srcStat = fs.statSync(C_SOURCE);
            const exeStat = fs.statSync(EXE_PATH);
            if (exeStat.mtimeMs > srcStat.mtimeMs) {
                console.log('✅ Backend executable is up to date.');
                return resolve();
            }
        }

        console.log('🔨 Compiling C backend...');
        const compileCmd = `gcc "${C_SOURCE}" -o "${EXE_PATH}" -lpsapi`;

        exec(compileCmd, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Compilation failed:', stderr);
                return reject(new Error(`Compilation failed: ${stderr}`));
            }
            console.log('✅ Backend compiled successfully.');
            resolve();
        });
    });
}

/* ============================================================
 * Execute the C backend and return process JSON
 * ============================================================ */
function getProcessTree() {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(EXE_PATH)) {
            return reject(new Error('Backend executable not found. Compile first.'));
        }

        /* Use exec with quoted paths to handle spaces in directory names */
        const cmd = `"${EXE_PATH}" "${JSON_PATH}"`;
        exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Execution error:', error.message);
                return reject(new Error(`Backend execution failed: ${error.message}`));
            }

            /* Read the output JSON file */
            try {
                const data = fs.readFileSync(JSON_PATH, 'utf-8');
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseErr) {
                reject(new Error(`Failed to parse process data: ${parseErr.message}`));
            }
        });
    });
}

/* ============================================================
 * Serve static files from the frontend directory
 * ============================================================ */
function serveStaticFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

/* ============================================================
 * HTTP Server
 * ============================================================ */
const server = http.createServer(async (req, res) => {
    /* CORS headers for development */
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    /* ---- API Routes ---- */
    if (pathname === '/api/processes') {
        try {
            const data = await getProcessTree();

            /* Track history snapshot */
            let run = 0, sleep = 0, zom = 0;
            const countNodes = (nodes) => {
                if (!nodes) return;
                nodes.forEach(n => {
                    const s = (n.status || '').toLowerCase();
                    if (s === 'running') run++;
                    else if (s === 'sleeping') sleep++;
                    else if (s === 'zombie') zom++;
                    if (n.children) countNodes(n.children);
                });
            };
            countNodes(data.roots);
            processHistory.push({
                timestamp: Date.now(),
                total: data.totalProcesses || 0,
                running: run,
                sleeping: sleep,
                zombie: zom
            });
            if (processHistory.length > 20) processHistory.shift();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (err) {
            console.error('API Error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: err.message,
                hint: 'Make sure gcc is installed and the C backend compiles correctly.'
            }));
        }
        return;
    }

    if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            backendCompiled: fs.existsSync(EXE_PATH),
            timestamp: Date.now()
        }));
        return;
    }

    /* ---- System Metrics ---- */
    if (pathname === '/api/system') {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const uptimeSecs = os.uptime();

        /* Calculate overall CPU usage from all cores */
        let totalIdle = 0, totalTick = 0;
        cpus.forEach(cpu => {
            for (const type in cpu.times) totalTick += cpu.times[type];
            totalIdle += cpu.times.idle;
        });
        const cpuUsagePct = Math.round((1 - totalIdle / totalTick) * 100);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            cpuCores: cpus.length,
            cpuModel: cpus[0] ? cpus[0].model : 'Unknown',
            cpuUsagePct,
            totalMemoryMB: Math.round(totalMem / (1024 * 1024)),
            freeMemoryMB: Math.round(freeMem / (1024 * 1024)),
            usedMemoryMB: Math.round((totalMem - freeMem) / (1024 * 1024)),
            memoryUsagePct: Math.round(((totalMem - freeMem) / totalMem) * 100),
            uptimeSeconds: Math.round(uptimeSecs),
            platform: os.platform(),
            hostname: os.hostname(),
            osType: os.type(),
            osRelease: os.release()
        }));
        return;
    }

    /* ---- Process History ---- */
    if (pathname === '/api/history') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ history: processHistory }));
        return;
    }

    /* ---- Kill Process ---- */
    if (pathname.startsWith('/api/kill/') && req.method === 'POST') {
        const pidStr = pathname.split('/').pop();
        const pid = parseInt(pidStr, 10);

        if (isNaN(pid) || pid <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid PID' }));
            return;
        }

        /* Safety: refuse to kill critical system processes */
        const protectedPids = [0, 4];
        if (protectedPids.includes(pid)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot kill protected system process' }));
            return;
        }

        exec(`taskkill /PID ${pid} /F`, (error, stdout, stderr) => {
            if (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Failed to kill process ${pid}: ${stderr || error.message}` }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Process ${pid} terminated`, output: stdout.trim() }));
        });
        return;
    }

    /* ---- Static File Serving ---- */
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
        filePath = path.join(FRONTEND_DIR, 'index.html');
    } else {
        filePath = path.join(FRONTEND_DIR, pathname);
    }

    /* Security: prevent directory traversal */
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(FRONTEND_DIR))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }

    serveStaticFile(res, filePath);
});

/* ============================================================
 * Start Server
 * ============================================================ */
async function start() {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🌳 Process Tree Visualizer                ║');
    console.log('║   OS-Level Parent–Child Process Mapper       ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    try {
        await compileBackend();
    } catch (err) {
        console.error('⚠️  Backend compilation failed:', err.message);
        console.error('   The server will start, but API calls will fail.');
        console.error('   Make sure gcc (MinGW) is installed and in PATH.');
        console.error('');
    }

    server.listen(PORT, () => {
        console.log(`🚀 Server running at http://localhost:${PORT}`);
        console.log(`📡 API endpoint:     http://localhost:${PORT}/api/processes`);
        console.log(`🖥️  Frontend:         http://localhost:${PORT}`);
        console.log('');
        console.log('Press Ctrl+C to stop the server.');
    });
}

start();
