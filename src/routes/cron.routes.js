const router  = require('express').Router();
const logger  = require('../config/logger');
const { runAutomationForAllProjects } = require('../services/automation.service');

// ── Guard: only allow Vercel's cron caller ──────────────────
function cronGuard(req, res, next) {
  if (process.env.NODE_ENV === 'production' &&
      req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Job 1: Daily 9am IST classification
router.post('/daily-morning', cronGuard, async (req, res) => {
  logger.info('CRON: Daily morning classification started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('CRON: Daily morning classification complete');
    res.json({ ok: true });
  } catch (err) {
    logger.error('CRON ERROR: Daily morning', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Job 2: Daily 7pm IST summary
router.post('/daily-evening', cronGuard, async (req, res) => {
  logger.info('CRON: Evening summary started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('CRON: Evening summary sent');
    res.json({ ok: true });
  } catch (err) {
    logger.error('CRON ERROR: Evening summary', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Job 3: Hourly inactivity check
router.post('/hourly-inactivity', cronGuard, async (req, res) => {
  logger.info('CRON: Hourly inactivity check');
  try {
    const supabase = require('../config/supabase');
    const { getInactivityDays } = require('../services/classification.service');
    const { sendCPMessage }     = require('../services/whatsapp.service');

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneHourAgo   = new Date(Date.now() -     60 * 60 * 1000);

    const { data: activities } = await supabase
      .from('cp_activity')
      .select('*, channel_partners(*), projects:project_id(*)')
      .gte('last_active_at', sevenDaysAgo.toISOString())
      .lte('last_active_at', oneHourAgo.toISOString());

    if (!activities?.length) return res.json({ ok: true, triggered: 0 });

    let triggered = 0;
    for (const a of activities) {
      const days = getInactivityDays(a.last_active_at);
      if (days >= 7 && days < 8) {
        const { data: sent } = await supabase
          .from('messages')
          .select('id')
          .eq('cp_id', a.cp_id)
          .eq('trigger_type', 'inactivity_7d')
          .gte('sent_at', sevenDaysAgo.toISOString())
          .limit(1);

        if (!sent?.length && a.channel_partners && a.projects) {
          await sendCPMessage(a.channel_partners, a.projects, 'inactivity_7d', {}, 'job');
          triggered++;
        }
      }
    }
    res.json({ ok: true, triggered });
  } catch (err) {
    logger.error('CRON ERROR: Hourly inactivity', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Job 4: Weekly (Monday 8am IST)
router.post('/weekly', cronGuard, async (req, res) => {
  logger.info('CRON: Weekly classification started');
  try {
    await runAutomationForAllProjects('weekly');
    logger.info('CRON: Weekly classification complete');
    res.json({ ok: true });
  } catch (err) {
    logger.error('CRON ERROR: Weekly', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Job 5: Monthly (1st of month 6am IST)
router.post('/monthly', cronGuard, async (req, res) => {
  logger.info('CRON: Monthly classification started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('CRON: Monthly classification complete');
    res.json({ ok: true });
  } catch (err) {
    logger.error('CRON ERROR: Monthly', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
