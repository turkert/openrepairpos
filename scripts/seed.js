// Fills an empty database with demo data: npm run seed
// Creates admin login  admin@example.com / changeme123  — for local testing only.
const path = require('node:path');
const { setDriver, migrate, get } = require('../src/db');
const { nodeDriver } = require('../src/drivers/node');
setDriver(nodeDriver(process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'openrepairpos.db')));
migrate();
const S = require('../src/services');
const A = require('../src/auth');
const { seedDemo } = require('../src/seed');

if (get('SELECT COUNT(*) AS n FROM tickets').n > 0) {
  console.log('Database already has data — skipping seed.');
  process.exit(0);
}
const admin = A.needsSetup()
  ? A.saveUser({ name: 'Shop Owner', email: 'admin@example.com', password: 'changeme123', role: 'admin' })
  : get('SELECT * FROM users ORDER BY id LIMIT 1');
const tech = A.saveUser({ name: 'Alex Tech', email: 'tech@example.com', password: 'changeme123', role: 'tech' });
S.updateSettings({ store_name: 'Demo Phone Repair', store_phone: '(713) 555-0100', store_address: '123 Main St, Houston, TX' });
seedDemo(admin, tech);
console.log('Demo data loaded. Sign in with admin@example.com / changeme123');
