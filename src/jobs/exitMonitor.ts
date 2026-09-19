import { niftyPositionStore } from '../store/positionStore.js';
import { placeOrder } from '../helpers/orders.js';
import { modeManager } from '../helpers/modeManager.js';
import { logger, getISTTimestamp } from '../helpers/logger.js';
import { sendAlert } from '../notifier.js';
import { webSocketManager } from '../helpers/websocket.js';

export async function exitStraddlePosition(
  reason: 'SL' | 'PT' | '21DTE' | 'PANIC',
  ceExitLTP: number,
  peExitLTP: number
): Promise<void> {
  const pos = niftyPositionStore.getPosition();
  if (!pos || pos.status !== 'OPEN') {
    logger.warn('No open position found to exit.');
    return;
  }

  logger.info(`🚨 Initiating exit for NIFTY straddle. Reason: ${reason}`);

  // Place BUY-to-cover orders for both legs
  const ceOrderPromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.ceLeg.symbol,
    symboltoken: pos.ceLeg.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.ceLeg.qty.toString(),
  });

  const peOrderPromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.peLeg.symbol,
    symboltoken: pos.peLeg.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.peLeg.qty.toString(),
  });

  const [ceRes, peRes] = await Promise.all([ceOrderPromise, peOrderPromise]);

  if (!ceRes.success || !peRes.success) {
    const errorMsg = `Partial failure while exiting straddle! CE success: ${ceRes.success}, PE success: ${peRes.success}`;
    logger.error(errorMsg);
    await sendAlert(`🚨🚨 EMERGENCY: ${errorMsg}. Immediate manual intervention needed!`, true);
  }

  const exitPremiumRupees = (ceExitLTP + peExitLTP) * pos.lotSize;
  const realizedPnL = pos.entryPremiumRupees - exitPremiumRupees;

  niftyPositionStore.closePosition(reason, ceExitLTP, peExitLTP, realizedPnL, getISTTimestamp());

  const emoji = realizedPnL >= 0 ? '🎉' : '⚠️';
  const alertMsg = `${emoji} NIFTY straddle exited (${reason})!\nRealized P&L: ₹${realizedPnL.toFixed(2)}\nCE Exit LTP: ${ceExitLTP}\nPE Exit LTP: ${peExitLTP}`;
  logger.info(alertMsg);
  await sendAlert(alertMsg, reason === 'SL' || reason === 'PANIC');

  webSocketManager.stop();
}

/**
 * Evaluates live continuous SL/PT conditions (§1.3, §1.7)
 */
export async function evaluateExitConditions(
  currentCeLTP: number,
  currentPeLTP: number
): Promise<void> {
  // Hard stop check (§2.3)
  if (modeManager.isPanic()) {
    logger.warn('Panic mode triggered -> exiting position immediately.');
    await exitStraddlePosition('PANIC', currentCeLTP, currentPeLTP);
    return;
  }

  const pos = niftyPositionStore.getPosition();
  if (!pos || pos.status !== 'OPEN') return;

  const currentCombinedPremium = (currentCeLTP + currentPeLTP) * pos.lotSize;
  const unrealizedPnL = pos.entryPremiumRupees - currentCombinedPremium;

  // Stop-loss check: unrealizedLossRupees >= slAmount
  if (-unrealizedPnL >= pos.slAmount) {
    logger.warn(
      `Stop Loss breached! Unrealized Loss: ₹${(-unrealizedPnL).toFixed(2)} >= SL: ₹${pos.slAmount}`
    );
    await exitStraddlePosition('SL', currentCeLTP, currentPeLTP);
    return;
  }

  // Profit target check: unrealizedProfitRupees >= ptAmount
  if (unrealizedPnL >= pos.ptAmount) {
    logger.info(
      `Profit Target hit! Unrealized Profit: ₹${unrealizedPnL.toFixed(2)} >= PT: ₹${pos.ptAmount}`
    );
    await exitStraddlePosition('PT', currentCeLTP, currentPeLTP);
    return;
  }
}
