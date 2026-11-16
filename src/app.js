const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoose = require('mongoose');
const env = require('./config/env');
const apiRouter = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
// Behind a hosting proxy (Render, etc.) so req.ip is the real client IP for login throttling
if (env.nodeEnv === 'production') app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: env.corsOrigin === '*' ? '*' : env.corsOrigin.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '1mb' }));
if (env.nodeEnv !== 'test') app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// Health check for the main HMS / load balancer
app.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ service: 'bed-allocation', status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'connected' : 'disconnected' });
});

app.use('/api/v1', apiRouter);

// Built-in staff dashboard (static web UI)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
