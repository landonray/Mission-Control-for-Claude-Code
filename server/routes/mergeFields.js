const express = require('express');
const { listFields } = require('../services/mergeFields');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ fields: listFields() });
});

module.exports = router;
