/**
 * Tiny Quo (OpenPhone) SMS client for the booking service.
 *
 * Single purpose: send a license-upload link to a customer after an
 * agent-initiated booking is paid. Not a general-purpose Quo client —
 * for that, see src/channels/quo.ts in the main NanoClaw process.
 *
 * Reads QUO_API_KEY + QUO_SHERIDAN_PHONE_ID + QUO_SHERIDAN_NUMBER from env.
 */
const QUO_API_BASE = 'https://api.openphone.com/v1';

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (raw.startsWith('+')) return raw;
  return `+${digits}`;
}

export async function sendQuoSMS(toPhone: string, body: string): Promise<{
  ok: boolean;
  status: number;
  error?: string;
}> {
  const apiKey = process.env.QUO_API_KEY;
  const phoneId = process.env.QUO_SHERIDAN_PHONE_ID;
  const fromNumber = process.env.QUO_SHERIDAN_NUMBER;

  if (!apiKey || !phoneId || !fromNumber) {
    return {
      ok: false,
      status: 0,
      error: 'Missing QUO_API_KEY, QUO_SHERIDAN_PHONE_ID, or QUO_SHERIDAN_NUMBER',
    };
  }

  const to = normalizePhone(toPhone);
  const payload = {
    from: fromNumber,
    to: [to],
    content: body,
    phoneNumberId: phoneId,
  };

  try {
    const res = await fetch(`${QUO_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
}
