const fs = require("fs");
const fsPromise = require("fs").promises;

const logFilePath = "./test.txt";
let currentOffset = 0;
const subscribers = new Map();
let lastTenLineBuffer = [];

function emitSSE(res, line) {
  res.write("data: " + line + "\n\n");
}

function broadcastLine(line) {
  // if (lastTenLineBuffer.length > 10) {
  //   lastTenLineBuffer.shift();
  // }
  lastTenLineBuffer.push(line);

  for (const res of subscribers.values()) {
    emitSSE(res, line);
  }
}

async function readLastNLines(filePath, numLines) {
  const fileHandle = await fsPromise.open(filePath, "r"); //this opens the file in a read only mode

  try {
    const stats = await fileHandle.stat(); // fetches metadata
    if (stats.size === 0) return [];

    const chunkSize = 64 * 1024; // 64kb
    let position = stats.size;
    let buffer = Buffer.alloc(0); // instantiate an empty buffer
    let lines = [];

    while (position > 0 && lines.length <= numLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      //       Example:
      // Start: position = 150 KB
      // Read 64 KB → position = 86 KB
      // Next iteration: read another 64 KB → position = 22 KB
      // Final iteration: read 22 KB → position = 0 (done).
      const chunkBuffer = Buffer.alloc(readSize); //creates a buffer of the readsize
      await fileHandle.read(chunkBuffer, 0, readSize, position); //reads the buffer from  0 to size starting from the given position
      buffer = Buffer.concat([chunkBuffer, buffer]); //it prepends the read data
      const parts = buffer.toString("utf8").split(/\r?\n/); //Convert the accumulated buffer (raw bytes) into text.
      lines = parts.filter((p) => p.length > 0); //filter out empty lines
      if (lines.length >= numLines) break;
    }
    return lines.slice(-numLines);
  } finally {
    await fileHandle.close();
  }
}

async function initTailer() {
  try {
    await fsPromise.access(logFilePath, fs.constants.F_OK); // check if file exists
  } catch {
    await fsPromise.writeFile(logFilePath, ""); // create it if missing
  }

  const stats = await fsPromise.stat(logFilePath); //This is an async call to get metadata about the file
  currentOffset = stats.size; //this keeps a track of the last read data so the data isnt fully re read and can start reading from this point
  lastTenLineBuffer = await readLastNLines(logFilePath, 10);

  // Watch for file size changes and read only the appended part
  fs.watchFile(logFilePath, { interval: 500 }, async (curr, prev) => {
    try {
      if (currentOffset.size < prev.size) {
        // Rotation or truncation detected: refresh tail buffer for new subscribers
        try {
          lastTenLineBuffer = await readLastNLines(logFilePath, 10); //it checks for the new 10 lines
        } catch (e) {
          lastTenLineBuffer = []; //if unable to render new lines that means the file is cleared
        }

        currentOffset = curr.size;
      }
      if (curr.size > currentOffset) {
        //if change detected
        const stream = fs.createReadStream(logFilePath, {
          start: currentOffset,
          end: curr.size - 1,
          encoding: "utf8",
        }); //read the stream
        let partial = "";
        stream.on("data", (chunk) => {
          partial += chunk; //append the partial data sent
          let index;
          while ((index = partial.indexOf("\n")) !== -1) {
            //looks for the new line char if it doesnt find one then returns -1
            const line = partial.slice(0, index).replace(/\r$/, ""); //Extracts the substring from start of partial up to (but not including) the newline.
            if (line.length > 0) {
              broadcastLine(line);
            }
            partial = partial.slice(index + 1); //Removes the processed line + the newline (\n) from the buffer.
          }
        });
        stream.on("end", () => {
          currentOffset = curr.size;
          // If there is a trailing partial without newline, do not emit until newline arrives
        });
        stream.on("error", (err) => {
          console.error("Read stream error: ", err);
        });
      }
    } catch (err) {
      console.error("watchfile handler error: ", err);
    }
  });
}

function handleSSE(req, res) {
  req.socket.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send last 10 lines on connect
  //   When a new client connects, you don’t want them to see only future logs.
  // So you immediately replay the last 10 log lines (lastTenLinesBuffer) to the new client.
  for (const line of lastTenLineBuffer) {
    emitSSE(res, line);
  }
  const id = Date.now() + Math.random().toString(36).slice(2);
  subscribers.set(id, res);
  // console.log(id);

  req.on("close", () => {
    subscribers.delete(id);
    res.end();
  });
}

let counter = 1;
setInterval(() => {
  try {
    fs.appendFileSync(logFilePath, `new data: ${counter}\n`);
    counter++;
  } catch (e) {}
}, 5000);

initTailer().catch((err) => console.error("Failed to init Tailer: ", err));

module.exports = { handleSSE };
