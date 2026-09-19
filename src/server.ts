import express from 'express';
import { niftyPositionStore } from './store/positionStore.js';
import { modeManager } from './helpers/modeManager.js';
import { getISTTimestamp } from './helpers/logger.js';

export function createServer() {
  const app = express();

  app.get('/health', (req, res) => {
    const pos = niftyPositionStore.getPosition();
    res.json({
      status: 'UP',
      timeIST: getISTTimestamp(),
      modes: {
        paper: modeManager.isPaper(),
        kill: modeManager.isKill(),
        panic: modeManager.isPanic(),
      },
      position: pos ? {
        status: pos.status,
        strike: pos.strike,
        expiry: pos.expiryDate,
        entryPremium: pos.entryPremiumRupees,
      } : null,
    });
  });

  return app;
}
