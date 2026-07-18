'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIG_PATH = process.env.CLINIC_CONFIG || path.join(__dirname, '..', 'config', 'clinic.json');

let _config = null;
let _mtime = 0;

/** Load clinic config; hot-reloads if the file changed so staff edits apply without restart. */
function getConfig() {
  const stat = fs.statSync(CONFIG_PATH);
  if (!_config || stat.mtimeMs !== _mtime) {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _mtime = stat.mtimeMs;
  }
  return _config;
}

/** Fill {placeholders} in a message template. */
function renderTemplate(name, vars = {}) {
  const cfg = getConfig();
  let text = (cfg.templates && cfg.templates[name]) || '';
  const all = {
    clinic: cfg.clinic_name,
    phone: cfg.phone,
    review_link: cfg.review_link,
    months: cfg.recall_months,
    ...vars,
  };
  for (const [k, v] of Object.entries(all)) {
    text = text.split(`{${k}}`).join(String(v));
  }
  return text;
}

// Make all Date math happen in clinic-local time.
process.env.TZ = process.env.TZ || (function () {
  try { return getConfig().timezone || 'Asia/Karachi'; } catch { return 'Asia/Karachi'; }
})();

module.exports = { getConfig, renderTemplate, CONFIG_PATH };
