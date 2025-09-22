/*
*/
const fs = require('fs');
const fsPromises = require('fs').promises;

const logFilePath = './test.txt';
let currentOffset = 0;
const subscribers = new Map();
let lastTenLinesBuffer = [];

function emitSSE(res, line) {
    res.write("data: " + line + '\n\n');
}

function broadcastLine(line) {
    // Maintain in-memory last 10 lines buffer
    // if (lastTenLinesBuffer.length >= 10) {
    //     lastTenLinesBuffer.shift();
    // }
    lastTenLinesBuffer.push(line);

    for (const res of subscribers.values()) {
        emitSSE(res, line);
    }
}

async function readLastNLines(filePath, numLines) {
    const fileHandle = await fsPromises.open(filePath, 'r');
    try {
        const stats = await fileHandle.stat();
        if (stats.size === 0) return [];

        const chunkSize = 64 * 1024; // 64KB
        let position = stats.size;
        let buffer = Buffer.alloc(0);
        let lines = [];

        while (position > 0 && lines.length <= numLines) {
            const readSize = Math.min(chunkSize, position);
            position -= readSize;
            const chunkBuffer = Buffer.alloc(readSize);
            await fileHandle.read(chunkBuffer, 0, readSize, position);
            buffer = Buffer.concat([chunkBuffer, buffer]);
            const parts = buffer.toString('utf8').split(/\r?\n/);
            lines = parts.filter(p => p.length > 0);
            if (lines.length >= numLines) break;
        }
        return lines.slice(-numLines);
    } finally {
        await fileHandle.close();
    }
}

async function initTailer() {
    try {
        await fsPromises.access(logFilePath, fs.constants.F_OK);
    } catch {
        await fsPromises.writeFile(logFilePath, '');
    }

    const stats = await fsPromises.stat(logFilePath);
    currentOffset = stats.size;
    lastTenLinesBuffer = await readLastNLines(logFilePath, 10);

    // Watch for file size changes and read only the appended part
    fs.watchFile(logFilePath, { interval: 500 }, async (curr, prev) => {
        try {
            if (curr.size < prev.size) {
                // Rotation or truncation detected: refresh tail buffer for new subscribers
                try {
                    lastTenLinesBuffer = await readLastNLines(logFilePath, 10);
                } catch (e) {
                    lastTenLinesBuffer = [];
                }
                // Advance offset to current end to avoid re-emitting historical lines
                currentOffset = curr.size;
            }
            if (curr.size > currentOffset) {
                const stream = fs.createReadStream(logFilePath, { start: currentOffset, end: curr.size - 1, encoding: 'utf8' });
                let partial = '';
                stream.on('data', chunk => {
                    partial += chunk;
                    let index;
                    while ((index = partial.indexOf('\n')) !== -1) {
                        const line = partial.slice(0, index).replace(/\r$/, '');
                        if (line.length > 0) {
                            broadcastLine(line);
                        }
                        partial = partial.slice(index + 1);
                    }
                });
                stream.on('end', () => {
                    currentOffset = curr.size;
                    // If there is a trailing partial without newline, do not emit until newline arrives
                });
                stream.on('error', (err) => {
                    console.error('Read stream error:', err);
                });
            }
        } catch (err) {
            console.error('watchFile handler error:', err);
        }
    });
}

function handleSSE(req, res) {
    req.socket.setTimeout(0);
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Send last 10 lines on connect
    for (const line of lastTenLinesBuffer) {
        emitSSE(res, line);
    }

    const id = Date.now() + Math.random().toString(36).slice(2);
    subscribers.set(id, res);

    req.on('close', () => {
        subscribers.delete(id);
        res.end();
    });
}

// OPTIONAL: demo log writer. Comment out in production.
let demoTimer = 1;
setInterval(() => {
    try {
        fs.appendFileSync(logFilePath, `new data: ${demoTimer}\n`);
        demoTimer++;
    } catch (e) {
        // ignore
    }
}, 5000);

initTailer().catch(err => console.error('Failed to init tailer:', err));

module.exports = { handleSSE };