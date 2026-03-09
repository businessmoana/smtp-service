# SMTP sender (Node.js)

Sends email via Gmail SMTP using addresses from `emails_merged.txt`. Sender: **businessmoana118@gmail.com**.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Gmail App Password**
   - Go to [Google App Passwords](https://myaccount.google.com/apppasswords).
   - Sign in as `businessmoana118@gmail.com`.
   - Create an App Password for "Mail" (or "Other").
   - Copy the 16-character password.

3. **Create `.env`**
   ```bash
   copy .env.example .env
   ```
   Edit `.env` and set:
   ```env
   GMAIL_APP_PASSWORD=your16charapppassword
   ```
   (Spaces in the app password are optional.)

## Usage

- **Dry run** (no emails sent, just list recipients):
  ```bash
  npm run send:dry
  ```

- **Send to all** (subject/body from env or defaults):
  ```bash
  npm run send
  ```

- **Custom subject/body** in `.env`:
  ```env
  SUBJECT=Your subject
  BODY=Your message body.
  ```

- **Limit recipients** (e.g. test with 5):
  ```env
  LIMIT=5
  ```

Recipients are read from `emails_merged.txt` (comma-separated). Duplicates are removed.
