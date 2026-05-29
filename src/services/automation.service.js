// ─────────────────────────────────────────────────────────────
//  Automation Engine
//  Runs after every classification cycle.
//  For each CP with triggers → sends WhatsApp → logs everything.
//  Also handles: meeting creation, daily summary generation.
// ─────────────────────────────────────────────────────────────

const supabase   = require('../config/supabase');
const logger     = require('../config/logger');
const { sendCPMessage, sendAdminSummary } = require('./whatsapp.service.js meta');
const { classifyAllCPs, getTierRules }    = require('./classification.service');
const { format, addDays }                 = require('date-fns');

// ── Already-sent guard ────────────────────────────────────────
// Avoid sending the same trigger type to the same CP more than
// once per period (e.g. don't send inactivity_7d every day)
async function alreadySentThisPeriod(cpId, projectId, triggerType, withinHours = 120) {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('messages')
    .select('id')
    .eq('cp_id', cpId)
    .eq('project_id', projectId)
    .eq('trigger_type', triggerType)
    .eq('status', 'sent')
    .gte('sent_at', since)
    .limit(1);
  return data && data.length > 0;
}

// ── Create a meeting record ───────────────────────────────────
async function createMeeting(cpId, projectId, adminId = null) {
  const scheduledAt = addDays(new Date(), 2); // default: 2 days from now
  const { data, error } = await supabase
    .from('meetings')
    .insert({
      cp_id: cpId,
      project_id: projectId,
      scheduled_by: adminId,
      scheduled_at: scheduledAt.toISOString(),
      reason: 'Auto-triggered: 21+ days inactivity',
      status: 'scheduled'
    })
    .select()
    .single();

  if (error) logger.error('Meeting creation failed', { cpId, error });
  else logger.info('Meeting created', { cpId, scheduledAt });
  return data;
}

// ── Process triggers for one CP ───────────────────────────────
async function processCPTriggers(cpResult, project) {
  const { cp, activity, triggers } = cpResult;
  const fired = [];

  for (const trigger of triggers) {
    // Guard: don't repeat same trigger within cooldown
    const cooldownMap = {
      inactivity_7d:       120,  // 5 days
      inactivity_14d:      120,
      inactivity_meeting:  168,  // 7 days
      no_conversation:     168,
      performance_drop:    168,
      dormant_support:     240,  // 10 days
      active_perk:         720   // 30 days (once per period)
    };
    const cooldown = cooldownMap[trigger.type] || 120;
    const sent = await alreadySentThisPeriod(cp.id, project.id, trigger.type, cooldown);
    if (sent) {
      logger.debug('Skipping already-sent trigger', { cp: cp.name, trigger: trigger.type });
      continue;
    }

    try {
      let result;

      // ── Meeting trigger: create record + send message ──────
      if (trigger.type === 'inactivity_meeting') {
        const meeting = await createMeeting(cp.id, project.id);
        const meetingDate = meeting
          ? format(new Date(meeting.scheduled_at), 'dd MMM yyyy, h:mm a')
          : '48 hours from now';
        result = await sendCPMessage(cp, project, 'inactivity_meeting', { meetingDate }, 'job');
      }

      // ── Performance drop: pass scores ─────────────────────
      else if (trigger.type === 'performance_drop') {
        result = await sendCPMessage(cp, project, 'performance_drop', {
          prevScore: trigger.meta.prevScore,
          currScore: trigger.meta.currScore
        }, 'job');
      }

      // ── All other triggers ─────────────────────────────────
      else {
        result = await sendCPMessage(cp, project, trigger.type, {}, 'job');
      }

      fired.push({ type: trigger.type, severity: trigger.severity, status: result.status });
      logger.info('Trigger fired', { cp: cp.name, trigger: trigger.type, status: result.status });

    } catch (err) {
      logger.error('Trigger failed', { cp: cp.name, trigger: trigger.type, error: err.message });
    }
  }

  return fired;
}

// ── Build daily summary for a project ────────────────────────
async function buildDailySummary(projectId, classifiedCPs) {
  const today = new Date().toISOString().split('T')[0];

  const active   = classifiedCPs.filter(r => r.activity.tier === 'active').length;
  const dormant  = classifiedCPs.filter(r => r.activity.tier === 'dormant').length;
  const inactive = classifiedCPs.filter(r => r.activity.tier === 'inactive').length;

  // Messages sent today
  const { count: msgCount } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .gte('sent_at', `${today}T00:00:00`)
    .eq('status', 'sent');

  // Meetings set today
  const { count: meetCount } = await supabase
    .from('meetings')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .gte('created_at', `${today}T00:00:00`);

  // CPs that fired alerts today
  const alertedCPs = classifiedCPs
    .filter(r => r.triggers.some(t => ['inactivity_7d','inactivity_14d','inactivity_meeting','performance_drop'].includes(t.type)))
    .map(r => `${r.cp.name} (${r.activity.tier})`);

  const summary = {
    active_count:        active,
    dormant_count:       dormant,
    inactive_count:      inactive,
    total_cps:           classifiedCPs.length,
    messages_sent_today: msgCount || 0,
    meetings_set_today:  meetCount || 0,
    new_deals_today:     0,  // updated separately when activity is logged
    alerts_fired:        alertedCPs
  };

  // Persist summary
  await supabase.from('daily_summaries').upsert({
    project_id:          projectId,
    summary_date:        today,
    ...summary,
    summary_json:        classifiedCPs.map(r => ({
      cp:      r.cp.name,
      tier:    r.activity.tier,
      score:   r.activity.score,
      triggers: r.triggers.map(t => t.type)
    }))
  }, { onConflict: 'project_id,summary_date' });

  return summary;
}

// ── Main run for one project ──────────────────────────────────
async function runAutomationForProject(projectId, periodType = 'monthly') {
  logger.info('Automation run started', { projectId, periodType });

  // 1. Fetch project info
  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();

  if (pErr || !project) {
    logger.error('Project not found', { projectId });
    return;
  }

  // 2. Classify all CPs
  const classifiedCPs = await classifyAllCPs(projectId, periodType);

  // 3. Process triggers for each CP
  const allFired = [];
  for (const cpResult of classifiedCPs) {
    const fired = await processCPTriggers(cpResult, project);
    allFired.push({ cp: cpResult.cp.name, fired });
  }

  // 4. Build and send daily summary to admin
  const summary = await buildDailySummary(projectId, classifiedCPs);

  if (process.env.ADMIN_WHATSAPP) {
    await sendAdminSummary(summary, project, process.env.ADMIN_WHATSAPP);
    if (process.env.SALES_HEAD_WHATSAPP && process.env.SALES_HEAD_WHATSAPP !== process.env.ADMIN_WHATSAPP) {
      await sendAdminSummary(summary, project, process.env.SALES_HEAD_WHATSAPP);
    }
  }

  // 5. Mark summary as sent
  const today = new Date().toISOString().split('T')[0];
  await supabase
    .from('daily_summaries')
    .update({ sent_to_admin: true })
    .eq('project_id', projectId)
    .eq('summary_date', today);

  logger.info('Automation run complete', {
    projectId,
    cpsProcessed: classifiedCPs.length,
    triggersTotal: allFired.reduce((s, r) => s + r.fired.length, 0)
  });

  return { summary, classifiedCPs: classifiedCPs.length, allFired };
}

// ── Run automation for ALL active projects ────────────────────
async function runAutomationForAllProjects(periodType = 'monthly') {
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name')
    .eq('is_active', true);

  if (!projects?.length) {
    logger.warn('No active projects found');
    return;
  }

  for (const project of projects) {
    await runAutomationForProject(project.id, periodType);
  }
}

module.exports = {
  runAutomationForProject,
  runAutomationForAllProjects,
  buildDailySummary,
  processCPTriggers,
  createMeeting
};
