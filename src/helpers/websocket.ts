import WebSocket from 'ws';
import { getActiveSession } from './login.js';
import { modeManager } from './modeManager.js';
import { niftyPositionStore } from '../store/positionStore.js';
import { logger } from './logger.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { appendMtmLog } from './mtmLogger.js';
import { evaluateExitConditions } from '../jobs/exitMonitor.js';

class WebSocketManager {
  private ws: WebSocket | null = null;
  private isConnecting: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCeLtp: number = 0;
  private lastPeLtp: number = 0;

  public start(): void {
    if (this.timer) clearInterval(this.timer);

    if (modeManager.isPaper()) {
      logger.info('WebSocket running in MOCK mode for paper trading.');
      this.timer = setInterval(() => this.simulatePaperTick(), 10000); // every 10s
      return;
    }

    this.connect();
  }

  private connect(): void {
    const session = getActiveSession();
    if (!session || !niftyPositionStore.hasOpenPosition()) {
      return;
    }

    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.isConnecting = true;
    const wsUrl = ANGEL_API_ENDPOINTS.WS_STREAM;

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${session.jwtToken}`,
          'x-api-key': process.env.API_KEY || '',
          'x-client-code': session.userId,
          'x-feed-token': session.feedToken,
        },
      });

      this.ws.on('open', () => {
        this.isConnecting = false;
        logger.info('Angel One WebSocket connected.');
        this.subscribeOpenPosition();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        logger.warn('WebSocket closed. Reconnecting in 5 seconds...');
        setTimeout(() => this.connect(), 5000);
      });
    } catch (err: any) {
      this.isConnecting = false;
      logger.error(`WebSocket connection failed: ${err.message}`);
    }
  }

  public subscribeOpenPosition(): void {
    const pos = niftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const request = {
      action: 1, // Subscribe
      params: {
        mode: 1, // LTP
        tokenList: [
          {
            exchangeType: 2, // NFO
            tokens: [pos.ceLeg.token, pos.peLeg.token],
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(request));
    logger.info(`Subscribed WebSocket to tokens: ${pos.ceLeg.token}, ${pos.peLeg.token}`);
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      // In production SmartAPI binary packets require parsing, or JSON depending on protocol version.
      // Assuming JSON/Parsed representation
      const str = data.toString();
      if (str.startsWith('{')) {
        const parsed = JSON.parse(str);
        if (parsed.token && parsed.last_traded_price) {
          this.updateTick(parsed.token, parsed.last_traded_price / 100);
        }
      }
    } catch (err: any) {
      logger.debug(`Error parsing WS frame: ${err.message}`);
    }
  }

  public updateTick(token: string, ltp: number): void {
    const pos = niftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN') return;

    if (token === pos.ceLeg.token) {
      this.lastCeLtp = ltp;
      pos.ceLeg.currentLTP = ltp;
    } else if (token === pos.peLeg.token) {
      this.lastPeLtp = ltp;
      pos.peLeg.currentLTP = ltp;
    }

    if (this.lastCeLtp > 0 && this.lastPeLtp > 0) {
      appendMtmLog(
        new Date(),
        pos.strike,
        this.lastCeLtp,
        this.lastPeLtp,
        pos.entryPremiumRupees,
        pos.lotSize,
        pos.slAmount,
        pos.ptAmount
      );
      evaluateExitConditions(this.lastCeLtp, this.lastPeLtp);
    }
  }

  private simulatePaperTick(): void {
    const pos = niftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN') return;

    // Small random walk for mock testing
    const deltaCe = (Math.random() - 0.52) * 4;
    const deltaPe = (Math.random() - 0.52) * 4;
    this.lastCeLtp = Math.max(1, (pos.ceLeg.currentLTP || pos.ceLeg.entryLTP) + deltaCe);
    this.lastPeLtp = Math.max(1, (pos.peLeg.currentLTP || pos.peLeg.entryLTP) + deltaPe);

    pos.ceLeg.currentLTP = this.lastCeLtp;
    pos.peLeg.currentLTP = this.lastPeLtp;

    appendMtmLog(
      new Date(),
      pos.strike,
      this.lastCeLtp,
      this.lastPeLtp,
      pos.entryPremiumRupees,
      pos.lotSize,
      pos.slAmount,
      pos.ptAmount
    );

    evaluateExitConditions(this.lastCeLtp, this.lastPeLtp);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const webSocketManager = new WebSocketManager();
