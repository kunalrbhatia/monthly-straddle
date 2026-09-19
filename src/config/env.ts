import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Broker Credentials
  API_KEY: z.string().default(''),
  CLIENT_CODE: z.string().default(''),
  CLIENT_PIN: z.string().default(''),
  CLIENT_TOTP_PIN: z.string().default(''),

  // Telegram
  USE_TELEGRAM: z.coerce.boolean().default(false),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),

  // Slack
  USE_SLACK: z.coerce.boolean().default(false),
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

  PAPER_MODE: z.coerce.boolean().default(true),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
