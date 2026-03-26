#!/usr/bin/env npx tsx
/**
 * Square Payments Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/square/square.ts create-payment-link --amount 250 --description "RV Camper Deposit — John Smith"
 *   npx tsx tools/square/square.ts check-payment --payment-id "abc123"
 *   npx tsx tools/square/square.ts list-payments --begin "2026-02-01T00:00:00Z" --end "2026-02-28T23:59:59Z"
 *
 * Environment variables:
 *   SQUARE_ACCESS_TOKEN — Square API access token
 *   SQUARE_LOCATION_ID — Square location ID
 *   SQUARE_ENVIRONMENT — "sandbox" or "production" (default: production)
 */

type Action = 'create-payment-link' | 'check-payment' | 'list-payments' | 'revenue-summary';

interface Args {
  action: Action;
  flags: Record<string, string>;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  const validActions: Action[] = [
    'create-payment-link',
    'check-payment',
    'list-payments',
    'revenue-summary',
  ];
  if (!validActions.includes(action)) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Unknown action "${action}". Use: ${validActions.join(', ')}`,
        usage: [
          'npx tsx tools/square/square.ts create-payment-link --amount 250 --description "RV Camper Deposit"',
          'npx tsx tools/square/square.ts check-payment --payment-id "abc123"',
          'npx tsx tools/square/square.ts list-payments --begin "2026-02-01T00:00:00Z"',
          'npx tsx tools/square/square.ts revenue-summary --days 30',
        ],
      }),
    );
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return { action, flags };
}

function getConfig(): {
  accessToken: string;
  locationId: string;
  baseUrl: string;
} {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment = process.env.SQUARE_ENVIRONMENT || 'production';

  if (!accessToken) {
    console.log(
      JSON.stringify({
        status: 'error',
        error:
          'Missing SQUARE_ACCESS_TOKEN environment variable. Get it from Square Developer Dashboard.',
      }),
    );
    process.exit(1);
  }

  if (!locationId) {
    console.log(
      JSON.stringify({
        status: 'error',
        error:
          'Missing SQUARE_LOCATION_ID environment variable. Get it from Square Developer Dashboard → Locations.',
      }),
    );
    process.exit(1);
  }

  const baseUrl =
    environment === 'sandbox'
      ? 'https://connect.squareupsandbox.com/v2'
      : 'https://connect.squareup.com/v2';

  return { accessToken, locationId, baseUrl };
}

async function squareRequest(
  config: ReturnType<typeof getConfig>,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Square API error ${response.status}: ${JSON.stringify(data.errors || data)}`,
    );
  }

  return data;
}

// ── Actions ────────────────────────────────────────────────────────

async function createPaymentLink(
  config: ReturnType<typeof getConfig>,
  flags: Record<string, string>,
): Promise<void> {
  const amountStr = flags['amount'];
  const description = flags['description'] || 'Sheridan Rentals Payment';
  const customerName = flags['customer-name'] || '';
  const customerEmail = flags['customer-email'] || '';

  if (!amountStr) {
    console.log(
      JSON.stringify({
        status: 'error',
        error:
          'Missing --amount flag. Specify amount in dollars (e.g., --amount 250)',
      }),
    );
    return;
  }

  const amountCents = Math.round(parseFloat(amountStr) * 100);
  if (isNaN(amountCents) || amountCents <= 0) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Invalid amount "${amountStr}". Must be a positive number.`,
      }),
    );
    return;
  }

  const idempotencyKey = `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const orderRequest: any = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: config.locationId,
      line_items: [
        {
          name: description,
          quantity: '1',
          base_price_money: {
            amount: amountCents,
            currency: 'USD',
          },
        },
      ],
    },
    checkout_options: {
      allow_tipping: false,
      redirect_url: 'https://sheridantrailerrentals.us/thank-you',
      ask_for_shipping_address: false,
    },
  };

  // Add pre-populated buyer info if provided
  if (customerEmail) {
    orderRequest.pre_populated_data = {
      buyer_email: customerEmail,
    };
  }

  try {
    const data = await squareRequest(
      config,
      'POST',
      '/online-checkout/payment-links',
      orderRequest,
    );

    const link = data.payment_link;
    const orderId = link?.order_id;

    console.log(
      JSON.stringify({
        status: 'success',
        paymentLink: link?.url || link?.long_url,
        paymentLinkId: link?.id,
        orderId: orderId,
        amount: amountStr,
        description,
        message: `Payment link created for $${amountStr}. Send this link to the customer.`,
      }),
    );
  } catch (err: any) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Failed to create payment link: ${err.message}`,
      }),
    );
  }
}

async function checkPayment(
  config: ReturnType<typeof getConfig>,
  flags: Record<string, string>,
): Promise<void> {
  const orderId = flags['order-id'];
  const paymentId = flags['payment-id'];

  if (!orderId && !paymentId) {
    console.log(
      JSON.stringify({
        status: 'error',
        error:
          'Specify --order-id (from create-payment-link) or --payment-id to check.',
      }),
    );
    return;
  }

  try {
    if (orderId) {
      // Check order status (covers payment link flow)
      const data = await squareRequest(
        config,
        'GET',
        `/orders/${orderId}`,
      );

      const order = data.order;
      const tenders = order?.tenders || [];
      const isPaid = tenders.length > 0;
      const totalPaid = tenders.reduce(
        (sum: number, t: any) => sum + (t.amount_money?.amount || 0),
        0,
      );

      console.log(
        JSON.stringify({
          status: 'success',
          orderId: order?.id,
          orderState: order?.state,
          isPaid,
          totalPaidCents: totalPaid,
          totalPaidDollars: (totalPaid / 100).toFixed(2),
          tenderCount: tenders.length,
          createdAt: order?.created_at,
          updatedAt: order?.updated_at,
        }),
      );
    } else {
      // Check specific payment
      const data = await squareRequest(
        config,
        'GET',
        `/payments/${paymentId}`,
      );

      const payment = data.payment;
      console.log(
        JSON.stringify({
          status: 'success',
          paymentId: payment?.id,
          paymentStatus: payment?.status,
          amountCents: payment?.amount_money?.amount,
          amountDollars: (
            (payment?.amount_money?.amount || 0) / 100
          ).toFixed(2),
          receiptUrl: payment?.receipt_url,
          createdAt: payment?.created_at,
          updatedAt: payment?.updated_at,
        }),
      );
    }
  } catch (err: any) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Failed to check payment: ${err.message}`,
      }),
    );
  }
}

async function listPayments(
  config: ReturnType<typeof getConfig>,
  flags: Record<string, string>,
): Promise<void> {
  const beginTime =
    flags['begin'] || new Date(Date.now() - 7 * 86400000).toISOString();
  const endTime = flags['end'] || new Date().toISOString();
  const limit = flags['limit'] || '20';

  try {
    const params = new URLSearchParams({
      begin_time: beginTime,
      end_time: endTime,
      sort_order: 'DESC',
      limit,
      location_id: config.locationId,
    });

    const data = await squareRequest(
      config,
      'GET',
      `/payments?${params.toString()}`,
    );

    const payments = (data.payments || []).map((p: any) => ({
      id: p.id,
      status: p.status,
      amountCents: p.amount_money?.amount,
      amountDollars: ((p.amount_money?.amount || 0) / 100).toFixed(2),
      description: p.note || p.receipt_url,
      createdAt: p.created_at,
      receiptUrl: p.receipt_url,
    }));

    console.log(
      JSON.stringify({
        status: 'success',
        paymentCount: payments.length,
        payments,
        dateRange: { begin: beginTime, end: endTime },
      }),
    );
  } catch (err: any) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Failed to list payments: ${err.message}`,
      }),
    );
  }
}

async function revenueSummary(
  config: ReturnType<typeof getConfig>,
  flags: Record<string, string>,
): Promise<void> {
  const days = parseInt(flags['days'] || '30', 10);
  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 86400000);
  const priorStart = new Date(periodStart.getTime() - days * 86400000);

  try {
    // Fetch current period and prior period in parallel
    const [currentData, priorData] = await Promise.all([
      squareRequest(config, 'GET', `/payments?${new URLSearchParams({
        begin_time: periodStart.toISOString(),
        end_time: now.toISOString(),
        sort_order: 'DESC',
        limit: '200',
        location_id: config.locationId,
      }).toString()}`),
      squareRequest(config, 'GET', `/payments?${new URLSearchParams({
        begin_time: priorStart.toISOString(),
        end_time: periodStart.toISOString(),
        sort_order: 'DESC',
        limit: '200',
        location_id: config.locationId,
      }).toString()}`),
    ]);

    const currentPayments = (currentData.payments || []).filter((p: any) => p.status === 'COMPLETED');
    const priorPayments = (priorData.payments || []).filter((p: any) => p.status === 'COMPLETED');

    const currentRevenue = currentPayments.reduce((s: number, p: any) => s + (p.amount_money?.amount || 0), 0);
    const priorRevenue = priorPayments.reduce((s: number, p: any) => s + (p.amount_money?.amount || 0), 0);

    const currentRefunds = currentPayments.reduce((s: number, p: any) => s + (p.refunded_money?.amount || 0), 0);
    const netRevenue = currentRevenue - currentRefunds;

    const revenueChangePct = priorRevenue > 0
      ? Math.round(((currentRevenue - priorRevenue) / priorRevenue) * 100)
      : currentRevenue > 0 ? 100 : 0;

    // Break down by description/note to identify equipment types
    const byEquipment: Record<string, { count: number; revenue: number }> = {};
    for (const p of currentPayments) {
      // Try to identify equipment from order line items or note
      let label = 'Other';
      const note = (p.note || '').toLowerCase();
      const lineItems = p.order?.line_items || [];
      const itemName = lineItems[0]?.name?.toLowerCase() || note;

      if (itemName.includes('rv') || itemName.includes('camper')) label = 'RV Camper';
      else if (itemName.includes('car hauler') || itemName.includes('car-hauler')) label = 'Car Hauler';
      else if (itemName.includes('landscaping') || itemName.includes('landscape')) label = 'Landscaping Trailer';
      else if (itemName.includes('generator')) label = 'Generator Add-on';
      else if (itemName.includes('delivery')) label = 'Delivery';
      else if (itemName.includes('deposit')) {
        if (itemName.includes('250') || itemName.includes('rv')) label = 'RV Camper';
        else label = 'Deposit (unspecified)';
      }

      if (!byEquipment[label]) byEquipment[label] = { count: 0, revenue: 0 };
      byEquipment[label].count++;
      byEquipment[label].revenue += (p.amount_money?.amount || 0);
    }

    const equipmentBreakdown = Object.entries(byEquipment)
      .sort(([, a], [, b]) => b.revenue - a.revenue)
      .map(([name, data]) => ({
        equipment: name,
        transactions: data.count,
        revenue_dollars: (data.revenue / 100).toFixed(2),
      }));

    // Daily average
    const dailyAvg = days > 0 ? currentRevenue / days : 0;

    console.log(JSON.stringify({
      status: 'success',
      command: 'revenue-summary',
      period: {
        days,
        start: periodStart.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0],
      },
      current_period: {
        total_transactions: currentPayments.length,
        gross_revenue_dollars: (currentRevenue / 100).toFixed(2),
        refunds_dollars: (currentRefunds / 100).toFixed(2),
        net_revenue_dollars: (netRevenue / 100).toFixed(2),
        daily_average_dollars: (dailyAvg / 100).toFixed(2),
      },
      prior_period: {
        total_transactions: priorPayments.length,
        gross_revenue_dollars: (priorRevenue / 100).toFixed(2),
      },
      period_over_period: {
        revenue_change_pct: revenueChangePct,
        transaction_change: currentPayments.length - priorPayments.length,
        trend: revenueChangePct > 5 ? 'growing' : revenueChangePct < -5 ? 'declining' : 'stable',
      },
      equipment_breakdown: equipmentBreakdown,
    }));
  } catch (err: any) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Failed to generate revenue summary: ${err.message}`,
    }));
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { action, flags } = parseArgs();
  const config = getConfig();

  switch (action) {
    case 'create-payment-link':
      await createPaymentLink(config, flags);
      break;
    case 'check-payment':
      await checkPayment(config, flags);
      break;
    case 'list-payments':
      await listPayments(config, flags);
      break;
    case 'revenue-summary':
      await revenueSummary(config, flags);
      break;
  }
}

main().catch((err) => {
  console.log(
    JSON.stringify({
      status: 'error',
      error: `Unexpected error: ${err.message}`,
    }),
  );
  process.exit(1);
});
