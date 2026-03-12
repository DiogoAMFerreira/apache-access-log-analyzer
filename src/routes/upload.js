const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createJob } = require('../db');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.log' || ext === '.txt' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only .log or .txt files are accepted'));
    }
  },
});

router.post('/upload', upload.single('logfile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = createJob(req.file.originalname, req.file.path, req.body.instance || null);
  res.json({ jobId });
});

// Multer error handler (file size / type rejections)
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ error: err.message });
  }
  _next(err);
});

module.exports = router;
