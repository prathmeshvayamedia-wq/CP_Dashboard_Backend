// ─────────────────────────────────────────────────────────────
//  Import Service
//  Parses uploaded CSV/Excel → validates → upserts to Supabase
//  Expected CSV columns (case-insensitive, flexible):
//    name, email, whatsapp/phone, firm_name, area, rera_number,
//    site_visits, client_referrals, deals_closed,
//    last_active_at, last_conversation_at, last_visit_at
// ─────────────────────────────────────────────────────────────

const { parse }  = require('csv-parse/sync');
const supabase   = require('../config/supabase');
const logger     = require('../config/logger');
const { normalizePhone } = require('./whatsapp.service.js meta');
const { calcScore, classifyTier, getInactivityDays, getTierRules, getPeriodBounds } = require('./classification.service');

// ── Column name aliases (maps any variant to canonical name) ──
const ALIASES = {
  name:                ['name','cp name','broker name','partner name','full name'],
  email:               ['email','e-mail','email address'],
  whatsapp:            ['whatsapp','whatsapp number','wa number','mobile','phone','contact'],
  firm_name:           ['firm','firm name','company','agency'],
  area:                ['area','territory','location','city','zone'],
  rera_number:         ['rera','rera number','rera no','rera id'],
  site_visits:         ['site visits','visits','visit count','no of visits','number of visits'],
  client_referrals:    ['referrals','client referrals','clients referred','leads','leads given'],
  deals_closed:        ['deals','deals closed','bookings','conversions','units booked'],
  last_active_at:      ['last active','last active date','last activity','last seen'],
  last_conversation_at:['last conversation','last call','last contacted','last spoke'],
  last_visit_at:       ['last visit','last site visit','last visit date']
};

function resolveHeader(raw) {
  const lower = raw.toLowerCase().trim();
  for (const [canonical, variants] of Object.entries(ALIASES)) {
    if (variants.includes(lower)) return canonical;
  }
  return null;
}

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseNum(val) {
  const n = parseInt(String(val).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// ── Main import function ─────────────────────────────────────
async function importCSV({ buffer, projectId, adminId, periodType = 'monthly' }) {
  const errors  = [];
  const success = [];

  // Parse CSV
  let records;
  try {
    records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (e) {
    throw new Error('Invalid CSV file: ' + e.message);
  }

  if (!records.length) throw new Error('CSV file is empty');

  // Map headers
  const rawHeaders = Object.keys(records[0]);
  const headerMap  = {};
  for (const h of rawHeaders) {
    const canonical = resolveHeader(h);
    if (canonical) headerMap[h] = canonical;
  }

  // Fetch tier rules
  const rules      = await getTierRules(projectId);
  const { start, end } = getPeriodBounds(periodType);

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowNum = i + 2; // 1-indexed + header row

    // Map to canonical fields
    const mapped = {};
    for (const [raw, canonical] of Object.entries(headerMap)) {
      mapped[canonical] = row[raw];
    }

    // Validate required
    if (!mapped.name || !mapped.name.trim()) {
      errors.push({ row: rowNum, error: 'Missing name' });
      continue;
    }
    if (!mapped.whatsapp) {
      errors.push({ row: rowNum, error: `Missing WhatsApp for ${mapped.name}` });
      continue;
    }

    const phone = normalizePhone(mapped.whatsapp);
    if (phone.length < 10) {
      errors.push({ row: rowNum, error: `Invalid phone for ${mapped.name}: ${mapped.whatsapp}` });
      continue;
    }

    try {
      // Upsert CP
      const { data: cp, error: cpErr } = await supabase
        .from('channel_partners')
        .upsert({
          project_id:  projectId,
          name:         mapped.name.trim(),
          email:        mapped.email?.trim() || null,
          whatsapp:     phone,
          phone:        phone,
          firm_name:    mapped.firm_name?.trim() || null,
          area:         mapped.area?.trim() || null,
          rera_number:  mapped.rera_number?.trim() || null
        }, {
          onConflict:   'project_id,whatsapp',
          ignoreDuplicates: false
        })
        .select()
        .single();

      if (cpErr) throw cpErr;

      // Build activity row
      const siteVisits     = parseNum(mapped.site_visits);
      const referrals      = parseNum(mapped.client_referrals);
      const deals          = parseNum(mapped.deals_closed);
      const lastActiveAt   = parseDate(mapped.last_active_at);
      const lastConvAt     = parseDate(mapped.last_conversation_at);
      const lastVisitAt    = parseDate(mapped.last_visit_at);
      const inactiveDays   = getInactivityDays(lastActiveAt);
      const score          = calcScore({ site_visits: siteVisits, client_referrals: referrals, deals_closed: deals }, rules);
      const tier           = classifyTier({ site_visits: siteVisits, deals_closed: deals }, rules, inactiveDays);

      // Upsert activity for current period
      const { error: actErr } = await supabase
        .from('cp_activity')
        .upsert({
          cp_id:               cp.id,
          project_id:          projectId,
          site_visits:         siteVisits,
          client_referrals:    referrals,
          deals_closed:        deals,
          last_active_at:      lastActiveAt,
          last_conversation_at: lastConvAt,
          last_visit_at:       lastVisitAt,
          period_start:        start.toISOString().split('T')[0],
          period_end:          end.toISOString().split('T')[0],
          period_type:         periodType,
          score,
          tier
        }, { onConflict: 'cp_id,period_start,period_type' });

      if (actErr) throw actErr;

      success.push({ row: rowNum, name: mapped.name, tier, score });

    } catch (err) {
      errors.push({ row: rowNum, error: err.message, name: mapped.name });
    }
  }

  // Log the import
  await supabase.from('imports').insert({
    project_id:   projectId,
    imported_by:  adminId,
    total_rows:   records.length,
    success_rows: success.length,
    failed_rows:  errors.length,
    errors:       errors.length ? errors : null
  });

  logger.info('CSV import complete', {
    projectId,
    total: records.length,
    success: success.length,
    failed: errors.length
  });

  return {
    total:   records.length,
    success: success.length,
    failed:  errors.length,
    errors,
    preview: success.slice(0, 5)
  };
}

module.exports = { importCSV };
