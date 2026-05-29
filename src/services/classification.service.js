// ─────────────────────────────────────────────────────────────
//  Classification Service
//  Core backend logic:
//  - Classify CP into active / dormant / inactive
//  - Score calculation
//  - Inactivity detection
//  - Performance drop detection
//  - Decide which automated action to trigger
// ─────────────────────────────────────────────────────────────

const { differenceInDays, parseISO, startOfWeek, startOfMonth, startOfYear, endOfMonth, endOfWeek, endOfYear, subMonths } = require('date-fns');
const supabase = require('../config/supabase');
const logger   = require('../config/logger');

// ── Score calculation ────────────────────────────────────────
// Weighted: visits 40%, referrals 30%, deals 30%
// Max score = 100
function calcScore({ site_visits = 0, client_referrals = 0, deals_closed = 0 }, rules = {}) {
  const maxVisits   = rules.active_min_visits * 4  || 20;
  const maxReferrals = 10;
  const maxDeals    = rules.active_min_deals * 4   || 8;

  const vScore = Math.min(site_visits   / maxVisits    * 40, 40);
  const rScore = Math.min(client_referrals / maxReferrals * 30, 30);
  const dScore = Math.min(deals_closed  / maxDeals     * 30, 30);

  return Math.round(vScore + rScore + dScore);
}

// ── Classify tier ────────────────────────────────────────────
// Uses rules from tier_rules table (per project, configurable)
function classifyTier(activity, rules, inactivityDays) {
  // Inactivity overrides everything
  if (inactivityDays >= rules.inactivity_critical_days) return 'inactive';

  const { site_visits = 0, deals_closed = 0 } = activity;

  if (
    site_visits  >= rules.active_min_visits &&
    deals_closed >= rules.active_min_deals
  ) return 'active';

  if (
    site_visits  >= rules.dormant_min_visits ||
    deals_closed >= rules.dormant_min_deals
  ) return 'dormant';

  return 'inactive';
}

// ── Inactivity days ──────────────────────────────────────────
function getInactivityDays(lastActiveAt) {
  if (!lastActiveAt) return 999; // never active
  const last = typeof lastActiveAt === 'string' ? parseISO(lastActiveAt) : lastActiveAt;
  return differenceInDays(new Date(), last);
}

// ── Determine automation triggers for a CP ───────────────────
// Returns array of trigger types that should fire
function getTriggersForCP(cp, activity, rules, prevActivity = null) {
  const triggers = [];
  const inactiveDays = getInactivityDays(activity.last_active_at);
  const noConvDays   = activity.last_conversation_at
    ? differenceInDays(new Date(), parseISO(activity.last_conversation_at))
    : 999;

  // ── Inactivity chain (fire only the most severe) ──────────
  if (inactiveDays >= rules.inactivity_meeting_days) {
    triggers.push({ type: 'inactivity_meeting', severity: 'critical' });
  } else if (inactiveDays >= rules.inactivity_critical_days) {
    triggers.push({ type: 'inactivity_14d', severity: 'high' });
  } else if (inactiveDays >= rules.inactivity_warning_days) {
    triggers.push({ type: 'inactivity_7d', severity: 'medium' });
  }

  // ── No conversation with sales team (10+ days) ────────────
  if (noConvDays >= 10 && inactiveDays < rules.inactivity_warning_days) {
    triggers.push({ type: 'no_conversation', severity: 'medium' });
  }

  // ── Performance drop from last period ─────────────────────
  if (prevActivity) {
    const prevScore = calcScore(prevActivity, rules);
    const currScore = calcScore(activity, rules);
    const dropPct   = prevScore > 0 ? ((prevScore - currScore) / prevScore) * 100 : 0;
    if (dropPct >= 30 && prevScore >= 20) {
      triggers.push({
        type: 'performance_drop',
        severity: 'high',
        meta: { prevScore, currScore }
      });
    }
  }

  // ── Tier-based messages (send once per period) ────────────
  if (activity.tier === 'active' && !activity._perk_sent) {
    triggers.push({ type: 'active_perk', severity: 'low' });
  }
  if (activity.tier === 'dormant' && !activity._support_sent) {
    triggers.push({ type: 'dormant_support', severity: 'low' });
  }

  return triggers;
}

// ── Period boundaries ────────────────────────────────────────
function getPeriodBounds(type = 'monthly', date = new Date()) {
  if (type === 'weekly')  return { start: startOfWeek(date, { weekStartsOn: 1 }), end: endOfWeek(date, { weekStartsOn: 1 }) };
  if (type === 'monthly') return { start: startOfMonth(date), end: endOfMonth(date) };
  if (type === 'yearly')  return { start: startOfYear(date), end: endOfYear(date) };
  return { start: startOfMonth(date), end: endOfMonth(date) };
}

// ── Fetch tier rules for a project ──────────────────────────
async function getTierRules(projectId) {
  const { data, error } = await supabase
    .from('tier_rules')
    .select('*')
    .eq('project_id', projectId)
    .single();

  if (error || !data) {
    // return sensible defaults if no rules configured
    return {
      active_min_visits: 5,
      active_min_deals: 1,
      dormant_min_visits: 1,
      dormant_min_deals: 0,
      inactivity_warning_days: 7,
      inactivity_critical_days: 14,
      inactivity_meeting_days: 21
    };
  }
  return data;
}

// ── Classify and persist all CPs for a project ───────────────
async function classifyAllCPs(projectId, periodType = 'monthly') {
  const rules        = await getTierRules(projectId);
  const { start, end } = getPeriodBounds(periodType);
  const prevBounds   = getPeriodBounds(periodType, subMonths(new Date(), 1));

  // Fetch current period activity
  const { data: activities, error: actErr } = await supabase
    .from('cp_activity')
    .select('*, channel_partners(id, name, whatsapp, phone, email)')
    .eq('project_id', projectId)
    .eq('period_type', periodType)
    .gte('period_start', start.toISOString().split('T')[0])
    .lte('period_end', end.toISOString().split('T')[0]);

  if (actErr) { logger.error('classifyAllCPs fetch error', actErr); return []; }

  // Fetch previous period for drop detection
  const { data: prevActivities } = await supabase
    .from('cp_activity')
    .select('cp_id, site_visits, client_referrals, deals_closed')
    .eq('project_id', projectId)
    .eq('period_type', periodType)
    .gte('period_start', prevBounds.start.toISOString().split('T')[0]);

  const prevMap = {};
  (prevActivities || []).forEach(p => { prevMap[p.cp_id] = p; });

  const results = [];

  for (const activity of activities) {
    const inactiveDays = getInactivityDays(activity.last_active_at);
    const score        = calcScore(activity, rules);
    const tier         = classifyTier(activity, rules, inactiveDays);
    const triggers     = getTriggersForCP(
      activity.channel_partners,
      { ...activity, tier },
      rules,
      prevMap[activity.cp_id] || null
    );

    // Persist updated score + tier
    await supabase
      .from('cp_activity')
      .update({ score, tier })
      .eq('id', activity.id);

    results.push({
      cp: activity.channel_partners,
      activity: { ...activity, score, tier },
      inactiveDays,
      triggers
    });
  }

  logger.info('Classification complete', { projectId, total: results.length });
  return results;
}

module.exports = {
  calcScore,
  classifyTier,
  getInactivityDays,
  getTriggersForCP,
  getPeriodBounds,
  getTierRules,
  classifyAllCPs
};
