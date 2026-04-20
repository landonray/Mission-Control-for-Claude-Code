const express = require('express');
const multer = require('multer');
const transcribeService = require('../services/transcribe');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  try {
    const text = await transcribeService.transcribeAudio({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype || 'audio/webm',
      filename: req.file.originalname || 'audio.webm',
    });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

module.exports = router;
