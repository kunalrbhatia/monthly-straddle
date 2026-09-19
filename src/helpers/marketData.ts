import { executeRequest } from './api.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { getActiveSession } from './login.js';
import { modeManager } from './modeManager.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface QuoteData {
  token: string;
  symbol: string;
  ltp: number;
}

/**
 * Rounds price to nearest strike interval (e.g. 50 for NIFTY)
 */
export function roundToNearestStrikeInterval(price: number, interval: number = 50): number {
  return Math.round(price / interval) * interval;
}

export async function fetchLTP(exchange: string, symbol: string, token: string): Promise<number> {
  if (modeManager.isPaper()) {
    // Return simulated reasonable LTP if in paper mode without live connectivity
    if (token === '99926000') return 24500; // Mock Nifty spot
    if (exchange === 'NFO' && symbol.includes('FUT')) return 24550; // Mock Future
    return 150; // Mock option premium
  }

  const session = getActiveSession();
  if (!session) throw new Error('Cannot fetch LTP without active session.');

  try {
    const response = await executeRequest(ANGEL_API_ENDPOINTS.LTP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': env.API_KEY,
        Authorization: `Bearer ${session.jwtToken}`,
      },
      data: {
        mode: 'LTP',
        exchangeTokens: {
          [exchange]: [token],
        },
      },
      isIdempotent: true,
    });

    if (response.data && response.data.data && response.data.data.fetched) {
      const item = response.data.data.fetched[0];
      return parseFloat(item.ltp);
    }
    throw new Error(`Quote empty: ${JSON.stringify(response.data)}`);
  } catch (err: any) {
    logger.error(`Error fetching LTP for ${symbol} (${token}): ${err.message}`);
    throw err;
  }
}
