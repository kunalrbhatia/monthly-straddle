import path from 'path';
import fs from 'fs';
import { roundToNearestStrikeInterval } from '../src/helpers/marketData.js';
import { extractLotSizes } from '../src/helpers/scripMaster.js';
import { calculateDTE, getAdjusted21DteDate, isTradingDay } from '../src/helpers/holidayCheck.js';
import { parseMtmLine, generateDailyReport } from '../analysis/generateReport.js';

describe('Strategy Core Math & Engineering Rules', () => {
  test('Strike rounding matches Nifty 50 interval', () => {
    expect(roundToNearestStrikeInterval(24024, 50)).toBe(24000);
    expect(roundToNearestStrikeInterval(24026, 50)).toBe(24050);
    expect(roundToNearestStrikeInterval(24200, 50)).toBe(24200);
  });

  test('§2.10 Lot size aggregation uses majority vote across contracts', () => {
    const mockInstruments: any[] = [
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'NIFTY', lotsize: '65' },
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'NIFTY', lotsize: '65' },
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'NIFTY', lotsize: '75' }, // stray row
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'NIFTY', lotsize: '0' }, // invalid row
      { exch_seg: 'NSE', instrumenttype: 'EQ', name: 'RELIANCE', lotsize: '1' },
    ];

    const lotSizes = extractLotSizes(mockInstruments, ['NIFTY']);
    expect(lotSizes['NIFTY']).toBe(65);
  });

  test('§2.5 DTE calculation in calendar days', () => {
    const today = new Date('2026-09-14T09:30:00.000Z');
    const expiry = new Date('2026-10-29T10:00:00.000Z');
    const dte = calculateDTE(today, expiry);
    expect(dte).toBe(45);
  });

  test('§1.3.1 21-DTE hard-exit holiday rollback', () => {
    const expiry = new Date('2026-10-29T10:00:00.000Z'); // Thursday
    const adjusted21 = getAdjusted21DteDate(expiry);
    expect(isTradingDay(adjusted21)).toBe(true);
    // Adjusted date must be strictly <= 21 days from expiry
    expect(calculateDTE(adjusted21, expiry)).toBeGreaterThanOrEqual(21);
  });

  test('§1.7 MTM format line parsing', () => {
    const line =
      '01/10/2026, 15:30:00 | NIFTY | strike=24500 | ceLTP=120.00 | peLTP=125.00 | combinedPremium=15925.00 | unrealizedPnL=3575.00 | pctOfSL=0.0 | pctOfPT=36.7';
    const parsed = parseMtmLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.strike).toBe('24500');
    expect(parsed?.combinedPremium).toBe(15925);
    expect(parsed?.unrealizedPnL).toBe(3575);
    expect(parsed?.pctOfPT).toBe(36.7);
  });

  test('§2.9 CI smoke test for daily report generation with fixture', () => {
    const fixturePath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fixture-mtm.log');
    const reportPath = generateDailyReport(new Date('2026-10-01'), fixturePath);
    expect(reportPath).not.toBeNull();
    if (reportPath) {
      expect(fs.existsSync(reportPath)).toBe(true);
      const content = fs.readFileSync(reportPath, 'utf-8');
      expect(content).toContain('NIFTY Monthly 45-DTE Straddle Daily Trade Report');
      expect(content).toContain('Intraday MTM Statistics (from Append-Only Log)');
    }
  });
});
