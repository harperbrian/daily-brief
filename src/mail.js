import nodemailer from 'nodemailer';

/**
 * Gmail SMTP with an app password. Chosen over an email API because it needs no
 * third-party account and no domain verification — just a credential you
 * generates himself and stores as a GitHub secret.
 */
const makeTransport = (user, pass) =>
  nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });

/**
 * "ale***21@gmail.com": enough to tell two similar addresses apart in a log
 * without printing either. (Actions already redacts exact secret values, so a
 * raw address would show as ***, which is no help when checking routing.)
 */
export function maskAddress(addr) {
  const [local = '', domain = ''] = String(addr ?? '').split('@');
  if (local.length <= 5) return `${local.slice(0, 1)}***@${domain}`;
  return `${local.slice(0, 3)}***${local.slice(-2)}@${domain}`;
}

/**
 * Logs in without sending. Called first thing in a real run: on 2026-09-30 a
 * rejected app password ("534-5.7.9 Application-specific password required")
 * was only discovered after 22 minutes of scoring, and every cron trigger that
 * day repeated the whole run. Failing here costs seconds, not Actions minutes.
 */
export async function verifyMailLogin({ user, pass }) {
  await makeTransport(user, pass).verify();
}

export async function sendMail({ html, text, subject, to, user, pass, log }) {
  const transport = makeTransport(user, pass);

  const info = await transport.sendMail({
    from: `"Daily Brief" <${user}>`,
    to,
    subject,
    text,
    html,
  });

  log(`email sent to ${to} (id ${info.messageId})`);
  return info;
}

/**
 * Sent when the pipeline fails outright. A short honest failure notice is better
 * than silence — silence is indistinguishable from "no news today".
 */
export async function sendFailureNotice({ error, to, user, pass, log }) {
  try {
    await sendMail({
      to,
      user,
      pass,
      log,
      subject: `Daily Brief FAILED — ${new Date().toISOString().slice(0, 10)}`,
      text: `The daily brief did not generate today.\n\n${error?.stack ?? error}\n\nCheck the GitHub Actions run log.`,
      html: `<p>The daily brief did not generate today.</p><pre style="background:#f4f4f2;padding:12px;border-radius:6px;white-space:pre-wrap;font-size:12px;">${String(
        error?.stack ?? error
      )
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</pre><p>Check the GitHub Actions run log.</p>`,
    });
  } catch (err) {
    log(`could not send failure notice: ${err.message}`, 'error');
  }
}
