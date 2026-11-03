// Sample data so a new shop can try every screen. Used by `npm run seed` and the setup wizard.
const S = require('./services');

function seedDemo(admin, tech = null) {
  const items = [
    ['iPhone 13 Screen (OLED)', 'Screens', 'part', 62, 2, 2, 'Parts4Cells'],
    ['iPhone 13 Battery', 'Batteries', 'part', 14, 6, 3, 'Parts4Cells'],
    ['iPhone 14 Pro Screen (OLED)', 'Screens', 'part', 145, 3, 2, 'Parts4Cells'],
    ['Galaxy S23 Screen Assembly', 'Screens', 'part', 118, 1, 2, 'Parts4Cells'],
    ['iPhone 12 Charging Port Flex', 'Flex cables', 'part', 9, 8, 3, 'Parts4Cells'],
    ['USB‑C Fast Charger 20W', 'Accessories', 'product', 6, 25, 5, ''],
    ['Tempered Glass Protector', 'Accessories', 'product', 1.2, 60, 20, ''],
    ['Diagnostic Fee', 'Services', 'service', 0, 0, 0, ''],
    ['Labor – Screen Replacement', 'Services', 'service', 0, 0, 0, ''],
  ].map(([name, category, kind, cost, stock, min_stock, supplier]) =>
    S.saveItem({ name, category, kind, cost, price: kind === 'service' ? (name.startsWith('Diag') ? 30 : 40) : Math.round(cost * 2.2), stock, min_stock, supplier }, null, admin));

  [
    ['Apple', 'iPhone 13', 'Screen replacement', 189, items[0].id],
    ['Apple', 'iPhone 13', 'Battery replacement', 79, items[1].id],
    ['Apple', 'iPhone 14 Pro', 'Screen replacement', 329, items[2].id],
    ['Apple', 'iPhone 12', 'Charging port repair', 89, items[4].id],
    ['Samsung', 'Galaxy S23', 'Screen replacement', 279, items[3].id],
  ].forEach(([brand, model, repair, price, item_id]) => S.savePrice({ brand, model, repair, price, item_id, minutes: 60, warranty_days: 90 }));

  const c1 = S.saveCustomer({ first_name: 'Maria', last_name: 'Lopez', phone: '713-555-0142', email: 'maria@example.com' });
  const c2 = S.saveCustomer({ first_name: 'James', last_name: 'Carter', phone: '832-555-0199' });
  const c3 = S.saveCustomer({ first_name: 'Priya', last_name: 'Shah', phone: '281-555-0123', company: 'Shah Dental' });

  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const t1 = S.createTicket({ customer_id: c1.id, device_type: 'Phone', brand: 'Apple', model: 'iPhone 13', serial: '356789101112131', issue: 'Cracked screen, touch works', repair_type: 'Screen replacement', estimate: 189, due_date: d(1), assigned_to: tech?.id || admin.id }, admin);
  S.addTicketItem({ ticket_id: t1.id, item_id: items[0].id }, admin);
  S.setTicketStatus({ ticket_id: t1.id, status: 'In repair', notify_customer: false }, admin);
  const t2 = S.createTicket({ customer_id: c2.id, device_type: 'Phone', brand: 'Samsung', model: 'Galaxy S23', issue: 'Dropped, display black', repair_type: 'Screen replacement', estimate: 279, due_date: d(-1) }, admin);
  S.addNote({ ticket_id: t2.id, type: 'diagnostic', body: 'Display assembly damaged; frame OK. Part ordered.' }, admin);
  S.setTicketStatus({ ticket_id: t2.id, status: 'Waiting for parts', notify_customer: false }, admin);
  const t3 = S.createTicket({ customer_id: c3.id, device_type: 'Phone', brand: 'Apple', model: 'iPhone 12', issue: 'Not charging', repair_type: 'Charging port', estimate: 89, due_date: d(0) }, admin);
  S.addTicketItem({ ticket_id: t3.id, item_id: items[4].id }, admin);
  S.addTicketItem({ ticket_id: t3.id, description: 'Labor – port replacement', unit_price: 80 }, admin);
  S.setTicketStatus({ ticket_id: t3.id, status: 'Ready for pickup', notify_customer: false }, admin);
  const inv = S.createInvoice({ ticket_id: t3.id }, admin);
  S.recordPayment({ invoice_id: inv.id, method: 'card' }, admin);
  S.setTicketStatus({ ticket_id: t3.id, status: 'Completed', notify_customer: false }, admin);
  S.createInvoice({ customer_id: c1.id, lines: [{ item_id: items[5].id, qty: 1 }, { item_id: items[6].id, qty: 2 }], payments: [{ method: 'cash' }] }, admin);
  S.bookAppointment({ name: 'Walk-in: Kevin', phone: '713-555-0177', starts_at: `${d(0)}T15:00`, title: 'iPad screen quote' }, admin);
}

module.exports = { seedDemo };
