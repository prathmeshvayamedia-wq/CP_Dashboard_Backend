// ─────────────────────────────────────────────────────────────
//  Scheduler — all cron jobs
//
//  Jobs:
//  1. Daily 9am   — classify all CPs + trigger automations
//  2. Daily 7pm   — generate + send daily summary to admin
//  3. Hourly      — check for newly inactive CPs (7d trigger)
//  4. Monday 8am  — weekly re-classification
//  5. 1st of month — monthly re-classification + reset flags
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const cron     = require('node-cron');
const logger   = require('../config/logger');
const { runAutomationForAllProjects } = require('../services/automation.service');

// ── Job 1: Daily morning classification ──────────────────────
// Every day at 9:00 AM IST
cron.schedule('0 9 * * *', async () => {
  logger.info('JOB: Daily morning classification started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('JOB: Daily morning classification complete');
  } catch (err) {
    logger.error('JOB ERROR: Daily classification', { error: err.message });
  }
}, { timezone: 'Asia/Kolkata' });

// ── Job 2: Daily evening summary ─────────────────────────────
// Every day at 7:00 PM IST — sends end-of-day summary to admin
cron.schedule('0 19 * * *', async () => {
  logger.info('JOB: Evening summary started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('JOB: Evening summary sent');
  } catch (err) {
    logger.error('JOB ERROR: Evening summary', { error: err.message });
  }
}, { timezone: 'Asia/Kolkata' });

// ── Job 3: Hourly inactivity check ───────────────────────────
// Runs every hour — catches newly inactive CPs quickly
cron.schedule('0 * * * *', async () => {
  logger.info('JOB: Hourly inactivity check');
  try {
    const supabase = require('../config/supabase');
    const { getInactivityDays } = require('../services/classification.service');
    const { sendCPMessage }     = require('../services/whatsapp.service');

    // Find CPs crossing exactly the 7-day threshold in the last hour
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneHourAgo   = new Date(Date.now() - 1 * 60 * 60 * 1000);

    const { data: activities } = await supabase
      .from('cp_activity')
      .select('*, channel_partners(*), projects:project_id(*)')
      .gte('last_active_at', sevenDaysAgo.toISOString())
      .lte('last_active_at', oneHourAgo.toISOString());

    if (!activities?.length) return;

    for (const a of activities) {
      const days = getInactivityDays(a.last_active_at);
      if (days >= 7 && days < 8) {
        // Just hit the 7-day threshold
        const { data: sent } = await supabase
          .from('messages')
          .select('id')
          .eq('cp_id', a.cp_id)
          .eq('trigger_type', 'inactivity_7d')
          .gte('sent_at', sevenDaysAgo.toISOString())
          .limit(1);

        if (!sent?.length && a.channel_partners && a.projects) {
          await sendCPMessage(a.channel_partners, a.projects, 'inactivity_7d', {}, 'job');
          logger.info('Hourly job: inactivity_7d triggered', { cp: a.channel_partners.name });
        }
      }
    }
  } catch (err) {
    logger.error('JOB ERROR: Hourly inactivity', { error: err.message });
  }
}, { timezone: 'Asia/Kolkata' });

// ── Job 4: Weekly classification (Monday 8am) ─────────────────
cron.schedule('0 8 * * 1', async () => {
  logger.info('JOB: Weekly classification started');
  try {
    await runAutomationForAllProjects('weekly');
    logger.info('JOB: Weekly classification complete');
  } catch (err) {
    logger.error('JOB ERROR: Weekly', { error: err.message });
  }
}, { timezone: 'Asia/Kolkata' });

// ── Job 5: Monthly classification (1st of month, 6am) ────────
cron.schedule('0 6 1 * *', async () => {
  logger.info('JOB: Monthly classification started');
  try {
    await runAutomationForAllProjects('monthly');
    logger.info('JOB: Monthly classification complete');
  } catch (err) {
    logger.error('JOB ERROR: Monthly', { error: err.message });
  }
}, { timezone: 'Asia/Kolkata' });

logger.info('All cron jobs registered', {
  jobs: ['Daily 9am classification', 'Daily 7pm summary', 'Hourly inactivity check', 'Monday weekly', '1st monthly']
});

// Keep process alive when run standalone
process.on('SIGINT', () => { logger.info('Scheduler stopped'); process.exit(); });
