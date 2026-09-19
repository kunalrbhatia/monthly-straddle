import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Robust env boolean parser.
 *
 * NOTE: `z.coerce.boolean()` must NOT be used for env flags — it follows JS
 * truthiness, so the string "false" coerces to `true`. This helper parses the
 * string explicitly so "false" / "0" / "no" / "off" are falsy.
 */
const envBool = (defaultValue: boolean) =>
  z
    .preprocess((v) => {
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['false', '0', 'no', 'off', ''].includes(s)) return false;
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        return undefined; // unknown string -> fall back to default
      }
      return v;
    }, z.boolean().default(defaultValue));

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Broker Credentials
  API_KEY: z.string().default(''),
  CLIENT_CODE: z.string().default(''),
  CLIENT_PIN: z.string().default(''),
  CLIENT_TOTP_PIN: z.string().default(''),

  // Telegram
  USE_TELEGRAM: envBool(false),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),

  // Slack
  USE_SLACK: envBool(false),
  SLACK_WEBHOOK_URL: z.string().optional().default(''),
  SLACK_SIGNING_SECRET: z.string().optional().default(''),

  // Strategy Config
  LOT_SIZE: z.coerce.number().default(65),
  TARGET_DTE: z.coerce.number().default(45),
  HARD_EXIT_DTE: z.coerce.number().default(21),
  PT_PCT_OF_PREMIUM: z.coerce.number().default(50),
  SL_PCT_OF_PREMIUM: z.coerce.number().default(100),
  ENTRY_JOB_HOUR: z.coerce.number().default(15),
  ENTRY_JOB_MINUTE: z.coerce.number().default(0),
  REPORT_HOUR: z.coerce.number().default(15),
  REPORT_MINUTE: z.coerce.number().default(40),

  PAPER_MODE: envBool(true),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
