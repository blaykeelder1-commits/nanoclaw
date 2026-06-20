/**
 * Email notifications for Sheridan Rentals Booking API.
 * Sends branded emails: owner notification + customer confirmation.
 * Adapted from nanoclaw/tools/email/send-email.ts
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { Booking, EquipmentKey, PriceBreakdown } from './types.js';
import { EQUIPMENT } from './pricing.js';

/** "nights" for RV, "days" otherwise. Empty string if unknown equipment. */
function unitLabel(booking: Booking): string {
  const unit = EQUIPMENT[booking.equipment as EquipmentKey]?.unit || 'day';
  return `${booking.numDays} ${unit}${booking.numDays > 1 ? 's' : ''}`;
}

/** 'HH:MM' (24h) -> '9:00 AM'. Empty string in/out. */
function fmtTime12(hhmm: string): string {
  if (!hhmm) return '';
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr || '00'} ${ampm}`;
}

/** 'YYYY-MM-DD' -> 'Jul 31, 2026'. Falls back to the input if malformed. */
function prettyDate(dateStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = (dateStr || '').split('-');
  if (p.length !== 3) return dateStr || '';
  return `${months[parseInt(p[1], 10) - 1]} ${parseInt(p[2], 10)}, ${p[0]}`;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('Missing SMTP configuration (SMTP_HOST, SMTP_USER, SMTP_PASS)');
  }

  transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter;
}

async function sendWithRetry(
  t: Transporter,
  mailOptions: Parameters<Transporter['sendMail']>[0],
  maxRetries = 3,
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await t.sendMail(mailOptions);
      if (info.rejected && info.rejected.length > 0) {
        console.warn(`[email] Rejected recipients: ${info.rejected.join(', ')}`);
      }
      const accepted = (info.accepted || []).length;
      console.log(`[email] sent to=${mailOptions.to} subject="${mailOptions.subject}" accepted=${accepted}`);
      return;
    } catch (err: any) {
      lastError = err;
      console.error(`[email] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError || new Error('Email send failed after retries');
}

const FROM_NAME = 'Sheridan Rentals';

function getOwnerEmail(): string {
  // Comma-separated list supported; nodemailer accepts the raw string.
  // Default points at the inbox the owner actually reads (snakgroupteam@snakgroup.biz)
  // — never default to sheridantrailerrentals@gmail.com because its forwarder
  // loops back to snakgroupteam, and Gmail silently drops the message.
  return process.env.OWNER_EMAIL || 'snakgroupteam@snakgroup.biz';
}

function getFrom(): string {
  const user = process.env.SMTP_USER || '';
  return process.env.SMTP_FROM || `${FROM_NAME} <${user}>`;
}

// ── Owner Notification ──────────────────────────────────────────────

export async function sendOwnerNotification(booking: Booking): Promise<void> {
  const t = getTransporter();
  const dates = booking.dates;
  const dateRange = dates.length === 1
    ? dates[0]
    : `${dates[0]} to ${dates[dates.length - 1]}`;

  const statusLabel =
    booking.status === 'confirmed' ? 'PAID IN FULL'
    : booking.status === 'paid'    ? 'DEPOSIT PAID'
    :                                 'PENDING PAYMENT';

  await sendWithRetry(t, {
    from: getFrom(),
    to: getOwnerEmail(),
    subject: `New Booking: ${booking.equipmentLabel} — ${dateRange} [${statusLabel}]`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1d4ed8; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0; font-size: 20px;">New Booking — ${booking.equipmentLabel}</h2>
          <p style="margin: 4px 0 0; opacity: 0.9; font-size: 14px;">${statusLabel}</p>
        </div>

        <div style="background: #f9fafb; padding: 20px 24px; border: 1px solid #e5e7eb; border-top: none;">
          <h3 style="margin: 0 0 12px; color: #374151;">Customer</h3>
          <table style="font-size: 14px; color: #4b5563;">
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Name:</td><td>${booking.customer.firstName} ${booking.customer.lastName}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Email:</td><td><a href="mailto:${booking.customer.email}">${booking.customer.email}</a></td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Phone:</td><td><a href="tel:${booking.customer.phone}">${booking.customer.phone}</a></td></tr>
          </table>

          <h3 style="margin: 16px 0 12px; color: #374151;">Booking Details</h3>
          <table style="font-size: 14px; color: #4b5563;">
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Duration:</td><td>${unitLabel(booking)}</td></tr>
            ${booking.addOns.length > 0 ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Add-ons:</td><td>${booking.addOns.join(', ')}</td></tr>` : ''}
            ${booking.deliveryAddress ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Delivery to:</td><td>${escapeHtml(booking.deliveryAddress)}</td></tr>` : ''}
            ${booking.pickupTime ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Pickup time:</td><td>${fmtTime12(booking.pickupTime)} (due back same time on drop-off)</td></tr>` : ''}
            ${booking.details ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Notes:</td><td>${escapeHtml(booking.details)}</td></tr>` : ''}
          </table>

          <h3 style="margin: 16px 0 12px; color: #374151;">Pricing</h3>
          <table style="font-size: 14px; color: #4b5563; width: 100%; max-width: 300px;">
            <tr><td style="padding: 2px 0;">Subtotal:</td><td style="text-align: right;">$${booking.subtotal.toFixed(2)}</td></tr>
            <tr style="color: #1d4ed8; font-weight: 600;"><td style="padding: 2px 0;">Deposit:</td><td style="text-align: right;">$${booking.deposit.toFixed(2)}</td></tr>
            <tr><td style="padding: 2px 0;">Balance at pickup:</td><td style="text-align: right;">$${booking.balance.toFixed(2)}</td></tr>
          </table>

          ${agreementLinkRow(booking)}

          <p style="margin: 16px 0 0; font-size: 13px; color: #9ca3af;">
            Booking ID: ${booking.id} | Created: ${new Date(booking.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })}
          </p>
        </div>
      </div>
    `,
  });
}

// ── Customer Confirmation ───────────────────────────────────────────

export async function sendCustomerConfirmation(booking: Booking): Promise<void> {
  const t = getTransporter();
  const dates = booking.dates;
  const dateRange = dates.length === 1
    ? dates[0]
    : `${dates[0]} to ${dates[dates.length - 1]}`;

  const isDepositOnly = booking.balance > 0;
  const amountPaid = isDepositOnly ? booking.deposit : booking.subtotal + booking.deposit;
  const subject = isDepositOnly
    ? `Deposit Received — ${booking.equipmentLabel} | Sheridan Rentals`
    : `Booking Confirmed — ${booking.equipmentLabel} | Sheridan Rentals`;
  const headline = isDepositOnly ? 'Deposit Received!' : 'Booking Confirmed!';
  const intro = isDepositOnly
    ? `Your $${booking.deposit.toFixed(2)} deposit has been received and your dates are reserved! Remaining balance of $${booking.balance.toFixed(2)} is due before your rental starts.`
    : 'Your payment has been received and your booking is confirmed! Here are your details:';

  const balanceRow = isDepositOnly
    ? `<tr><td style="padding: 4px 0; font-weight: 600; color: #d97706;">Balance Due:</td><td style="color: #d97706;">$${booking.balance.toFixed(2)} (due before pickup)</td></tr>`
    : '';

  const locLine = booking.deliveryAddress
    ? `<li>See your delivery address above — we'll bring it to you</li>`
    : `<li>See your pickup location${booking.pickupTime ? ' and time' : ''} above</li>`;
  const nextSteps = isDepositOnly
    ? `<li>We'll send a payment link for the remaining $${booking.balance.toFixed(2)} before your pickup date</li>
            <li>Lock code sent after full payment is received</li>
            ${locLine}
            <li>Questions? Just reply to this email or text us</li>`
    : `<li>You'll receive the lock code to access the trailer shortly</li>
            ${locLine}
            <li>Questions? Just reply to this email or text us</li>`;

  await sendWithRetry(t, {
    from: getFrom(),
    to: booking.customer.email,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1d4ed8; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">${headline}</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Sheridan Trailer Rentals</p>
        </div>

        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="font-size: 16px; color: #374151;">Hi ${escapeHtml(booking.customer.firstName)},</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
            ${intro}
          </p>

          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <table style="font-size: 14px; color: #4b5563; width: 100%;">
              <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Duration:</td><td>${unitLabel(booking)}</td></tr>
              ${booking.addOns.length > 0 ? `<tr><td style="padding: 4px 0; font-weight: 600;">Add-Ons:</td><td>${booking.addOns.join(', ')}</td></tr>` : ''}
              <tr><td style="padding: 4px 0; font-weight: 600; color: #16a34a;">Amount Paid:</td><td style="color: #16a34a;">$${amountPaid.toFixed(2)}</td></tr>
              ${balanceRow}
            </table>
          </div>

          ${booking.deliveryAddress ? `
          <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <h3 style="margin: 0 0 8px; color: #1d4ed8; font-size: 15px;">🚚 Delivery Address</h3>
            <p style="margin: 0; font-size: 14px; color: #374151; font-weight: 600;">${escapeHtml(booking.deliveryAddress)}</p>
            <p style="margin: 8px 0 0; font-size: 13px; color: #6b7280;">We'll deliver your camper here. Exact drop-off details and the lock code are sent before your date.</p>
          </div>` : `
          <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <h3 style="margin: 0 0 8px; color: #1d4ed8; font-size: 15px;">📍 Pickup &amp; Return Location</h3>
            <p style="margin: 0; font-size: 14px; color: #374151; font-weight: 600;">14235 Alice Road, Tomball, TX 77377</p>
            ${booking.pickupTime ? `<p style="margin: 8px 0 0; font-size: 13px; color: #374151;"><strong>Pickup time:</strong> ${fmtTime12(booking.pickupTime)} — return by ${fmtTime12(booking.pickupTime)} on ${prettyDate(booking.dates[booking.dates.length - 1])}</p>` : ''}
          </div>`}

          <h3 style="color: #374151; margin: 20px 0 8px;">Next Steps</h3>
          <ol style="font-size: 14px; color: #4b5563; line-height: 1.8; padding-left: 20px;">
            ${nextSteps}
          </ol>

          <p style="font-size: 14px; color: #4b5563; margin-top: 20px;">
            Questions? Reply to this email or text us — we're always available.
          </p>

          ${finishBookingSection(booking)}

          <p style="font-size: 13px; color: #9ca3af; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
            Booking ID: ${booking.id}<br>
            Sheridan Trailer Rentals — Tomball, TX
          </p>
        </div>
      </div>
    `,
  });
}

function agreementLinkRow(booking: Booking): string {
  if (!booking.agreementId) return '';
  const base = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';
  const url = `${base}/api/agreements/${booking.agreementId}`;
  return `
    <p style="font-size: 13px; color: #4b5563; margin-top: 14px; padding-top: 14px; border-top: 1px solid #e5e7eb;">
      <strong>Signed rental agreement:</strong> <a href="${url}" style="color: #0e7490;">${url}</a>
    </p>`;
}

function finishBookingSection(booking: Booking): string {
  const base = process.env.BOOKING_PUBLIC_BASE_URL || 'https://chat.sheridantrailerrentals.us';

  // Already signed — link the completed agreement for their records.
  if (booking.agreementId) {
    const url = `${base}/api/agreements/${booking.agreementId}`;
    return `
    <p style="font-size: 13px; color: #4b5563; margin-top: 14px; padding-top: 14px; border-top: 1px solid #e5e7eb;">
      <strong>Signed rental agreement:</strong> <a href="${url}" style="color: #0e7490;">${url}</a>
    </p>`;
  }

  // Not signed yet — show the steps still needed to release the lock code.
  const items: string[] = [];
  if (!booking.licenseFileId) {
    const licenseUrl = `${base}/license/${booking.id}`;
    items.push(`<li style="margin-bottom: 12px;">📷 <strong>Upload your driver&rsquo;s license</strong><br><a href="${licenseUrl}" style="color: #1d4ed8; word-break: break-all;">${licenseUrl}</a></li>`);
  }
  if (booking.signToken) {
    const signUrl = `${base}/sign/${booking.id}/${booking.signToken}`;
    items.push(`<li style="margin-bottom: 0;">✍️ <strong>Sign your rental agreement</strong><br><a href="${signUrl}" style="color: #1d4ed8; word-break: break-all;">${signUrl}</a></li>`);
  }
  if (items.length === 0) return '';

  return `
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <h3 style="margin: 0 0 8px; color: #b45309; font-size: 15px;">⚡ One quick step to finish</h3>
      <p style="margin: 0 0 12px; font-size: 13px; color: #92400e; line-height: 1.5;">Your payment is in and your dates are reserved. To release your lock code, just complete the following &mdash; it only takes a minute:</p>
      <ul style="margin: 0; padding-left: 0; font-size: 14px; color: #374151; line-height: 1.5; list-style: none;">
        ${items.join('\n        ')}
      </ul>
    </div>`;
}

// ── Payment Received Notification (to owner) ────────────────────────

export async function sendPaymentReceivedNotification(booking: Booking): Promise<void> {
  const t = getTransporter();

  await sendWithRetry(t, {
    from: getFrom(),
    to: getOwnerEmail(),
    subject: `${booking.balance > 0 ? 'Deposit' : 'Full Payment'} Received: ${booking.equipmentLabel} — ${booking.customer.firstName} ${booking.customer.lastName} ($${(booking.balance > 0 ? booking.deposit : booking.subtotal + booking.deposit).toFixed(2)})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #16a34a; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">${booking.balance > 0 ? 'Deposit' : 'Full Payment'} Received — $${(booking.balance > 0 ? booking.deposit : booking.subtotal + booking.deposit).toFixed(2)}</h2>
        </div>
        <div style="background: #f9fafb; padding: 20px 24px; border: 1px solid #e5e7eb; border-top: none; font-size: 14px; color: #4b5563;">
          <p><strong>${booking.customer.firstName} ${booking.customer.lastName}</strong> paid $${(booking.balance > 0 ? booking.deposit : booking.subtotal + booking.deposit).toFixed(2)} for <strong>${booking.equipmentLabel}</strong>.</p>
          <p>Dates: ${booking.dates[0]} to ${booking.dates[booking.dates.length - 1]} (${unitLabel(booking)})</p>
          ${booking.balance > 0 ? `<p>Balance remaining: $${booking.balance.toFixed(2)} (due before pickup)</p>` : '<p>Fully paid — no balance remaining.</p>'}
          <p>Calendar event created. Customer confirmation email sent.</p>
          <p style="color: #9ca3af; font-size: 13px; margin-top: 16px;">Booking ID: ${booking.id}</p>
        </div>
      </div>
    `,
  });
}

// ── Cancellation Confirmation ────────────────────────────────────────

export async function sendCancellationConfirmation(booking: Booking, refundAmount: number): Promise<void> {
  const t = getTransporter();

  await sendWithRetry(t, {
    from: getFrom(),
    to: booking.customer.email,
    subject: `Booking Cancelled — ${booking.equipmentLabel} | Sheridan Rentals`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #dc2626; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Booking Cancelled</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Sheridan Trailer Rentals</p>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="font-size: 16px; color: #374151;">Hi ${escapeHtml(booking.customer.firstName)},</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
            Your booking has been cancelled. ${refundAmount > 0 ? `A refund of <strong>$${(refundAmount / 100).toFixed(2)}</strong> has been initiated and should appear in your account within 5-10 business days.` : ''}
          </p>
          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <table style="font-size: 14px; color: #4b5563; width: 100%;">
              <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${booking.dates[0]} to ${booking.dates[booking.dates.length - 1]}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Booking ID:</td><td>${booking.id}</td></tr>
            </table>
          </div>
          <p style="font-size: 14px; color: #4b5563; margin-top: 20px;">
            We're sorry to see you go. If you'd like to rebook, visit our website or text us anytime.
          </p>
          <p style="font-size: 13px; color: #9ca3af; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
            Sheridan Trailer Rentals — Tomball, TX
          </p>
        </div>
      </div>
    `,
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
