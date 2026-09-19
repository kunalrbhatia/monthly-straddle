import fs from 'fs';
import path from 'path';
import { getISTDateString } from '../src/helpers/logger.js';
import { niftyPositionStore } from '../src/store/positionStore.js';
import { logger } from '../src/helpers/logger.js';

interface ParsedMtmLine {
  timestamp: string;
  strike: string;
  ceLTP: number;
  peLTP: number;
  combinedPremium: number;
  unrealizedPnL: number;
  pctOfSL: number;
  pctOfPT: number;
}

export function parseMtmLine(line: string): ParsedMtmLine | null {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 8) return null;

  const timestamp = parts[0];
  const strikeMatch = line.match(/strike=([0-9.]+)/);
  const ceMatch = line.match(/ceLTP=([0-9.]+)/);
  const peMatch = line.match(/peLTP=([0-9.]+)/);
  const combinedMatch = line.match(/combinedPremium=([0-9.-]+)/);
  const pnlMatch = line.match(/unrealizedPnL=([0-9.-]+)/);
  const slMatch = line.match(/pctOfSL=([0-9.]+)/);
  const ptMatch = line.match(/pctOfPT=([0-9.]+)/);

  if (!combinedMatch || !pnlMatch) return null;

  return {
    timestamp,
    strike: strikeMatch ? strikeMatch[1] : 'N/A',
    ceLTP: ceMatch ? parseFloat(ceMatch[1]) : 0,
    peLTP: peMatch ? parseFloat(peMatch[1]) : 0,
    combinedPremium: parseFloat(combinedMatch[1]),
    unrealizedPnL: parseFloat(pnlMatch[1]),
    pctOfSL: slMatch ? parseFloat(slMatch[1]) : 0,
    pctOfPT: ptMatch ? parseFloat(ptMatch[1]) : 0,
  };
}

export function generateDailyReport(
  date: Date = new Date(),
  fixtureFilePath?: string
): string | null {
  const dateStr = getISTDateString(date);
  const mtmFilePath =
    fixtureFilePath || path.resolve(process.cwd(), 'logs', 'mtm', `mtm-NIFTY-${dateStr}.log`);

  if (!fs.existsSync(mtmFilePath)) {
    logger.info(`No MTM log found at ${mtmFilePath}. Skipping daily report generation.`);
    return null;
  }

  const rawLines = fs
    .readFileSync(mtmFilePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    logger.info('MTM log file is empty. Skipping daily report.');
    return null;
  }

  const parsedLines: ParsedMtmLine[] = [];
  for (const line of rawLines) {
    const parsed = parseMtmLine(line);
    if (parsed) parsedLines.push(parsed);
  }

  if (parsedLines.length === 0) {
    logger.warn('No valid MTM log lines could be parsed.');
    return null;
  }

  const firstEntry = parsedLines[0];
  const lastEntry = parsedLines[parsedLines.length - 1];

  let minPnL = Infinity;
  let maxPnL = -Infinity;
  for (const entry of parsedLines) {
    if (entry.unrealizedPnL < minPnL) minPnL = entry.unrealizedPnL;
    if (entry.unrealizedPnL > maxPnL) maxPnL = entry.unrealizedPnL;
  }

  const positionSnapshot = niftyPositionStore.getPosition();
  const exitStatus = positionSnapshot?.status === 'CLOSED' ? positionSnapshot.exitReason : 'OPEN';

  const reportMarkdown = `# NIFTY Monthly 45-DTE Straddle Daily Trade Report - ${dateStr}

## Overview
- **Instrument:** NIFTY 50
- **Strike:** ${firstEntry.strike}
- **Expiry:** ${positionSnapshot?.expiryDate || 'N/A'}
- **Status:** ${exitStatus}
- **Lot Size:** ${positionSnapshot?.lotSize || '65'}
- **Entry Combined Premium:** ₹${positionSnapshot?.entryPremiumRupees.toFixed(2) || 'N/A'}
- **SL Threshold (100%):** ₹${positionSnapshot?.slAmount.toFixed(2) || 'N/A'}
- **PT Threshold (50%):** ₹${positionSnapshot?.ptAmount.toFixed(2) || 'N/A'}
- **21-DTE Hard Exit Date:** ${positionSnapshot?.dte21Date || 'N/A'}

## Intraday MTM Statistics (from Append-Only Log)
- **Total Ticks Logged:** ${parsedLines.length}
- **Opening LTPs:** CE: ₹${firstEntry.ceLTP} | PE: ₹${firstEntry.peLTP}
- **Latest/Closing LTPs:** CE: ₹${lastEntry.ceLTP} | PE: ₹${lastEntry.peLTP}
- **Closing Combined Premium:** ₹${lastEntry.combinedPremium.toFixed(2)}
- **Closing Unrealized P&L:** ₹${lastEntry.unrealizedPnL.toFixed(2)}
- **Intraday P&L High:** ₹${maxPnL.toFixed(2)}
- **Intraday P&L Low (Drawdown):** ₹${minPnL.toFixed(2)}
- **Current SL Consumed:** ${lastEntry.pctOfSL.toFixed(1)}%
- **Current PT Progress:** ${lastEntry.pctOfPT.toFixed(1)}%
${positionSnapshot?.status === 'CLOSED' ? `- **Exit Details:** Closed via **${positionSnapshot.exitReason}** at ${positionSnapshot.exitTimestamp} with Realized P&L: ₹${positionSnapshot.realizedPnL?.toFixed(2)}` : ''}

---
_Generated automatically at 15:40 IST based on \`${path.basename(mtmFilePath)}\`_
`;

  const reportsDir = path.resolve(process.cwd(), 'analysis', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const reportPath = path.resolve(reportsDir, `${dateStr}-nifty-straddle.md`);
  fs.writeFileSync(reportPath, reportMarkdown, 'utf-8');
  logger.info(`Report successfully generated: ${reportPath}`);

  return reportPath;
}

// Allow direct CLI invocation or CI smoke test
if (process.argv.includes('--run') || process.argv.includes('--fixture')) {
  const isFixture = process.argv.includes('--fixture');
  const fixturePath = isFixture
    ? path.resolve(process.cwd(), 'tests', 'fixtures', 'fixture-mtm.log')
    : undefined;
  generateDailyReport(new Date(), fixturePath);
}
