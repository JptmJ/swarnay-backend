import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'orderstest';
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Orders & Karigar', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36).toUpperCase();
  const ids: Record<string, string> = {};
  const n = (v: unknown) => Number(v);

  async function call(path: string, body?: unknown, method?: string) {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}`, 'x-branch-id': main },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const ok = async (path: string, body?: unknown, method?: string) => {
    const r = await call(path, body, method);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const code = async (path: string, body: unknown, method?: string) => (await call(path, body, method)).body.error?.code;
  const setting = (key: string, value: unknown) => call(`/api/settings/config/${key}`, { value }, 'PUT');
  const DEFAULTS: [string, unknown][] = [
    ['orders.rate_lock.default', 'booking'], ['orders.rate_lock.days', 0], ['orders.rate_lock.on_expiry', 'delivery_rate'],
    ['orders.rate_lock.allow_change', true], ['orders.advance.min_percent', 0], ['orders.delivery.require_full_payment', false],
    ['orders.repair.invoice_type', 'service'], ['orders.repair.service_sac', '998892'], ['orders.repair.service_gst_percent', 18],
    ['orders.karigar.excess_ghat', 'recover'], ['orders.sla.warn_days', 2],
  ];
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tag = async (grams: string) =>
    (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: grams, makingBasis: 'per_gram', makingRate: '500' }] })).rows[0];
  const credit = async (customerId: string) => n((await ok(`/api/pos/customers/${customerId}/balance`)).advance);

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    tenantId = existing?.id ?? (await provisionTenant({
      code: SHOP, legalName: 'Orders Test Jewellers', displayName: 'Orders Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Orders Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const o = await asPlatform(async (tx) => {
      const u = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [u.id]);
      return u;
    });
    main = o.branch;
    owner = signAccessToken({ sub: o.id, tenantId, tv: o.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const metals = (await ok('/api/master/metals')).rows;
    ids.gold = metals.find((m: Body) => m.code === 'GOLD').id;
    const purities = (await ok(`/api/master/purities?metal_id=${ids.gold}`)).rows;
    ids.k22 = purities.find((r: Body) => r.code === '22K').id;
    ids.k24 = purities.find((r: Body) => r.code === '24K').id;
    ids.counter = (await ok(`/api/master/locations?branch_id=${main}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    ids.ring = (await ok('/api/master/items', { code: `ORR${run}`, name: `Ring ${run}`, metal_id: ids.gold, tracking: 'piece', hsn_code: '7113' })).id;
    ids.bar = (await ok('/api/master/items', { code: `ORB${run}`, name: `Bar ${run}`, metal_id: ids.gold, tracking: 'lot', nature: 'raw_metal', hsn_code: '7108' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Latha ${run}`, is_customer: true, phone: '9830011111' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Vikram ${run}`, is_customer: true, phone: '9830022222' })).id;
    ids.karigar = (await ok('/api/master/karigars', { name: `Suresh ${run}`, engagement: 'external', standard_ghat_percent: '2', labour_rate_per_gram: '400' })).id;
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k24, rate_per_gram: '7600', buying_rate_per_gram: '7400' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI', 'BANK', 'ADVANCE']) ids[c] = methods.find((m: Body) => m.code === c)?.id ?? '';
    for (const [k, v] of DEFAULTS) await setting(k, v);
    // Metal on hand for karigar work, bought properly so it carries a cost.
    ids.supplier = (await ok('/api/master/parties', { name: `Bullion House ${run}`, is_supplier: true, gstin: '27ABCDE1234F1Z5' })).id;
    await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.counter, direct: true,
      lines: [{ itemId: ids.bar, purityId: ids.k22, grossWeight: '200.000', metalBasis: 'rupee', ratePerGram: '6800' }],
      bill: { supplierInvoiceNumber: `BH/${run}`, supplierInvoiceDate: new Date().toISOString().slice(0, 10) },
    });
  });

  afterAll(async () => {
    for (const [k, v] of DEFAULTS) await setting(k, v);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('takes an order, holds the piece promised, and refuses to promise it twice', async () => {
    const piece = await tag('8.000');
    const order = await ok('/api/orders', {
      orderType: 'booking', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Ring for Diwali', lineMode: 'booking', itemId: ids.ring, pieceId: piece.id, purityId: ids.k22, grossWeight: '8.000' }],
    });
    ids.bookingOrder = order.id;
    expect(order.order_number).toMatch(/^ORD-/);
    expect(n(order.total_amount)).toBeGreaterThan(0);          // priced by the shared engine
    expect(order.lines[0].is_estimate).toBe(false);

    // The piece is held, not sold: still in stock, but spoken for.
    const held = await ok(`/api/stock/pieces/${piece.id}`);
    expect(held.status).toBe('in_stock');

    // A second order cannot promise the same piece, and the counter cannot sell it.
    expect(await code('/api/orders', {
      orderType: 'booking', customerId: ids.customer2, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Same ring', lineMode: 'booking', itemId: ids.ring, pieceId: piece.id, purityId: ids.k22, grossWeight: '8.000' }],
    })).toBe('piece_reserved');
    expect(await code('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: piece.id }], tenders: [] })).toBe('piece_reserved');
    ids.bookingPiece = piece.id;
  });

  it('posts an advance to the customer’s account, where the counter can spend it', async () => {
    const before = await credit(ids.customer);
    const after = await ok(`/api/orders/${ids.bookingOrder}/payments`, { paymentMethodId: ids.CASH, amount: '5000' });
    expect(n(after.advance_amount)).toBe(5000);
    expect(n(after.balance_amount)).toBe(n(after.total_amount) - 5000);
    expect(await credit(ids.customer)).toBeCloseTo(before + 5000, 2);   // visible at the counter
    expect(after.payments[0].receipt_number).toMatch(/^RCT-/);

    // The payment-mode rules of the counter apply here too.
    expect(await code(`/api/orders/${ids.bookingOrder}/payments`, { paymentMethodId: ids.BANK, amount: '100' })).toBe('reference_required');
    expect(await code(`/api/orders/${ids.bookingOrder}/payments`, { paymentMethodId: ids.ADVANCE, amount: '100' })).toBe('payment_method_invalid');
    expect(await code(`/api/orders/${ids.bookingOrder}/payments`, { paymentMethodId: ids.CASH, amount: '9999999' })).toBe('advance_exceeds_total');
  });

  it('bills the order at the counter: the advance applies, the piece sells, the order is delivered', async () => {
    const billing = await ok(`/api/orders/${ids.bookingOrder}/billing`);
    expect(billing.rate.source).toBe('delivery');            // nothing was locked, so today's rate
    expect(n(billing.credit)).toBeGreaterThanOrEqual(5000);

    const invoice = await ok('/api/pos/checkout', {
      customerId: ids.customer, orderId: ids.bookingOrder, lines: [{ pieceId: ids.bookingPiece }],
      tenders: [{ paymentMethodId: ids.ADVANCE, amount: '5000' }],
    });
    expect(invoice.doc_number).toMatch(/^INV-/);

    const order = await ok(`/api/orders/${ids.bookingOrder}`);
    expect(order.status).toBe('completed');
    expect(order.invoice_number).toBe(invoice.doc_number);
    expect(order.stage).toBe('delivered');
    expect((await ok(`/api/stock/pieces/${ids.bookingPiece}`)).status).toBe('sold');
  });

  it('holds the rate the order was taken at, and lets it go when the shop says so', async () => {
    const make = async () => ok('/api/orders', {
      orderType: 'custom', customerId: ids.customer, expectedDeliveryDate: tomorrow(), rateLockType: 'booking',
      lockedRatePerGram: '6900',
      lines: [{ title: 'Chain', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '10.000' }],
    });
    const held = await make();
    expect(n(held.lines[0].rate_per_gram)).toBe(6900);           // priced at the held rate, not today's 7000
    expect((await ok(`/api/orders/${held.id}/billing`)).rate.source).toBe('booking');

    // A lock that has run out hands the bill to today's rate.
    await setting('orders.rate_lock.days', 1);
    const expiring = await make();
    await asPlatform((tx) => tx.query(
      `update retail_order set rate_lock_expires_at = now() - interval '2 days' where id = $1`, [expiring.id]));
    const after = await ok(`/api/orders/${expiring.id}/billing`);
    expect(after.rate.source).toBe('delivery');
    expect(after.rate.expired).toBe(true);

    // Unless the shop honours it anyway.
    await setting('orders.rate_lock.on_expiry', 'keep');
    const kept = await ok(`/api/orders/${expiring.id}/billing`);
    expect(kept.rate.source).toBe('booking');
    expect(n(kept.rate.ratePerGram)).toBe(6900);
    await setting('orders.rate_lock.on_expiry', 'delivery_rate');
    await setting('orders.rate_lock.days', 0);

    // A fixed rate must actually be given.
    expect(await code('/api/orders', {
      orderType: 'custom', customerId: ids.customer, expectedDeliveryDate: tomorrow(), rateLockType: 'fixed',
      lines: [{ title: 'Chain', purityId: ids.k22, grossWeight: '5.000' }],
    })).toBeDefined();
    ids.customOrder = held.id;
  });

  it('issues shop metal to a karigar and takes it back, with the ghat settled as the settings say', async () => {
    const job = await ok('/api/karigars/jobs', {
      karigarId: ids.karigar, retailOrderId: ids.customOrder, metalSource: 'shop', metalId: ids.gold, purityId: ids.k22,
      itemId: ids.bar, locationId: ids.counter, grossWeight: '50.000', labourBasis: 'per_gram', labourRate: '400',
    });
    expect(job.job_number).toMatch(/^KJB-/);
    expect(n(job.issued_fine_weight)).toBeCloseTo(45.8, 3);     // 50 g at 91.6%
    expect(n(job.issued_value)).toBeGreaterThan(0);

    const balances = (await ok('/api/karigars/balances')).rows.find((k: Body) => k.id === ids.karigar);
    expect(n(balances.metal_balance_fine)).toBeCloseTo(45.8, 3);
    expect(n(balances.open_jobs)).toBe(1);

    // More cannot come back than went out.
    expect(await code(`/api/karigars/jobs/${job.id}/receive`, { receivedGrossWeight: '60.000', intoLocationId: ids.counter }))
      .toBe('received_exceeds_issued');

    // 48 g back at 91.6% = 43.968 fine. Allowed 2% of 45.8 = 0.916; actual 1.832; excess 0.916.
    const done = await ok(`/api/karigars/jobs/${job.id}/receive`, {
      receivedGrossWeight: '48.000', intoLocationId: ids.counter,
      tag: { itemId: ids.ring, purityId: ids.k22 },
    });
    expect(n(done.received_fine_weight)).toBeCloseTo(43.968, 3);
    expect(n(done.ghat_allowed_fine)).toBeCloseTo(0.916, 3);
    expect(n(done.ghat_actual_fine)).toBeCloseTo(1.832, 3);
    expect(n(done.ghat_excess_fine)).toBeCloseTo(0.916, 3);
    expect(done.excess_ghat_handling).toBe('recover');
    expect(n(done.labour_amount)).toBeCloseTo(48 * 400, 2);
    expect(done.tag_number).toBeTruthy();                        // came back tagged into stock

    const after = (await ok('/api/karigars/balances')).rows.find((k: Body) => k.id === ids.karigar);
    expect(n(after.metal_balance_fine)).toBeCloseTo(0, 3);       // the job is closed: nothing of it is still out
    expect(n(after.wage_balance)).toBeGreaterThan(0);            // wages owed, less what was recovered
  });

  it('pays the karigar, and never more than is owed', async () => {
    const owed = n((await ok('/api/karigars/balances')).rows.find((k: Body) => k.id === ids.karigar).wage_balance);
    expect(await code('/api/karigars/payments', { karigarId: ids.karigar, amount: String(owed + 1000), paymentMethodId: ids.CASH }))
      .toBe('exceeds_owed');
    const paid = await ok('/api/karigars/payments', { karigarId: ids.karigar, amount: String(owed), paymentMethodId: ids.CASH });
    expect(n(paid.wage_balance)).toBeCloseTo(0, 2);
  });

  it('takes a repair in: the customer’s item is tracked, never stocked, and goes out and back from the karigar', async () => {
    const order = await ok('/api/orders', {
      orderType: 'repair', customerId: ids.customer2, expectedDeliveryDate: tomorrow(),
      repairItemDescription: 'Gold chain, broken clasp', repairIssueTypes: ['clasp'], repairServiceCharge: '1500',
      custodyItems: [{ description: 'Gold chain 22K', metalId: ids.gold, purityId: ids.k22, grossWeight: '12.500', conditionNotes: 'Clasp broken, light scratches', whereKept: 'Repair drawer 2' }],
    });
    ids.repairOrder = order.id;
    expect(order.custody).toHaveLength(1);
    expect(order.custody[0].status).toBe('received');
    expect(order.custody[0].token_number).toContain(order.order_number);
    expect(n(order.total_amount)).toBe(1500);                    // the labour quoted

    // A repair needs to say what came in.
    expect(await code('/api/orders', { orderType: 'repair', customerId: ids.customer2, expectedDeliveryDate: tomorrow() })).toBeDefined();

    // Out to the karigar: no money moves, because the shop never owned it.
    const job = await ok('/api/karigars/jobs', {
      karigarId: ids.karigar, retailOrderId: order.id, metalSource: 'customer', kind: 'repair', metalId: ids.gold, purityId: ids.k22,
      custodyItemIds: [order.custody[0].id], labourBasis: 'flat', labourRate: '0',
    });
    expect(n(job.issued_value)).toBe(0);
    expect((await ok(`/api/orders/${order.id}`)).custody[0].status).toBe('with_karigar');
    // It cannot be handed back while it is out.
    expect(await code(`/api/orders/custody/${order.custody[0].id}/return`, {})).toBe('with_karigar');

    await ok(`/api/karigars/jobs/${job.id}/receive`, { receivedGrossWeight: '12.480' });
    expect((await ok(`/api/orders/${order.id}`)).custody[0].status).toBe('ready');
  });

  it('bills a repair as labour on a SAC code, with nothing moving through stock', async () => {
    const billing = await ok(`/api/orders/${ids.repairOrder}/billing`);
    expect(billing.repair.billAs).toBe('service');
    expect(billing.repair.sac).toBe('998892');

    const invoice = await ok('/api/pos/checkout', {
      customerId: ids.customer2, orderId: ids.repairOrder, lines: [],
      services: [{ description: 'Clasp repair', amount: billing.repair.serviceCharge, sacCode: billing.repair.sac, gstPercent: billing.repair.gstPercent }],
      tenders: [{ paymentMethodId: ids.CASH, amount: '1770' }],
    });
    expect(n(invoice.total_amount)).toBeCloseTo(1770, 2);        // 1500 + 18%
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0].hsn_code).toBe('998892');
    expect(n(invoice.lines[0].net_weight)).toBe(0);
    expect(n(invoice.total_net_weight)).toBe(0);

    const order = await ok(`/api/orders/${ids.repairOrder}`);
    expect(order.status).toBe('completed');
    // The customer's own chain is handed back and leaves the register.
    const back = await ok(`/api/orders/custody/${order.custody[0].id}/return`, { returnedToName: 'Vikram' });
    expect(back.custody[0].status).toBe('returned');
    expect(back.custody[0].returned_on).toBeTruthy();
  });

  it('guards the steps: delivery is by billing, going back needs a reason, cancelling frees the piece', async () => {
    const piece = await tag('4.000');
    const order = await ok('/api/orders', {
      orderType: 'custom', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Pendant', lineMode: 'booking', itemId: ids.ring, pieceId: piece.id, purityId: ids.k22, grossWeight: '4.000' }],
    });
    expect(await code(`/api/orders/${order.id}/stage`, { stage: 'nowhere' })).toBe('invalid_stage_move');
    expect(await code(`/api/orders/${order.id}/stage`, { stage: 'delivered' })).toBe('deliver_by_billing');
    await ok(`/api/orders/${order.id}/stage`, { stage: 'design' });
    expect(await code(`/api/orders/${order.id}/stage`, { stage: 'intake' })).toBe('backward_move_needs_reason');
    const back = await ok(`/api/orders/${order.id}/stage`, { stage: 'intake', reason: 'Customer changed the design' });
    expect(back.stage).toBe('intake');
    expect(back.timeline.at(-1).direction).toBe('backward');

    await ok(`/api/orders/${order.id}/cancel`, { reason: 'Customer changed their mind' });
    // The piece is free again and sells normally.
    const sold = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: piece.id }], tenders: [] });
    expect(sold.doc_number).toMatch(/^INV-/);
  });

  it('refuses to cancel an order while a karigar still holds its metal', async () => {
    const order = await ok('/api/orders', {
      orderType: 'custom', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Bangle', lineMode: 'custom', purityId: ids.k22, grossWeight: '15.000' }],
    });
    const job = await ok('/api/karigars/jobs', {
      karigarId: ids.karigar, retailOrderId: order.id, metalSource: 'shop', metalId: ids.gold, purityId: ids.k22,
      itemId: ids.bar, locationId: ids.counter, grossWeight: '15.000',
    });
    expect(await code(`/api/orders/${order.id}/cancel`, { reason: 'Changed mind' })).toBe('job_open');
    // Calling the job back puts the metal where it was, and then the order can go.
    await ok(`/api/karigars/jobs/${job.id}/cancel`, { reason: 'Sent by mistake' });
    const cancelled = await ok(`/api/orders/${order.id}/cancel`, { reason: 'Changed mind' });
    expect(cancelled.status).toBe('cancelled');
    expect(await code(`/api/karigars/jobs/${job.id}/receive`, { receivedGrossWeight: '14.000' })).toBe('not_issued');
  });

  it('takes the smallest advance the shop insists on', async () => {
    await setting('orders.advance.min_percent', 25);
    expect(await code('/api/orders', {
      orderType: 'custom', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Ring', itemId: ids.ring, purityId: ids.k22, grossWeight: '10.000' }],
    })).toBe('advance_below_minimum');
    await setting('orders.advance.min_percent', 0);
  });

  it('changes an order after it is taken, and moves the holds with it', async () => {
    const first = await tag('6.000');
    const second = await tag('7.000');
    const order = await ok('/api/orders', {
      orderType: 'booking', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'First choice', lineMode: 'booking', itemId: ids.ring, pieceId: first.id, purityId: ids.k22, grossWeight: '6.000' }],
    });
    const wasWorth = n(order.total_amount);

    // The date and the brief change without touching the lines.
    const dated = await ok(`/api/orders/${order.id}`, { expectedDeliveryDate: tomorrow(), notes: 'Customer will collect after 6pm' }, 'PATCH');
    expect(dated.notes).toBe('Customer will collect after 6pm');
    expect(n(dated.total_amount)).toBe(wasWorth);                 // untouched lines keep their price

    // Swapping the piece lets the first one go and holds the second.
    const swapped = await ok(`/api/orders/${order.id}`, {
      lines: [{ title: 'Second choice', lineMode: 'booking', itemId: ids.ring, pieceId: second.id, purityId: ids.k22, grossWeight: '7.000' }],
    }, 'PATCH');
    expect(swapped.lines).toHaveLength(1);
    expect(n(swapped.total_amount)).toBeGreaterThan(wasWorth);     // 7 g costs more than 6 g
    // The first piece is free again; the second is now spoken for.
    const free = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: first.id }], tenders: [] });
    expect(free.doc_number).toMatch(/^INV-/);
    expect(await code('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: second.id }], tenders: [] })).toBe('piece_reserved');

    // An order cannot be worth less than what has already been taken for it.
    await ok(`/api/orders/${order.id}/payments`, { paymentMethodId: ids.CASH, amount: '5000' });
    expect(await call(`/api/orders/${order.id}`, { repairServiceCharge: '0', lines: [{ title: 'Tiny', itemId: ids.ring, purityId: ids.k22, grossWeight: '0.100' }] }, 'PATCH'))
      .toMatchObject({ body: { error: { code: 'total_below_taken' } } });

    // Once delivered, changes go through the bill instead.
    const live = await ok(`/api/orders/${order.id}`);
    await ok('/api/pos/checkout', {
      customerId: ids.customer, orderId: order.id, lines: [{ pieceId: second.id }],
      tenders: [{ paymentMethodId: ids.ADVANCE, amount: '5000' }],
    });
    expect(await code(`/api/orders/${order.id}`, { notes: 'too late' }, 'PATCH')).toBe('already_billed');
    expect(live.status).toBe('active');
  });

  it('takes a wedding order of several items and a corporate order against a PO', async () => {
    const wedding = await ok('/api/orders', {
      orderType: 'wedding', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      eventDate: tomorrow(), eventType: 'Wedding',
      lines: [
        { title: 'Bridal necklace', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '40.000' },
        { title: 'Matching earrings', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '12.000' },
        { title: 'Bangles, pair', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '25.000' },
      ],
    });
    expect(wedding.lines).toHaveLength(3);
    expect(n(wedding.total_gross_weight)).toBeCloseTo(77, 3);
    expect(wedding.stage).toBe('planning');                        // a wedding starts on its own first step
    expect(n(wedding.total_amount)).toBeGreaterThan(0);

    // A corporate order needs the company and their PO reference.
    expect(await code('/api/orders', {
      orderType: 'corporate', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Gift coins', itemId: ids.ring, purityId: ids.k22, grossWeight: '5.000' }],
    })).toBeDefined();
    const corporate = await ok('/api/orders', {
      orderType: 'corporate', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      companyName: 'Vora Textiles Pvt Ltd', companyGstin: '27ABCDE1234F1Z5', poReference: 'PO/2026/881',
      creditTerms: 'net_30',
      lines: [{ title: 'Gift coins, 10 g', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '10.000', quantity: '25' }],
    });
    expect(corporate.company_name).toBe('Vora Textiles Pvt Ltd');
    expect(corporate.po_reference).toBe('PO/2026/881');
    expect(corporate.credit_terms).toBe('net_30');
    expect(corporate.stage).toBe('confirmed');

    // Both appear on their own boards, not on each other's.
    const board = await ok('/api/orders/board?orderType=wedding');
    const planning = board.stages.find((s: Body) => s.key === 'planning');
    expect(planning.orders.some((o: Body) => o.id === wedding.id)).toBe(true);
    expect(JSON.stringify(board)).not.toContain(corporate.order_number);
  });

  it('holds a repair until the customer agrees the estimate', async () => {
    const repair = await ok('/api/orders', {
      orderType: 'repair', customerId: ids.customer2, expectedDeliveryDate: tomorrow(),
      repairItemDescription: 'Bangle, loose stone', repairServiceCharge: '1200',
      custodyItems: [{ description: 'Gold bangle', grossWeight: '11.000' }],
    });
    expect(repair.estimate_approved_at).toBeNull();
    const agreed = await ok(`/api/orders/${repair.id}`, { estimateApproved: { byName: 'Vikram' } }, 'PATCH');
    expect(agreed.estimate_approved_at).toBeTruthy();
    expect(agreed.estimate_approved_by_name).toBe('Vikram');

    // The quoted labour can be corrected, and the order is worth that much.
    const revised = await ok(`/api/orders/${repair.id}`, { repairServiceCharge: '1500' }, 'PATCH');
    expect(n(revised.total_amount)).toBe(1500);
  });

  it('quotes a booked piece at the price the counter will bill', async () => {
    // The tag carries its own making charge; the order must use it, or the
    // customer is told one price at booking and charged another at delivery.
    const piece = await tag('9.000');   // the helper tags at ₹500 a gram
    const order = await ok('/api/orders', {
      orderType: 'booking', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Ring off the shelf', lineMode: 'booking', itemId: ids.ring, pieceId: piece.id, purityId: ids.k22, grossWeight: '9.000' }],
    });
    expect(n(order.making_amount)).toBe(4500);                      // 9 g at ₹500

    const bill = await ok('/api/pos/checkout', {
      customerId: ids.customer, orderId: order.id, lines: [{ pieceId: piece.id }], tenders: [],
    });
    expect(n(bill.total_amount)).toBe(n(order.total_amount));
  });

  it('keeps a log of what was said to the customer, both ways', async () => {
    const order = await ok('/api/orders', {
      orderType: 'booking', customerId: ids.customer, expectedDeliveryDate: tomorrow(),
      lines: [{ title: 'Chain', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '8.000' }],
    });
    await ok(`/api/orders/${order.id}/messages`, { channel: 'whatsapp', message: 'Your chain is ready to collect.' });
    await ok(`/api/orders/${order.id}/messages`, { channel: 'call', direction: 'inbound', message: 'Customer will come on Saturday.' });

    const detail = await ok(`/api/orders/${order.id}`);
    expect(detail.messages).toHaveLength(2);
    // Newest first, so the last thing said is the first thing seen.
    expect(detail.messages[0].message).toBe('Customer will come on Saturday.');
    expect(detail.messages[0].direction).toBe('inbound');
    expect(detail.messages[1].channel).toBe('whatsapp');
    // Nothing sends these, so they are logged as the staff member says they went.
    expect(detail.messages[1].delivery_status).toBe('sent');

    // An empty note is not a log entry, and an order that is not there cannot have one.
    expect((await call(`/api/orders/${order.id}/messages`, { message: '   ' })).status).toBe(400);
    expect((await call(`/api/orders/${ids.customer}/messages`, { message: 'Hello' })).status).toBeGreaterThanOrEqual(400);
  });

  it('keeps the books balanced and stock equal to its journal', async () => {
    const snapshot = async () => ({
      ledger: await ok('/api/accounts/reports/trial-balance'),
      stock: (await ok('/api/stock/summary')).metals,
    });
    const before = await snapshot();
    const totals = before.ledger.rows.filter((r: Body) => !r.is_group).reduce(
      (acc: { d: number; c: number }, r: Body) => ({ d: acc.d + n(r.debit), c: acc.c + n(r.credit) }), { d: 0, c: 0 });
    expect(totals.d).toBeCloseTo(totals.c, 2);                   // every voucher balances

    await ok('/api/stock/balances/rebuild', {});
    expect((await snapshot()).stock).toEqual(before.stock);      // stock equals the movements behind it
  });
});
