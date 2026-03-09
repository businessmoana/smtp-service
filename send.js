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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolve4 = promisify(dns.resolve4);

const FROM_EMAIL = 'businessmoana118@gmail.com';
const EMAILS_FILE = join(__dirname, 'emails_merged.txt');
const GMAIL_SMTP_HOST = 'smtp.gmail.com';

// Load recipients from file (comma-separated on one or more lines)
function loadEmails() {
  const raw = readFileSync(EMAILS_FILE, 'utf8');
  const emails = raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return [...new Set(emails)];
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const subject = process.env.SUBJECT || 'Hello';
  const text = process.env.BODY || 'This message was sent from the SMTP sender script.';
  const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

  const recipients = loadEmails();
  if (limit && limit > 0) recipients.splice(limit);
  console.log(`Loaded ${recipients.length} recipient(s) from emails_merged.txt`);

  if (dryRun) {
    console.log('Dry run – not sending. Recipients (first 10):', recipients.slice(0, 10));
    return;
  }

  const transporter = await createTransporter();
  let sent = 0;
  let failed = 0;

  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: FROM_EMAIL,
        to,
        subject,
        text,
      });
      sent++;
      if (sent % 50 === 0) console.log(`Sent ${sent}/${recipients.length}...`);
    } catch (err) {
      failed++;
      console.error(`Failed to send to ${to}:`, err.message);
    }
  }

  console.log(`Done. Sent: ${sent}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
