const fs = require('fs');
const {
  insertImport, finalizeImport, insertEntries, deleteImport,
  startJob, updateJobProgress, completeJob, failJob, getPendingJob,
} = require('./db');
const { parseFile } = require('./parser');

let running = false;

async function processJob(job) {
  startJob(job.id);
  let importId = null;
  try {
    importId = insertImport(job.filename, job.instance);
    let totalInserted = 0;
    let processedLines = 0;

    const { totalLines, parsedLines } = await parseFile(job.file_path, (batch) => {
      totalInserted += insertEntries(importId, batch);
      processedLines += batch.length;
      updateJobProgress(job.id, processedLines);
    }, job.instance);

    if (parsedLines === 0) {
      deleteImport(importId);
      importId = null;
      try { fs.unlinkSync(job.file_path); } catch (_) {}
      failJob(job.id, 'No valid Apache log lines found in the uploaded file');
      return;
    }

    if (totalInserted === 0) {
      deleteImport(importId);
      importId = null;
      try { fs.unlinkSync(job.file_path); } catch (_) {}
      failJob(job.id, 'No new lines — all entries in this file already exist in the database');
      return;
    }

    finalizeImport(importId, totalLines, parsedLines, totalInserted);
    try { fs.unlinkSync(job.file_path); } catch (_) {}
    completeJob(job.id, importId);
    console.log(`Job ${job.id} done: ${totalInserted} lines inserted (${job.filename})`);
  } catch (err) {
    if (importId) { try { deleteImport(importId); } catch (_) {} }
    try { fs.unlinkSync(job.file_path); } catch (_) {}
    failJob(job.id, err.message);
    console.error(`Job ${job.id} failed:`, err.message);
  }
}

async function tick() {
  if (running) return;
  const job = getPendingJob();
  if (!job) return;
  running = true;
  try {
    await processJob(job);
  } finally {
    running = false;
  }
}

function startWorker() {
  setInterval(tick, 2000);
  console.log('Background job worker started (polling every 2s)');
}

module.exports = { startWorker };
