require('dotenv').config();

const express = require('express');
const path = require('path');

const grantsRouter = require('./src/routes/grants');
const draftsRouter = require('./src/routes/drafts');
const profileRouter = require('./src/routes/profile');
const workspaceRouter = require('./src/routes/workspace');
const wizardRouter = require('./src/routes/wizard');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// API routes
app.use('/api/grants', grantsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/wizard', wizardRouter);

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wilko Grant Agent running on http://localhost:${PORT}`);
});
