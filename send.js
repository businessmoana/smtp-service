/**
 * Send emails via Gmail SMTP using addresses from emails_merged.txt
 *
 * Single account: set GMAIL_APP_PASSWORD (and optionally FROM_EMAIL).
 * Multiple accounts: set ACCOUNT_1_EMAIL, ACCOUNT_1_APP_PASSWORD, ACCOUNT_2_EMAIL, ACCOUNT_2_APP_PASSWORD, ...
 *   Sends rotate: 1st → account 1, 2nd → account 2, 3rd → account 1, etc.
 *   Set PER_ACCOUNT_LIMIT=200 to cap sends per account per run.
 *
 * Setup:
 * 1. Copy .env.example to .env
 * 2. Add Gmail App Password(s) – create at https://myaccount.google.com/apppasswords
 * 3. Run: npm run send   or dry run: npm run send:dry
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';
import dns from 'dns';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolve4 = promisify(dns.resolve4);

const DEFAULT_FROM_EMAIL = 'businessmoana118@gmail.com';
const EMAILS_FILE = join(__dirname, 'emails_merged.txt');
const RESULTS_FILE = join(__dirname, 'send_results.json');
const GMAIL_SMTP_HOST = 'smtp.gmail.com';

/** Delay between sends (ms). Default 10s to avoid Gmail 454 "too many login attempts". */
function getDelayMs() {
  const env = process.env.DELAY_MS;
  if (env != null && env !== '') {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return 10000;
}

/** When 454 is hit, wait this many minutes then retry (0 = don't wait, just stop). */
function getRateLimitWaitMinutes() {
  const env = process.env.RATE_LIMIT_WAIT_MINUTES;
  if (env != null && env !== '') {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return 0;
}

/** When daily 550 limit is hit, wait this many hours then retry once (0 = don't wait, just stop). */
function getDailyLimitWaitHours() {
  const env = process.env.DAILY_LIMIT_WAIT_HOURS;
  if (env != null && env !== '') {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return 0;
}

/** Max emails to send per account in this run (0 = no limit). */
function getPerAccountLimit() {
  const env = process.env.PER_ACCOUNT_LIMIT;
  if (env != null && env !== '') {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return 0;
}

/** Load Gmail accounts: [{ email, password }, ...]. Supports ACCOUNT_1_EMAIL, ACCOUNT_1_APP_PASSWORD, ACCOUNT_2_*, etc. */
function loadAccounts() {
  const accounts = [];
  for (let n = 1; n <= 10; n++) {
    const email = process.env[`ACCOUNT_${n}_EMAIL`]?.trim();
    const password = process.env[`ACCOUNT_${n}_APP_PASSWORD`]?.trim?.() ?? process.env[`ACCOUNT_${n}_APP_PASSWORD`];
    if (email && password) accounts.push({ email, password });
  }
  if (accounts.length > 0) return accounts;
  const singlePass = process.env.GMAIL_APP_PASSWORD?.trim?.() ?? process.env.GMAIL_APP_PASSWORD;
  const singleEmail = (process.env.FROM_EMAIL || DEFAULT_FROM_EMAIL).trim();
  if (singlePass) return [{ email: singleEmail, password: singlePass }];
  throw new Error(
    'No accounts configured. Set GMAIL_APP_PASSWORD (and optionally FROM_EMAIL) or ACCOUNT_1_EMAIL + ACCOUNT_1_APP_PASSWORD, etc.'
  );
}

// Load recipients from file (comma-separated on one or more lines)
function loadEmails() {
  const raw = readFileSync(EMAILS_FILE, 'utf8');
  const emails = raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return [...new Set(emails)];
}

/** Load result file: { [email]: { status: 'sent'|'failed', at: ISO date, error?: string } } */
function loadResults() {
  if (!existsSync(RESULTS_FILE)) return {};
  try {
    const raw = readFileSync(RESULTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Append one result and write back so restart won't re-send. */
function saveResult(results, email, status, errorMessage = null) {
  results[email] = {
    status,
    at: new Date().toISOString(),
    ...(errorMessage != null ? { error: errorMessage } : {}),
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

/** Resolve Gmail SMTP via Google DNS to bypass network redirect to 10.x.x.x */
async function resolveGmailHost() {
  const previous = dns.getServers();
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  try {
    const addrs = await resolve4(GMAIL_SMTP_HOST);
    return addrs[0];
  } finally {
    dns.setServers(previous);
  }
}

async function createTransporter(user, password) {
  const useSSL = process.env.SMTP_SSL !== '0';
  const port = useSSL ? 465 : 587;

  let host = GMAIL_SMTP_HOST;
  const useDirectIP = process.env.SMTP_BYPASS_DNS !== '0';
  if (useDirectIP) {
    host = await resolveGmailHost();
    console.log(`Using Gmail IP (bypass DNS): ${host}:${port}`);
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: useSSL,
    auth: { user, pass: password },
    tls: host !== GMAIL_SMTP_HOST ? { servername: GMAIL_SMTP_HOST } : undefined,
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const subject = process.env.SUBJECT || 'Hello';
  const text = process.env.BODY || 'This message was sent from the SMTP sender script.';
  const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;
  const delayMs = getDelayMs();
  const rateLimitWaitMin = getRateLimitWaitMinutes();
  const dailyLimitWaitHours = getDailyLimitWaitHours();
  const perAccountLimit = getPerAccountLimit();

  const accounts = loadAccounts();
  const nAccounts = accounts.length;
  console.log(`Using ${nAccounts} Gmail account(s): ${accounts.map((a) => a.email).join(', ')}`);
  if (perAccountLimit > 0) console.log(`Per-account limit: ${perAccountLimit} sends per account this run`);

  const transporterCache = [];
  const getTransporter = async (accountIndex) => {
    if (!transporterCache[accountIndex]) {
      const { email, password } = accounts[accountIndex];
      transporterCache[accountIndex] = await createTransporter(email, password);
    }
    return transporterCache[accountIndex];
  };

  const sentCounts = new Array(nAccounts).fill(0);
  let lastUsedAccountIndex = -1;

  /** Round-robin: next account index that is under per-account limit. Returns -1 if all at limit. */
  function getNextAccountIndex() {
    for (let k = 1; k <= nAccounts; k++) {
      const j = (lastUsedAccountIndex + k) % nAccounts;
      if (perAccountLimit === 0 || sentCounts[j] < perAccountLimit) return j;
    }
    return -1;
  }

  let recipients = loadEmails();
  const results = loadResults();
  const alreadySent = recipients.filter((e) => results[e]?.status === 'sent');
  recipients = recipients.filter((e) => results[e]?.status !== 'sent');
  if (limit && limit > 0) recipients.splice(limit);
  const totalInList = recipients.length + alreadySent.length;

  console.log(`Loaded ${totalInList} recipient(s) from emails_merged.txt`);
  if (alreadySent.length > 0) {
    console.log(`Skipping ${alreadySent.length} already sent (from ${RESULTS_FILE})`);
  }
  console.log(`To send this run: ${recipients.length} (delay ${delayMs}ms between emails)`);

  if (dryRun) {
    console.log('Dry run – not sending. To send (first 10):', recipients.slice(0, 10));
    return;
  }

  if (recipients.length === 0) {
    console.log('Nothing to send.');
    return;
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    const accountIndex = getNextAccountIndex();
    if (accountIndex === -1) {
      console.log(`All accounts reached per-account limit (${perAccountLimit}). Stopping.`);
      break;
    }
    lastUsedAccountIndex = accountIndex;
    const fromEmail = accounts[accountIndex].email;

    if (i > 0 && delayMs > 0) await sleep(delayMs);

    try {
      const transporter = await getTransporter(accountIndex);
      await transporter.sendMail({
        from: fromEmail,
        to,
        subject,
        text,
      });
      sent++;
      sentCounts[accountIndex]++;
      saveResult(results, to, 'sent');
      if (sent % 50 === 0) console.log(`Sent ${sent}/${recipients.length}... (${fromEmail})`);
    } catch (err) {
      failed++;
      saveResult(results, to, 'failed', err.message);
      console.error(`Failed to send to ${to} (from ${fromEmail}):`, err.message);
      const msg = String(err.message);
      const is454 = msg.includes('454') || msg.includes('Too many login attempts');
      const is550DailyLimit = msg.includes('550') && msg.includes('Daily user sending limit exceeded');

      if (is550DailyLimit && dailyLimitWaitHours > 0) {
        console.error('\nGmail daily sending limit reached (550 5.4.5).');
        console.error(`Waiting ${dailyLimitWaitHours} hour(s), then retrying this recipient once...`);
        await sleep(dailyLimitWaitHours * 60 * 60 * 1000);
        try {
          const tDaily = await getTransporter(accountIndex);
          await tDaily.sendMail({ from: fromEmail, to, subject, text });
          sent++;
          failed--;
          sentCounts[accountIndex]++;
          saveResult(results, to, 'sent');
          console.log(`Retry after daily limit reset succeeded for ${to}`);
        } catch (retryDailyErr) {
          console.error(`Retry after daily wait failed for ${to}:`, retryDailyErr.message);
          console.error('Daily limit may still apply. Script will stop now; run again after 24 hours or switch sender.');
          break;
        }
      } else if (is550DailyLimit) {
        console.error('\nGmail daily sending limit reached (550 5.4.5).');
        console.error('You must wait ~24 hours or switch to another sender (different Gmail account or SMTP provider).');
        console.error('Script will stop now. Already-sent addresses are recorded in send_results.json.');
        break;
      } else if (is454 && rateLimitWaitMin > 0) {
        console.error(`\nGmail rate limit (454). Waiting ${rateLimitWaitMin} minutes, then retrying...`);
        await sleep(rateLimitWaitMin * 60 * 1000);
        try {
          const t = await getTransporter(accountIndex);
          await t.sendMail({ from: fromEmail, to, subject, text });
          sent++;
          failed--;
          sentCounts[accountIndex]++;
          saveResult(results, to, 'sent');
          console.log(`Retry sent to ${to}`);
        } catch (retryErr) {
          console.error(`Retry failed for ${to}:`, retryErr.message);
          console.error('Wait 30–60 minutes, then run again. Already-sent addresses will be skipped.');
          break;
        }
      } else if (is454) {
        console.error('\nGmail rate limit (454). Stop sending now.');
        console.error('Wait 30–60 minutes, then run again. Or set RATE_LIMIT_WAIT_MINUTES=30 in .env to auto-wait.');
        break;
      }
    }
  }

  if (nAccounts > 1 && perAccountLimit > 0) {
    console.log(`Per-account sends: ${accounts.map((a, j) => `${a.email}=${sentCounts[j]}`).join(', ')}`);
  }
  console.log(`Done. Sent: ${sent}, Failed: ${failed}. Results saved to ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
