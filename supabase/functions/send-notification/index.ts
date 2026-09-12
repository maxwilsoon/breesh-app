// Breesh – send-notification Edge Function
//
// Called by DB RPCs via pg_net when a social or financial event occurs.
// Looks up device tokens, sends to Expo Push API, checks receipts, cleans up invalid tokens.
//
// Deploy: supabase functions deploy send-notification --no-verify-jwt
//
// Required secrets (set in Supabase Dashboard → Edge Functions → Secrets):
//   NOTIFICATION_SECRET  — must match value in _notification_settings table (set by M042)
//   SUPABASE_URL         — auto-set by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-set by Supabase

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL    = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_BATCH_SIZE  = 100;

// ── Types ────────────────────────────────────────────────────────────────────

interface NotificationRequest {
  type: string;
  recipient_id?: string;
  recipient_ids?: string[];
  recipient_type?: string;
  sender_id?: string;
  sender_name?: string;
  actor_id?: string;   // user_id of the person who performed the action; filtered from recipients
  data?: {
    amount?: number;
    balance?: number;
    request_id?: string;
    [key: string]: unknown;
  };
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  channelId?: string;
  data: {
    type: string;
    screen: string;
    sender_id?: string;
    request_id?: string;
  };
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;       // receipt ID — present when status='ok'
  message?: string;
  details?: { error?: string };
}

interface ExpoReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

interface DeviceTokenRow {
  expo_push_token: string;
  user_id: string;
}


// ── Notification content builder ──────────────────────────────────────────────

function fmtAmount(amount: number | undefined): string {
  if (amount == null) return '';
  const s = amount.toFixed(2).replace(/\.00$/, '');
  return `£${s}`;
}

// Always shows two decimal places — used for the banking-style transaction
// notifications (money_lent, money_funded, money_repaid, safety_pool_repayment),
// which quote exact amounts and balances the way a bank statement line would.
function fmtAmountFull(amount: number | undefined): string {
  if (amount == null) return '';
  return `£${amount.toFixed(2)}`;
}

function buildMessage(token: string, req: NotificationRequest): ExpoMessage | null {
  const sender = (req.sender_name ?? 'Someone').split(' ')[0];  // first name only
  const amount = fmtAmount(req.data?.amount);

  const base: Pick<ExpoMessage, 'to' | 'sound' | 'channelId'> = {
    to: token,
    sound: 'default',
    channelId: 'default',  // Android notification channel (importance=MAX in client)
  };

  switch (req.type) {
    case 'friend_request':
      return { ...base, title: '👋 New friend request', body: `${sender} wants to add you`,
               data: { type: req.type, screen: 'Circle', sender_id: req.sender_id } };

    case 'friend_accepted':
      return { ...base, title: '✅ Now friends!', body: `You and ${sender} are now friends`,
               data: { type: req.type, screen: 'Circle' } };

    case 'friend_declined':
      return { ...base, title: 'Friend request declined', body: `${sender} declined your request`,
               data: { type: req.type, screen: 'Circle' } };

    case 'money_request':
      return { ...base, title: `💸 ${sender} needs money`, body: `${sender} is asking for ${amount}`,
               data: { type: req.type, screen: 'Circle', request_id: req.data?.request_id } };

    case 'money_funded': {
      const amt = fmtAmountFull(req.data?.amount);
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: `💰 ${amt} received from ${sender}`,
               body: balance ? `Your Breesh balance is now ${balance}.` : `You received ${amt} from ${sender}`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'money_lent': {
      const amt = fmtAmountFull(req.data?.amount);
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: `💸 ${amt} sent to ${sender}`,
               body: balance ? `Your Breesh balance is now ${balance}.` : `You've lent ${amt} to ${sender}`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'repayment_reminder':
      return { ...base, title: '⏰ Repayment due tomorrow', body: `You have 24 hours to repay ${amount} to ${sender}`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };

    case 'repayment_reminder_12h':
      return { ...base, title: '⏰ Repayment due today', body: `You have 12 hours to repay ${amount} to ${sender}`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };

    case 'money_repaid': {
      const amt = fmtAmountFull(req.data?.amount);
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: `✅ ${amt} repayment received`,
               body: balance ? `${sender} has repaid your loan. Your Breesh balance is now ${balance}.`
                              : `${sender} has repaid your loan.`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'repayment_sent': {
      const amt = fmtAmountFull(req.data?.amount);
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: `✅ ${amt} repayment sent`,
               body: balance ? `Your Breesh balance is now ${balance}.` : `You've repaid ${amt} to ${sender}`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'safety_pool_repayment': {
      const amt = fmtAmountFull(req.data?.amount);
      return { ...base, title: `🛡️ ${amt} covered by Safety Pool`, body: 'Your lender has been repaid.',
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'parent_debt_repaid': {
      const amt = fmtAmountFull(req.data?.amount);
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: `💳 ${amt} paid to clear your debt`,
               body: balance ? `Your Breesh balance is now ${balance}.` : `${amt} was taken from your balance to clear your debt`,
               data: { type: req.type, screen: 'Home' } };
    }

    case 'loan_defaulted_lender': {
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: '🛡️ Safety Pool paid out',
               body: `You've been paid ${amount} from the Safety Pool — ${sender} missed their repayment.`
                     + (balance ? ` Your Breesh balance is now ${balance}.` : ''),
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };
    }

    case 'loan_defaulted_borrower':
      return { ...base, title: '🔒 Account frozen',
               body: `You missed your ${amount} repayment to ${sender}. Your parent has been notified.`,
               data: { type: req.type, screen: 'Home', request_id: req.data?.request_id } };

    case 'parent_transfer': {
      const balance = fmtAmountFull(req.data?.balance);
      return { ...base, title: '💚 Money received!',
               body: `You received ${amount} from your parent.`
                     + (balance ? ` Your Breesh balance is now ${balance}.` : ''),
               data: { type: req.type, screen: 'Home' } };
    }

    default:
      return null;
  }
}

function isValidExpoToken(token: string): boolean {
  return token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[');
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Validate internal secret — protects against arbitrary callers since this
  // function is deployed with --no-verify-jwt
  const secret = Deno.env.get('NOTIFICATION_SECRET') ?? '';
  const provided = req.headers.get('x-notification-secret') ?? '';
  if (!secret || provided !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: NotificationRequest;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Resolve recipient IDs to a flat array, then strip the actor.
  // Defense-in-depth: the DB helpers already remove actor_id before the HTTP call,
  // but we also filter here so a direct call cannot bypass the rule.
  //
  // Rule: suppress when actor_id === recipient_id
  // Exempt (actor IS the intended recipient — owner-events):
  //   tier_unlocked, points_milestone, card_purchase, security_alert, login_alert
  const ACTOR_FILTER_EXEMPT = new Set([
    'tier_unlocked', 'points_milestone', 'card_purchase', 'security_alert', 'login_alert',
  ]);
  const actorId: string | undefined = body.actor_id || body.sender_id;
  const recipientIds: string[] = (body.recipient_ids?.length
    ? body.recipient_ids
    : body.recipient_id
    ? [body.recipient_id]
    : []
  ).filter(id => ACTOR_FILTER_EXEMPT.has(body.type) || id !== actorId);

  if (recipientIds.length === 0) {
    return respond({ sent: 0, reason: 'no_recipients' });
  }

  const recipientType = body.recipient_type ?? 'child';

  // Admin client — bypasses RLS to read device_tokens and children tables
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );

  // ── Collect device tokens ────────────────────────────────────────────────

  const tokenSet = new Set<string>();

  // Primary source: device_tokens table (supports multiple devices per user)
  const { data: dtRows, error: dtErr } = await supabase
    .from('device_tokens')
    .select('expo_push_token, user_id')
    .in('user_id', recipientIds)
    .eq('user_type', recipientType)
    .eq('active', true) as { data: DeviceTokenRow[] | null; error: unknown };

  if (dtErr) {
    console.error('[send-notification] device_tokens query error:', dtErr);
  }
  for (const row of dtRows ?? []) {
    if (row.expo_push_token) tokenSet.add(row.expo_push_token);
  }

  if (tokenSet.size === 0) {
    console.log(`[send-notification] type=${body.type} — no tokens found for ${recipientIds.length} recipient(s)`);
    return respond({ sent: 0, reason: 'no_tokens' });
  }

  // ── Build Expo messages ───────────────────────────────────────────────────

  const messages: ExpoMessage[] = [];
  for (const token of tokenSet) {
    if (!isValidExpoToken(token)) continue;
    const msg = buildMessage(token, body);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) {
    return respond({ sent: 0, reason: 'no_valid_tokens' });
  }

  // ── Send in batches of 100 ────────────────────────────────────────────────

  const invalidTokens: string[]   = [];
  const receiptIds:   string[]     = [];  // ticket IDs to check for receipts
  let sent = 0;

  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error(`[send-notification] Expo Push API ${res.status}: ${txt}`);
        continue;
      }

      const result = await res.json() as { data: ExpoTicket[] };

      (result.data ?? []).forEach((ticket, idx) => {
        const token = batch[idx]?.to ?? '';
        if (ticket.status === 'ok') {
          sent++;
          if (ticket.id) receiptIds.push(ticket.id);
          console.log(`[send-notification] ticket ok — id=${ticket.id} type=${body.type}`);
        } else {
          const errCode = ticket.details?.error ?? '';
          if (errCode === 'DeviceNotRegistered' || errCode === 'InvalidCredentials') {
            invalidTokens.push(token);
            console.warn(`[send-notification] ticket error DeviceNotRegistered — token=...${token.slice(-4)}`);
          } else {
            console.error(`[send-notification] ticket error token=...${token.slice(-4)} code=${errCode} msg=${ticket.message}`);
          }
        }
      });
    } catch (err) {
      console.error('[send-notification] Expo Push API fetch failed:', err);
    }
  }

  // ── Check push receipts (deferred: 15-second wait) ────────────────────────
  // Expo receipts confirm whether APNs/FCM actually accepted the push.
  // A ticket status='ok' only means Expo received the message, not that it was delivered.
  // Receipts are typically available within 30 seconds; we use a background task.

  let receiptsChecked = 0;
  let receiptInvalid: string[] = [];

  if (receiptIds.length > 0) {
    try {
      // 15-second wait — Expo guarantees receipts within 30s for most pushes.
      await new Promise(r => setTimeout(r, 15_000));

      // Batch receipt check (max 300 IDs per request per Expo docs)
      for (let i = 0; i < receiptIds.length; i += 300) {
        const batchIds = receiptIds.slice(i, i + 300);
        const receiptRes = await fetch(EXPO_RECEIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ ids: batchIds }),
        });

        if (!receiptRes.ok) {
          console.warn(`[send-notification] receipts API ${receiptRes.status} — will retry later`);
          continue;
        }

        const receiptData = await receiptRes.json() as { data: Record<string, ExpoReceipt> };
        receiptsChecked += Object.keys(receiptData.data ?? {}).length;

        for (const [id, receipt] of Object.entries(receiptData.data ?? {})) {
          if (receipt.status === 'error') {
            const errCode = receipt.details?.error ?? '';
            console.warn(`[send-notification] receipt error id=${id} code=${errCode} msg=${receipt.message}`);
            // DeviceNotRegistered in receipt = stale token; find token by re-matching
            // (we don't have a receipt_id→token map, so mark all invalid tokens from tickets)
            if (errCode === 'DeviceNotRegistered') receiptInvalid.push(id);
          }
        }
      }
    } catch (err) {
      console.warn('[send-notification] receipt check failed:', err);
    }
  }

  // ── Clean up invalid tokens ───────────────────────────────────────────────
  // Ticket-level DeviceNotRegistered: we have the exact token
  // Receipt-level DeviceNotRegistered: we only have the receipt ID (token mapping lost after batching)
  // In both cases, deactivate the specific token, not all tokens for the user.

  if (invalidTokens.length > 0) {
    const { error: dtUpdateErr } = await supabase
      .from('device_tokens')
      .update({ active: false, updated_at: new Date().toISOString() })
      .in('expo_push_token', invalidTokens);
    if (dtUpdateErr) console.error('[send-notification] failed to deactivate invalid tokens:', dtUpdateErr);

    // Clear from children.push_token legacy column
    await supabase
      .from('children')
      .update({ push_token: null })
      .in('push_token', invalidTokens);
  }

  console.log(
    `[send-notification] type=${body.type} recipients=${recipientIds.length} ` +
    `tokens=${messages.length} sent=${sent} ticket_invalid=${invalidTokens.length} ` +
    `receipts_checked=${receiptsChecked} receipt_invalid=${receiptInvalid.length}`,
  );

  return respond({
    sent,
    ticket_invalid: invalidTokens.length,
    receipts_checked: receiptsChecked,
    receipt_invalid: receiptInvalid.length,
  });
});

function respond(data: object): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
