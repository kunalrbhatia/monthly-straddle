import { Telegraf } from 'telegraf';
import { env } from '../config/env.js';
import { modeManager } from '../helpers/modeManager.js';
import { niftyPositionStore } from '../store/positionStore.js';
import { logger } from '../helpers/logger.js';
import { exitStraddlePosition } from '../jobs/exitMonitor.js';

let bot: Telegraf | null = null;

export function initTelegramBot(): void {
  if (!env.USE_TELEGRAM || !env.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram bot is disabled in config.');
    return;
  }

  bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // Owner-only auth middleware (§2.3 & §3)
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id.toString();
    if (env.TELEGRAM_CHAT_ID && senderId !== env.TELEGRAM_CHAT_ID) {
      logger.warn(`Unauthorized Telegram access attempt by ID: ${senderId}`);
      await ctx.reply('⛔ Unauthorized.');
      return;
    }
    return next();
  });

  bot.command('status', async (ctx) => {
    const pos = niftyPositionStore.getPosition();
    const isKill = modeManager.isKill();
    const isPanic = modeManager.isPanic();
    const isPaper = modeManager.isPaper();

    let msg = `📊 <b>Algo Status</b>\n`;
    msg += `• Mode: <b>${isPaper ? 'PAPER' : 'LIVE'}</b>\n`;
    msg += `• Soft Pause (.kill): <b>${isKill ? 'ACTIVE (Entries paused)' : 'INACTIVE'}</b>\n`;
    msg += `• Hard Stop (.panic): <b>${isPanic ? 'ACTIVE' : 'INACTIVE'}</b>\n\n`;

    if (pos && pos.status === 'OPEN') {
      msg += `📈 <b>Active Position: NIFTY Straddle</b>\n`;
      msg += `• Strike: ${pos.strike}\n`;
      msg += `• Expiry: ${pos.expiryDate}\n`;
      msg += `• Entry Premium: ₹${pos.entryPremiumRupees.toFixed(2)}\n`;
      msg += `• SL: ₹${pos.slAmount.toFixed(2)} | PT: ₹${pos.ptAmount.toFixed(2)}\n`;
      msg += `• 21-DTE Exit Date: ${pos.dte21Date}\n`;
      if (pos.ceLeg.currentLTP && pos.peLeg.currentLTP) {
        const currentPrem = (pos.ceLeg.currentLTP + pos.peLeg.currentLTP) * pos.lotSize;
        const pnl = pos.entryPremiumRupees - currentPrem;
        msg += `• Current P&L: <b>₹${pnl.toFixed(2)}</b>\n`;
      }
    } else {
      msg += `ℹ️ No open position.`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // Soft pause (§2.3)
  bot.command('kill', async (ctx) => {
    modeManager.setKill(true);
    await ctx.reply(
      '🛑 Soft pause (.kill) enabled. New entries are blocked. Live positions remain protected.'
    );
  });

  bot.command('unkill', async (ctx) => {
    modeManager.setKill(false);
    await ctx.reply('▶️ Soft pause (.kill) removed. Normal entry checks resumed.');
  });

  // Hard stop (§2.3 - panic exit)
  bot.command('panic', async (ctx) => {
    modeManager.setPanic(true);
    await ctx.reply(
      '🚨🚨 PANIC triggered! Halting everything and closing active position immediately...'
    );
    const pos = niftyPositionStore.getPosition();
    if (pos && pos.status === 'OPEN') {
      await exitStraddlePosition('PANIC', pos.ceLeg.currentLTP || 0, pos.peLeg.currentLTP || 0);
    }
  });

  bot.command('unpanic', async (ctx) => {
    modeManager.setPanic(false);
    await ctx.reply('✅ PANIC mode cleared.');
  });

  bot
    .launch()
    .then(() => {
      logger.info('Telegram bot polling started successfully.');
    })
    .catch((err) => {
      logger.error(`Telegram bot launch error: ${err.message}`);
    });
}
