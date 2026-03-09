/**
 * Send emails via Gmail SMTP using addresses from emails_merged.txt
 * From: businessmoana118@gmail.com
 *
 * Setup:
 * 1. Copy .env.example to .env
 * 2. Add your Gmail App Password to .env (not your normal password)
 *    Create one at: https://myaccount.google.com/apppasswords
 * 3. Run: npm run send
 *    Or dry run (no send): npm run send:dry
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

const FROM_EMAIL = 'businessmoana118@gmail.com';
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

async function createTransporter() {
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!password) {
    throw new Error(
      'Missing GMAIL_APP_PASSWORD in .env. Create an App Password at https://myaccount.google.com/apppasswords'
    );
  }
  const useSSL = process.env.SMTP_SSL !== '0';
  const port = useSSL ? 465 : 587;

  let host = GMAIL_SMTP_HOST;
  const useDirectIP = process.env.SMTP_BYPASS_DNS !== '0'; // default on: resolve via 8.8.8.8 to avoid 10.x redirect
  if (useDirectIP) {
    host = await resolveGmailHost();
    console.log(`Using Gmail IP (bypass DNS): ${host}:${port}`);
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: useSSL,
    auth: {
      user: FROM_EMAIL,
      pass: password,
    },
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

  let recipients = loadEmails();
  const results = loadResults();
  // Skip addresses we already sent to (so restart doesn't re-send)
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

  const transporter = await createTransporter();
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      await transporter.sendMail({
        from: FROM_EMAIL,
        to,
        subject,
        text,
      });
      sent++;
      saveResult(results, to, 'sent');
      if (sent % 50 === 0) console.log(`Sent ${sent}/${recipients.length}...`);
    } catch (err) {
      failed++;
      saveResult(results, to, 'failed', err.message);
      console.error(`Failed to send to ${to}:`, err.message);
      const is454 = String(err.message).includes('454') || String(err.message).includes('Too many login attempts');
      if (is454 && rateLimitWaitMin > 0) {
        console.error(`\nGmail rate limit (454). Waiting ${rateLimitWaitMin} minutes, then retrying...`);
        await sleep(rateLimitWaitMin * 60 * 1000);
        try {
          const t = await createTransporter();
          await t.sendMail({ from: FROM_EMAIL, to, subject, text });
          sent++;
          failed--;
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

  console.log(`Done. Sent: ${sent}, Failed: ${failed}. Results saved to ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
