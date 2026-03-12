const express = require('express');
const path = require('path');

const uploadRouter = require('./routes/upload');
const apiRouter = require('./routes/api');
const { startWorker } = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', uploadRouter);
app.use('/api', apiRouter);

// Redirect root to index
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

app.listen(PORT, () => {
  console.log(`Access Dashboards running at http://localhost:${PORT}`);
  startWorker();
});
