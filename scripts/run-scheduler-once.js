'use strict';
/** Run every scheduler job once and exit. With WA_PROVIDER=mock, messages print to console. */
process.env.WA_PROVIDER = process.env.WA_PROVIDER || 'mock';
require('../src/config');
const { runAllOnce } = require('../src/scheduler/scheduler');

runAllOnce()
  .then(() => { console.log('\nScheduler pass complete.'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
