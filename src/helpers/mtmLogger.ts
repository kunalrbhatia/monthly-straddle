import fs from 'fs';
import path from 'path';
import { getISTDateString, getISTTimestamp } from '../helpers/logger.js';

/**
 * §1.7 Line format (exact):
 * {ISO8601 IST timestamp} | NIFTY | strike={strike} | ceLTP={ceLTP} | peLTP={peLTP} | combinedPremium={combinedPremium} | unrealizedPnL={unrealizedPnL} | pctOfSL={pctOfSL} | pctOfPT={pctOfPT}
 */
export function formatMtmLogLine(
  date: Date,
  strike: number,
  ceLTP: number,
  peLTP: number,
  entryPremiumRupees: number,
  lotSize: number,
  slAmount: number,
  ptAmount: number
): string {
  const combinedPremium = (ceLTP + peLTP) * lotSize;
  const unrealizedPnL = entryPremiumRupees - combinedPremium;
  const pctOfSL = (Math.max(0, -unrealizedPnL) / slAmount) * 100;
  const pctOfPT = (Math.max(0, unrealizedPnL) / ptAmount) * 100;

  const ts = getISTTimestamp(date);
  return `${ts} | NIFTY | strike=${strike} | ceLTP=${ceLTP.toFixed(2)} | peLTP=${peLTP.toFixed(2)} | combinedPremium=${combinedPremium.toFixed(2)} | unrealizedPnL=${unrealizedPnL.toFixed(2)} | pctOfSL=${pctOfSL.toFixed(1)} | pctOfPT=${pctOfPT.toFixed(1)}`;
}

export function appendMtmLog(
  date: Date,
  strike: number,
  ceLTP: number,
  peLTP: number,
  entryPremiumRupees: number,
  lotSize: number,
  slAmount: number,
  ptAmount: number
): void {
  const mtmDir = path.resolve(process.cwd(), 'logs', 'mtm');
  if (!fs.existsSync(mtmDir)) {
    fs.mkdirSync(mtmDir, { recursive: true });
  }

  const dateStr = getISTDateString(date);
  const logFilePath = path.resolve(mtmDir, `mtm-NIFTY-${dateStr}.log`);

  const line = formatMtmLogLine(date, strike, ceLTP, peLTP, entryPremiumRupees, lotSize, slAmount, ptAmount);
  fs.appendFileSync(logFilePath, line + '\n', 'utf-8');
}
