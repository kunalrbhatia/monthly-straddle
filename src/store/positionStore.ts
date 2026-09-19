import fs from 'fs';
import path from 'path';
import { logger } from '../helpers/logger.js';

export interface PositionLeg {
  symbol: string;
  token: string;
  strike: number;
  optionType: 'CE' | 'PE';
  side: 'SELL' | 'BUY';
  qty: number;
  entryLTP: number;
  currentLTP?: number;
}

export interface PositionState {
  index: string; // e.g. 'NIFTY'
  status: 'OPEN' | 'CLOSED';
  entryTimestamp: string;
  strike: number;
  expiryDate: string; // e.g. '29OCT2026'
  dteAtEntry: number;
  lotSize: number;
  ceLeg: PositionLeg;
  peLeg: PositionLeg;
  entryPremiumRupees: number; // Immutable: (ceEntryLTP + peEntryLTP) * lotSize per §1.3
  slAmount: number;           // 100% of entry premium received
  ptAmount: number;           // 50% of entry premium received
  dte21Date: string;          // YYYY-MM-DD
  exitTimestamp?: string;
  exitReason?: 'SL' | 'PT' | '21DTE' | 'PANIC' | 'PARTIAL_ABORT';
  realizedPnL?: number;
  ceExitLTP?: number;
  peExitLTP?: number;
}

export class PositionStore {
  private filePath: string;

  constructor(index: string = 'NIFTY') {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.resolve(dataDir, `position-${index}.json`);
  }

  public getPosition(): PositionState | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (data && data.status === 'OPEN') {
        return data as PositionState;
      }
      return data as PositionState;
    } catch (e: any) {
      logger.error(`Failed to read position file: ${e.message}`);
      return null;
    }
  }

  public hasOpenPosition(): boolean {
    const pos = this.getPosition();
    return pos !== null && pos.status === 'OPEN';
  }

  public savePosition(position: PositionState): void {
    fs.writeFileSync(this.filePath, JSON.stringify(position, null, 2), 'utf-8');
    logger.info(`Position saved to ${this.filePath}`);
  }

  /**
   * §2.1: Before closing or clearing, never erase critical historical values!
   * We mark status CLOSED and keep the record for audit / report inspection.
   */
  public closePosition(
    reason: 'SL' | 'PT' | '21DTE' | 'PANIC' | 'PARTIAL_ABORT',
    ceExitLTP: number,
    peExitLTP: number,
    realizedPnL: number,
    exitTimestamp: string
  ): void {
    const pos = this.getPosition();
    if (!pos) return;

    pos.status = 'CLOSED';
    pos.exitReason = reason;
    pos.ceExitLTP = ceExitLTP;
    pos.peExitLTP = peExitLTP;
    pos.realizedPnL = realizedPnL;
    pos.exitTimestamp = exitTimestamp;

    fs.writeFileSync(this.filePath, JSON.stringify(pos, null, 2), 'utf-8');
    logger.info(`Position marked CLOSED with reason: ${reason}, realizedPnL: ₹${realizedPnL}`);
  }
}

export const niftyPositionStore = new PositionStore('NIFTY');
