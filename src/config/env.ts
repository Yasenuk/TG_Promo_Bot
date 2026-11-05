import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ENV_FILE = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
const envFileLoaded = (() => {
  if (!existsSync(ENV_FILE)) return false;
  try {
    process.loadEnvFile(ENV_FILE);
    return true;
  } catch {
    return false;
  }
})();

const blankToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const telegramId = z.preprocess(
  blankToUndefined,
  z
    .string({ error: 'обовʼязкова змінна' })
    .trim()
    .regex(/^-?\d+$/, 'має бути цілим числом, напр. -1001234567890')
    .transform((s) => BigInt(s)),
);

const telegramIdList = z.preprocess(
  blankToUndefined,
  z
    .string()
    .default('')
    .transform((raw, ctx) => {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const bad = parts.filter((p) => !/^-?\d+$/.test(p));
      if (bad.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `не схоже на telegram id: ${bad.join(', ')}`,
        });
        return z.NEVER;
      }

      return parts.map((p) => BigInt(p));
    }),
);

const required = (hint: string) =>
  z.preprocess(blankToUndefined, z.string({ error: hint }).min(1, hint));

const envSchema = z.object({
  NODE_ENV: z
    .preprocess(blankToUndefined, z.enum(['development', 'production', 'test']))
    .default('development'),
  LOG_LEVEL: z
    .preprocess(
      blankToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    )
    .default('info'),

  BOT_TOKEN: required('візьми токен у @BotFather'),

  ADMIN_CHAT_ID: telegramId.optional(),
  SUPER_ADMIN_IDS: telegramIdList,

  TIMEZONE: z.preprocess(blankToUndefined, z.string()).default('Europe/Kyiv'),

  DATABASE_URL: required('рядок підключення до Postgres'),
  DIRECT_DATABASE_URL: required('прямий рядок підключення, потрібен для міграцій'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'} - ${i.message}`)
    .join('\n');

  const hint = envFileLoaded
    ? `Файл прочитано: ${ENV_FILE}`
    : `⚠️  Файл .env НЕ знайдено за шляхом ${ENV_FILE}\n`;

  console.error(
    [
      '',
      '❌ Некоректна конфігурація оточення:',
      issues,
      '',
      hint,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export const env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

if (env.ADMIN_CHAT_ID === undefined) {
  console.warn(
    '\n⚠️  ADMIN_CHAT_ID не заданий - заявки на призи нікуди не надсилатимуться.\n' +
      '   Додай бота у групу і виконай там /chatid, потім впиши значення в .env.\n',
  );
}
