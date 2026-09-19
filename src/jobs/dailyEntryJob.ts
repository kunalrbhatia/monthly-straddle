import { niftyPositionStore, PositionState } from '../store/positionStore.js';
import {
  fetchAndCacheScripMaster,
  loadCachedScrips,
  extractLotSizes,
  verifyLotSizeOrBlock,
  resolveMonthlyExpiries,
  ScripItem,
} from '../helpers/scripMaster.js';
import {
  isTradingDay,
  calculateDTE,
  getAdjusted21DteDate,
  getAdjustedTargetDteDate,
} from '../helpers/holidayCheck.js';
import { fetchLTP, roundToNearestStrikeInterval } from '../helpers/marketData.js';
import { placeOrder } from '../helpers/orders.js';
import { modeManager } from '../helpers/modeManager.js';
import { INDEX_CONFIGS } from '../helpers/constants.js';
import { env } from '../config/env.js';
import { logger, getISTTimestamp, getISTDateString } from '../helpers/logger.js';
import { sendAlert } from '../notifier.js';
import { exitStraddlePosition } from './exitMonitor.js';
import { webSocketManager } from '../helpers/websocket.js';

export async function runDailyJob(): Promise<void> {
  logger.info('--- Running 15:00 IST Entry / DTE Check Job ---');

  const today = new Date();
  if (!isTradingDay(today)) {
    logger.info('Today is not an NSE trading day. Skipping job.');
    return;
  }

  // Hard stop active?
  if (modeManager.isPanic()) {
    logger.warn('Panic mode active! Checking if open position requires squareoff.');
    if (niftyPositionStore.hasOpenPosition()) {
      const pos = niftyPositionStore.getPosition()!;
      await exitStraddlePosition('PANIC', pos.ceLeg.currentLTP || 0, pos.peLeg.currentLTP || 0);
    }
    return;
  }

  // Step 1: Check existing position
  const openPosition = niftyPositionStore.getPosition();
  if (openPosition && openPosition.status === 'OPEN') {
    logger.info(
      'Open position detected. Skipping entry evaluation, proceeding to 21-DTE hard-exit check.'
    );

    const todayStr = getISTDateString(today);
    if (todayStr === openPosition.dte21Date) {
      logger.warn(`Today (${todayStr}) is the 21-DTE hard-exit date! Triggering exit per §1.3.1.`);
      const ceLTP = await fetchLTP('NFO', openPosition.ceLeg.symbol, openPosition.ceLeg.token);
      const peLTP = await fetchLTP('NFO', openPosition.peLeg.symbol, openPosition.peLeg.token);
      await exitStraddlePosition('21DTE', ceLTP, peLTP);
    } else {
      logger.info(
        `Open position DTE-21 date is ${openPosition.dte21Date}. Position continues monitoring.`
      );
    }
    return;
  }

  // Soft pause check (§2.3)
  if (modeManager.isKill()) {
    logger.info('Soft pause (.kill) is ACTIVE. Skipping new entry evaluation.');
    return;
  }

  // Step 2: Resolve scrip master & verify lot size (§2.10)
  let scrips: ScripItem[] = loadCachedScrips();
  if (scrips.length === 0) {
    scrips = await fetchAndCacheScripMaster();
  }

  const lotSizes = extractLotSizes(scrips, ['NIFTY']);
  const derivedLotSize = lotSizes['NIFTY'] || INDEX_CONFIGS.NIFTY.defaultLotSize;
  const configuredLotSize = env.LOT_SIZE;

  const lotValid = verifyLotSizeOrBlock('NIFTY', derivedLotSize, configuredLotSize);
  if (!lotValid) {
    logger.error(
      `Entry blocked due to lot size discrepancy (scrip: ${derivedLotSize}, config: ${configuredLotSize}).`
    );
    return;
  }

  // Step 3: Expiry resolution & DTE Check
  const monthlyExpiries = resolveMonthlyExpiries(scrips, 'NIFTY');
  if (monthlyExpiries.length === 0) {
    logger.error('Could not resolve monthly expiries for NIFTY from scrip master.');
    return;
  }

  // Find the candidate monthly expiry
  let candidateExpiryStr: string | null = null;
  let candidateDTE: number = -1;

  for (const expStr of monthlyExpiries) {
    const expDate = new Date(expStr);
    const dte = calculateDTE(today, expDate);
    if (
      dte >= env.TARGET_DTE - env.ENTRY_DTE_WINDOW &&
      dte <= env.TARGET_DTE + env.ENTRY_DTE_WINDOW
    ) {
      candidateExpiryStr = expStr;
      candidateDTE = dte;
      break;
    }
  }

  logger.info(`Candidate monthly expiry: ${candidateExpiryStr}, DTE: ${candidateDTE}`);

  if (!candidateExpiryStr) {
    logger.info(
      `No monthly expiry within ${env.TARGET_DTE}±${env.ENTRY_DTE_WINDOW} DTE. No entry action required today.`
    );
    return;
  }

  // The exact TARGET_DTE day frequently falls on a non-trading day — a Tuesday monthly expiry
  // minus 45 days is ALWAYS a Saturday — so the old `candidateDTE === TARGET_DTE` check could
  // never fire. Anchor the entry to the nearest PREVIOUS trading day instead and fire on the
  // first trading day on/after it. This also tolerates a missed cron run: if the entry day is
  // skipped, the next trading day still satisfies today >= targetEntryDate.
  const targetEntryDate = getAdjustedTargetDteDate(new Date(candidateExpiryStr), env.TARGET_DTE);
  const targetEntryStr = getISTDateString(targetEntryDate);
  if (getISTDateString(today) < targetEntryStr) {
    logger.info(
      `Target entry date for ${candidateExpiryStr} is ${targetEntryStr} (target ${env.TARGET_DTE} DTE). No entry action required today.`
    );
    return;
  }

  // Confirmed entry day! Proceed to Step 2: Strike Resolution
  logger.info(
    `🎯 Confirmed entry day for ${candidateExpiryStr} (current DTE: ${candidateDTE}, target ${env.TARGET_DTE}±${env.ENTRY_DTE_WINDOW}). Commencing dual-ATM strike resolution.`
  );

  // 1. Fetch spot LTP and future LTP
  const spotLTP = await fetchLTP(
    'NSE',
    INDEX_CONFIGS.NIFTY.spotSymbol,
    INDEX_CONFIGS.NIFTY.spotToken
  );

  // Find current monthly future contract in scrip master
  const futContract = scrips.find(
    (s) =>
      s.exch_seg === 'NFO' &&
      s.name === 'NIFTY' &&
      s.instrumenttype === 'FUTIDX' &&
      s.expiry === candidateExpiryStr
  );

  let futLTP = spotLTP;
  if (futContract) {
    futLTP = await fetchLTP('NFO', futContract.symbol, futContract.token);
  }

  logger.info(`Spot LTP: ${spotLTP}, Future LTP: ${futLTP}`);

  const spotATM = roundToNearestStrikeInterval(spotLTP, INDEX_CONFIGS.NIFTY.strikeInterval);
  const futATM = roundToNearestStrikeInterval(futLTP, INDEX_CONFIGS.NIFTY.strikeInterval);

  let selectedStrike = spotATM;

  if (spotATM === futATM) {
    logger.info(`spotATM (${spotATM}) === futATM (${futATM}). Single candidate selected.`);
    selectedStrike = spotATM;
  } else {
    // Dual-ATM check
    const findOptionContracts = (strike: number) => {
      const ce = scrips.find(
        (s) =>
          s.exch_seg === 'NFO' &&
          s.name === 'NIFTY' &&
          s.instrumenttype === 'OPTIDX' &&
          s.expiry === candidateExpiryStr &&
          Math.abs(parseFloat(s.strike) / 100 - strike) < 1 &&
          s.symbol.endsWith('CE')
      );
      const pe = scrips.find(
        (s) =>
          s.exch_seg === 'NFO' &&
          s.name === 'NIFTY' &&
          s.instrumenttype === 'OPTIDX' &&
          s.expiry === candidateExpiryStr &&
          Math.abs(parseFloat(s.strike) / 100 - strike) < 1 &&
          s.symbol.endsWith('PE')
      );
      return { ce, pe };
    };

    const spotOpt = findOptionContracts(spotATM);
    const futOpt = findOptionContracts(futATM);

    let spotDiff = Infinity;
    let futDiff = Infinity;

    if (spotOpt.ce && spotOpt.pe) {
      const ceLtp = await fetchLTP('NFO', spotOpt.ce.symbol, spotOpt.ce.token);
      const peLtp = await fetchLTP('NFO', spotOpt.pe.symbol, spotOpt.pe.token);
      spotDiff = Math.abs(ceLtp - peLtp);
      logger.info(`spotATM (${spotATM}) -> CE: ${ceLtp}, PE: ${peLtp}, diff: ${spotDiff}`);
    }

    if (futOpt.ce && futOpt.pe) {
      const ceLtp = await fetchLTP('NFO', futOpt.ce.symbol, futOpt.ce.token);
      const peLtp = await fetchLTP('NFO', futOpt.pe.symbol, futOpt.pe.token);
      futDiff = Math.abs(ceLtp - peLtp);
      logger.info(`futATM (${futATM}) -> CE: ${ceLtp}, PE: ${peLtp}, diff: ${futDiff}`);
    }

    if (futDiff < spotDiff) {
      selectedStrike = futATM;
      logger.info(
        `futDiff (${futDiff}) < spotDiff (${spotDiff}) -> Selected futATM: ${selectedStrike}`
      );
    } else {
      selectedStrike = spotATM; // Default or tie-break
      logger.info(
        `spotDiff (${spotDiff}) <= futDiff (${futDiff}) -> Selected spotATM: ${selectedStrike}`
      );
    }
  }

  // Find final contracts to trade
  const targetCe = scrips.find(
    (s) =>
      s.exch_seg === 'NFO' &&
      s.name === 'NIFTY' &&
      s.instrumenttype === 'OPTIDX' &&
      s.expiry === candidateExpiryStr &&
      Math.abs(parseFloat(s.strike) / 100 - selectedStrike) < 1 &&
      s.symbol.endsWith('CE')
  );

  const targetPe = scrips.find(
    (s) =>
      s.exch_seg === 'NFO' &&
      s.name === 'NIFTY' &&
      s.instrumenttype === 'OPTIDX' &&
      s.expiry === candidateExpiryStr &&
      Math.abs(parseFloat(s.strike) / 100 - selectedStrike) < 1 &&
      s.symbol.endsWith('PE')
  );

  if (!targetCe || !targetPe) {
    const msg = `Could not find matching CE/PE contracts for strike ${selectedStrike} expiry ${candidateExpiryStr}`;
    logger.error(msg);
    await sendAlert(`🚨 ${msg}`, true);
    return;
  }

  // Step 3: Order placement (both legs)
  logger.info(`Placing SELL orders for ${selectedStrike} CE and PE...`);
  const ceOrderPromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: targetCe.symbol,
    symboltoken: targetCe.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const peOrderPromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: targetPe.symbol,
    symboltoken: targetPe.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const [ceRes, peRes] = await Promise.all([ceOrderPromise, peOrderPromise]);

  // Partial fill handling (§1.2)
  if (!ceRes.success && !peRes.success) {
    logger.error('Both leg orders failed. Entry aborted.');
    await sendAlert('🚨 Both CE and PE order placements failed. No position entered.', true);
    return;
  }

  if (ceRes.success && !peRes.success) {
    logger.error('Partial fill: CE filled but PE failed! Unwinding CE leg immediately per §1.2...');
    await sendAlert('🚨 Partial fill: CE filled but PE failed. Immediate unwind triggered.', true);
    await placeOrder({
      variety: 'NORMAL',
      tradingsymbol: targetCe.symbol,
      symboltoken: targetCe.token,
      transactiontype: 'BUY',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '0',
      quantity: configuredLotSize.toString(),
    });
    return;
  }

  if (!ceRes.success && peRes.success) {
    logger.error('Partial fill: PE filled but CE failed! Unwinding PE leg immediately per §1.2...');
    await sendAlert('🚨 Partial fill: PE filled but CE failed. Immediate unwind triggered.', true);
    await placeOrder({
      variety: 'NORMAL',
      tradingsymbol: targetPe.symbol,
      symboltoken: targetPe.token,
      transactiontype: 'BUY',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '0',
      quantity: configuredLotSize.toString(),
    });
    return;
  }

  // Step 4: Post-entry snapshot (§1, §1.3)
  const ceEntryLTP = ceRes.ltp || (await fetchLTP('NFO', targetCe.symbol, targetCe.token));
  const peEntryLTP = peRes.ltp || (await fetchLTP('NFO', targetPe.symbol, targetPe.token));
  const entryPremiumRupees = (ceEntryLTP + peEntryLTP) * configuredLotSize;
  const slAmount = entryPremiumRupees; // 100% of premium received
  const ptAmount = entryPremiumRupees * (env.PT_PCT_OF_PREMIUM / 100);

  const expiryDateObj = new Date(candidateExpiryStr!);
  const dte21DateObj = getAdjusted21DteDate(expiryDateObj);
  const dte21DateStr = getISTDateString(dte21DateObj);

  const positionState: PositionState = {
    index: 'NIFTY',
    status: 'OPEN',
    entryTimestamp: getISTTimestamp(),
    strike: selectedStrike,
    expiryDate: candidateExpiryStr!,
    dteAtEntry: candidateDTE,
    lotSize: configuredLotSize,
    ceLeg: {
      symbol: targetCe.symbol,
      token: targetCe.token,
      strike: selectedStrike,
      optionType: 'CE',
      side: 'SELL',
      qty: configuredLotSize,
      entryLTP: ceEntryLTP,
      currentLTP: ceEntryLTP,
    },
    peLeg: {
      symbol: targetPe.symbol,
      token: targetPe.token,
      strike: selectedStrike,
      optionType: 'PE',
      side: 'SELL',
      qty: configuredLotSize,
      entryLTP: peEntryLTP,
      currentLTP: peEntryLTP,
    },
    entryPremiumRupees,
    slAmount,
    ptAmount,
    dte21Date: dte21DateStr,
  };

  niftyPositionStore.savePosition(positionState);

  const successMsg = `🎉 NIFTY 45-DTE Naked Straddle Entered!\nStrike: ${selectedStrike}\nExpiry: ${candidateExpiryStr}\nCombined Entry Premium: ₹${entryPremiumRupees.toFixed(2)}\nSL (100%): ₹${slAmount.toFixed(2)}\nPT (50%): ₹${ptAmount.toFixed(2)}\n21-DTE Hard Exit Date: ${dte21DateStr}`;
  logger.info(successMsg);
  await sendAlert(successMsg);

  // Start continuous WebSocket monitoring
  webSocketManager.start();
}
