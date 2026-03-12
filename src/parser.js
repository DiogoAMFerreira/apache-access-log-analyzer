const fs = require('fs');
const readline = require('readline');
const { createHash } = require('crypto');

// Apache2 Combined Log Format:
// %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-agent}i"
// Example:
// 192.168.1.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08"
const LOG_REGEX = /^(?:\S+:\d+ )?(\S+) \S+ (\S+) \[([^\]]+)\] "([A-Z]+) ([^ "]+) (HTTP\/[\d.]+)" (\d{3}|-) (\d+|-) "([^"]*)" "([^"]*)"/;

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

// Parse Apache timestamp "[10/Oct/2000:13:55:36 -0700]" → ISO 8601 string
function parseTimestamp(raw) {
  // raw = "10/Oct/2000:13:55:36 -0700"
  const match = raw.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/);
  if (!match) return null;
  const [, day, mon, year, time, tz] = match;
  const month = MONTHS[mon];
  if (!month) return null;
  const offset = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return `${year}-${month}-${day}T${time}${offset}`;
}

// Parse a single log line. Returns an entry object or null if unparseable.
function parseLine(line) {
  const m = LOG_REGEX.exec(line);
  if (!m) return null;

  const [, ip, , rawTs, method, path, protocol, rawStatus, rawBytes, referer, userAgent] = m;
  const timestamp = parseTimestamp(rawTs);
  if (!timestamp) return null;

  return {
    ip,
    timestamp,
    method,
    path,
    protocol,
    status: parseInt(rawStatus, 10),
    bytes: rawBytes === '-' ? 0 : parseInt(rawBytes, 10),
    referer: referer === '-' ? null : referer,
    userAgent: userAgent === '-' ? null : userAgent,
  };
}

// Parse an entire log file, calling onBatch(entries[]) for every 1 000 parsed lines.
// Returns { totalLines, parsedLines } — entries are never accumulated in memory.
async function parseFile(filepath, onBatch, instance = null) {
  return new Promise((resolve, reject) => {
    let totalLines = 0;
    let parsedLines = 0;
    let batch = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(filepath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      totalLines++;
      const entry = parseLine(line);
      if (entry) {
        const hashInput = instance ? `${instance}:${line.trim()}` : line.trim();
        entry.lineHash = createHash('sha256').update(hashInput).digest('hex');
        parsedLines++;
        batch.push(entry);
        if (batch.length >= 1000) {
          onBatch(batch);
          batch = [];
        }
      }
    });

    rl.on('close', () => {
      if (batch.length > 0) onBatch(batch);
      resolve({ totalLines, parsedLines });
    });
    rl.on('error', reject);
  });
}

module.exports = { parseLine, parseFile };
