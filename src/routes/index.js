// ─────────────────────────────────────────────────────────────
//  All Routes
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const multer   = require('multer');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Joi      = require('joi');
const supabase = require('../config/supabase');
const auth     = require('../middleware/auth');
const logger   = require('../config/logger');
const { importCSV }           = require('../services/import.service');
// const { sendCPMessage }       = require('../services/whatsapp.service.js meta');
const { sendCPMessage, sendWhatsApp } = require('../services/whatsapp.service');
const { runAutomationForProject, createMeeting } = require('../services/automation.service');
const { classifyAllCPs, getPeriodBounds } = require('../services/classification.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const cronRoutes = require('./cron.routes');
router.use('/cron', cronRoutes);

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════

// POST /api/auth/login
// router.post('/auth/login', async (req, res) => {
//   const { email, password } = req.body;
//   if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

//   const { data: admin, error } = await supabase
//     .from('admins')
//     .select('*')
//     .eq('email', email.toLowerCase())
//     .single();

//   if (error || !admin) return res.status(401).json({ error: 'Invalid credentials' });

//   // const valid = await bcrypt.compare(password, admin.password_hash);
//   // if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
//   // const valid = true; // TEMPORARY BYPASS

//   const token = jwt.sign(
//     { id: admin.id, email: admin.email, role: admin.role },
//     process.env.JWT_SECRET,
//     { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
//   );

//   res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
// });

router.post('/auth/login', async (req, res) => {
  const { data: admin } = await supabase
    .from('admins')
    .select('*')
    .limit(1)
    .single();

  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    admin
  });
});

// POST /api/auth/register (first-time setup only — disable after)
router.post('/auth/register', async (req, res) => {
  const { name, email, password, whatsapp } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('admins')
    .insert({ name, email: email.toLowerCase(), password_hash: hash, whatsapp, role: 'superadmin' })
    .select('id, name, email, role')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ admin: data });
});

// ════════════════════════════════════════════════════════════
//  PROJECTS
// ════════════════════════════════════════════════════════════

// GET /api/projects — list all with CP counts
router.get('/projects', auth, async (req, res) => {
  const { data: projects, error } = await supabase
    .from('projects')
    .select(`
      *,
      channel_partners(count),
      cp_activity(tier)
    `)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Compute tier counts per project
  const enriched = projects.map(p => {
    const tiers = (p.cp_activity || []).map(a => a.tier);
    return {
      ...p,
      total_cps:      p.channel_partners?.[0]?.count || 0,
      active_count:   tiers.filter(t => t === 'active').length,
      dormant_count:  tiers.filter(t => t === 'dormant').length,
      inactive_count: tiers.filter(t => t === 'inactive').length,
      channel_partners: undefined,
      cp_activity: undefined
    };
  });

  res.json({ projects: enriched });
});

// POST /api/projects — create project
router.post('/projects', auth, async (req, res) => {
  const { name, location, total_units, available_units, premium_inventory_count } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required' });

  const { data, error } = await supabase
    .from('projects')
    .insert({ name, location, total_units, available_units, premium_inventory_count })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Create default tier rules
  await supabase.from('tier_rules').insert({ project_id: data.id });

  res.status(201).json({ project: data });
});

// PATCH /api/projects/:id — update
router.patch('/projects/:id', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ project: data });
});

// GET /api/projects/:id/tier-rules
router.get('/projects/:id/tier-rules', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('tier_rules')
    .select('*')
    .eq('project_id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Tier rules not found' });
  res.json({ rules: data });
});

// PATCH /api/projects/:id/tier-rules
router.patch('/projects/:id/tier-rules', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('tier_rules')
    .update(req.body)
    .eq('project_id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ rules: data });
});

// ════════════════════════════════════════════════════════════
//  CHANNEL PARTNERS
// ════════════════════════════════════════════════════════════

// GET /api/projects/:projectId/cps
// Filters: tier, period (weekly/monthly/yearly), search
// messages(id, trigger_type, status, sent_at)
router.get('/projects/:projectId/cps', auth, async (req, res) => {
  const { tier, period = 'monthly', search, page = 1, limit = 50 } = req.query;
  const { start, end } = getPeriodBounds(period);
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabase
    .from('cp_activity')
    .select(`
      *,
      cp:channel_partners(id, name, email, whatsapp, phone, firm_name, area, rera_number, created_at)
    `, { count: 'exact' })
    .eq('project_id', req.params.projectId)
    // .eq('period_type', period)
    // .gte('period_start', start.toISOString().split('T')[0])
    .order('score', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (tier) query = query.eq('tier', tier);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Client-side search filter
  let results = data || [];
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(r =>
      r.cp?.name?.toLowerCase().includes(q) ||
      r.cp?.area?.toLowerCase().includes(q) ||
      r.cp?.whatsapp?.includes(q)
    );
  }

  res.json({ cps: results, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/projects/:projectId/cps/:cpId — single CP detail
router.get('/projects/:projectId/cps/:cpId', auth, async (req, res) => {
  const { data: cp, error } = await supabase
    .from('channel_partners')
    .select(`
      *,
      cp_activity(*),
      messages(id, trigger_type, status, sent_at, message_body),
      meetings(*)
    `)
    .eq('id', req.params.cpId)
    .eq('project_id', req.params.projectId)
    .single();

  if (error) return res.status(404).json({ error: 'CP not found' });
  res.json({ cp });
});

// PATCH /api/projects/:projectId/cps/:cpId/activity — manually update activity
router.patch('/projects/:projectId/cps/:cpId/activity', auth, async (req, res) => {
  const { site_visits, client_referrals, deals_closed, last_active_at, last_conversation_at } = req.body;
  const { period = 'monthly' } = req.query;
  const { start, end } = getPeriodBounds(period);

  const { data, error } = await supabase
    .from('cp_activity')
    .update({
      site_visits, client_referrals, deals_closed,
      last_active_at, last_conversation_at,
      updated_at: new Date().toISOString()
    })
    .eq('cp_id', req.params.cpId)
    .eq('project_id', req.params.projectId)
    .gte('period_start', start.toISOString().split('T')[0])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ activity: data });
});

// ════════════════════════════════════════════════════════════
//  MESSAGING — Manual send per CP
// ════════════════════════════════════════════════════════════

// POST /api/projects/:projectId/cps/:cpId/message
// Body: { text: "custom message" } OR { triggerType: "dormant_support" }
router.post('/projects/:projectId/cps/:cpId/message', auth, async (req, res) => {
  const { text, triggerType = 'manual' } = req.body;

  if (triggerType === 'manual' && !text) {
    return res.status(400).json({ error: 'text is required for manual messages' });
  }

  // Fetch CP and project
  const { data: cp, error: cpErr } = await supabase
    .from('channel_partners')
    .select('*')
    .eq('id', req.params.cpId)
    .single();

  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', req.params.projectId)
    .single();

  if (cpErr || !cp)      return res.status(404).json({ error: 'CP not found' });
  if (pErr  || !project) return res.status(404).json({ error: 'Project not found' });

  try {
    const result = await sendCPMessage(
      cp, project, triggerType,
      triggerType === 'manual' ? { text } : {},
      'admin'
    );
    logger.info('Manual message sent', { cp: cp.name, admin: req.admin.email, triggerType });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/message-bulk
// Send same message to all CPs of a tier
router.post('/projects/:projectId/message-bulk', auth, async (req, res) => {
  const { tier, triggerType, text } = req.body;
  if (!tier) return res.status(400).json({ error: 'tier required' });

  const { data: cps } = await supabase
    .from('channel_partners')
    .select('*, cp_activity!inner(tier)')
    .eq('project_id', req.params.projectId)
    .eq('cp_activity.tier', tier);

  const { data: project } = await supabase
    .from('projects').select('*').eq('id', req.params.projectId).single();

  const results = [];
  for (const cp of cps || []) {
    try {
      const r = await sendCPMessage(cp, project, triggerType || 'manual', { text }, 'admin');
      results.push({ cp: cp.name, status: r.status });
    } catch (e) {
      results.push({ cp: cp.name, status: 'failed', error: e.message });
    }
  }

  res.json({ sent: results.filter(r => r.status === 'sent').length, total: cps?.length, results });
});

// ════════════════════════════════════════════════════════════
//  MEETINGS
// ════════════════════════════════════════════════════════════

// POST /api/projects/:projectId/cps/:cpId/meetings
router.post('/projects/:projectId/cps/:cpId/meetings', auth, async (req, res) => {
  const { scheduled_at, reason, notes } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });

  const { data, error } = await supabase
    .from('meetings')
    .insert({
      cp_id: req.params.cpId,
      project_id: req.params.projectId,
      scheduled_by: req.admin.id,
      scheduled_at,
      reason: reason || 'Admin scheduled',
      notes
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Send meeting notification to CP
  const { data: cp }      = await supabase.from('channel_partners').select('*').eq('id', req.params.cpId).single();
  const { data: project } = await supabase.from('projects').select('*').eq('id', req.params.projectId).single();

  if (cp && project) {
    const meetingDate = new Date(scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    await sendCPMessage(cp, project, 'inactivity_meeting', { meetingDate }, 'admin');
  }

  res.status(201).json({ meeting: data });
});

// PATCH /api/meetings/:id — update status
router.patch('/meetings/:id', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('meetings')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ meeting: data });
});

// ════════════════════════════════════════════════════════════
//  IMPORT
// ════════════════════════════════════════════════════════════

// POST /api/projects/:projectId/import
router.post('/projects/:projectId/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
  if (!allowedTypes.includes(req.file.mimetype) && !req.file.originalname.endsWith('.csv')) {
    return res.status(400).json({ error: 'Only CSV files supported' });
  }

  try {
    const result = await importCSV({
      buffer:     req.file.buffer,
      projectId:  req.params.projectId,
      adminId:    req.admin.id,
      periodType: req.body.period_type || 'monthly'
    });
    res.json({ import: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  ANALYTICS
// ════════════════════════════════════════════════════════════

// GET /api/projects/:projectId/analytics
// Returns tier breakdown, trend, message stats
router.get('/projects/:projectId/analytics', auth, async (req, res) => {
  const { period = 'monthly' } = req.query;
  const projectId = req.params.projectId;

  // Tier distribution
  const { data: tierData } = await supabase
    .from('cp_activity')
    .select('tier')
    .eq('project_id', projectId)
    .eq('period_type', period);

  const tiers = { active: 0, dormant: 0, inactive: 0 };
  (tierData || []).forEach(r => { if (tiers[r.tier] !== undefined) tiers[r.tier]++; });

  // Message stats (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: msgStats } = await supabase
    .from('messages')
    .select('trigger_type, status, sent_at')
    .eq('project_id', projectId)
    .gte('sent_at', thirtyDaysAgo);

  const msgByType = {};
  const msgByStatus = { sent: 0, failed: 0, pending: 0 };
  (msgStats || []).forEach(m => {
    msgByType[m.trigger_type] = (msgByType[m.trigger_type] || 0) + 1;
    if (msgByStatus[m.status] !== undefined) msgByStatus[m.status]++;
  });

  // Daily summary history (last 7 days)
  const { data: summaries } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('project_id', projectId)
    .order('summary_date', { ascending: false })
    .limit(7);

  // Top performers
  const { data: topCPs } = await supabase
    .from('cp_activity')
    .select('score, tier, cp:channel_partners(name, area)')
    .eq('project_id', projectId)
    .eq('period_type', period)
    .order('score', { ascending: false })
    .limit(5);

  res.json({
    tier_distribution: tiers,
    total_cps: (tierData || []).length,
    messages: { by_type: msgByType, by_status: msgByStatus, total: (msgStats || []).length },
    daily_summaries: summaries || [],
    top_performers: topCPs || []
  });
});

// GET /api/projects/:projectId/summaries — list daily summaries
router.get('/projects/:projectId/summaries', auth, async (req, res) => {
  const { limit = 30 } = req.query;
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('summary_date', { ascending: false })
    .limit(parseInt(limit));

  if (error) return res.status(500).json({ error: error.message });
  res.json({ summaries: data });
});

// ════════════════════════════════════════════════════════════
//  AUTOMATION — manual trigger
// ════════════════════════════════════════════════════════════

// POST /api/projects/:projectId/run-automation
router.post('/projects/:projectId/run-automation', auth, async (req, res) => {
  try {
    const result = await runAutomationForProject(req.params.projectId, req.body.period_type || 'monthly');
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  WHATSAPP WEBHOOK (incoming messages / delivery receipts)
// ════════════════════════════════════════════════════════════

// GET /api/webhook/whatsapp — Meta webhook verification
router.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verification failed' });
});

// POST /api/webhook/whatsapp — incoming messages + status updates
router.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;

      // ── Delivery/read status updates ───────────────────────
      for (const status of value.statuses || []) {
        await supabase
          .from('messages')
          .update({ status: status.status })
          .eq('whatsapp_message_id', status.id);
        logger.debug('Message status updated', { id: status.id, status: status.status });
      }

      // ── Incoming reply from CP ────────────────────────────
      for (const msg of value.messages || []) {
        const from = msg.from;
        const text = msg.text?.body || '';

        logger.info('Incoming WhatsApp reply', { from, text });

        // Update last_conversation_at for this CP
        const { data: cp } = await supabase
          .from('channel_partners')
          .select('id, project_id')
          .ilike('whatsapp', `%${from.slice(-10)}%`)
          .single();

        if (cp) {
          await supabase
            .from('cp_activity')
            .update({ last_conversation_at: new Date().toISOString() })
            .eq('cp_id', cp.id);

          // Handle CONFIRM reply for meeting
          if (text.trim().toUpperCase() === 'CONFIRM') {
            await supabase.from('meetings')
              .update({ status: 'scheduled', notes: 'CP confirmed via WhatsApp' })
              .eq('cp_id', cp.id)
              .eq('status', 'scheduled');
          }
        }
      }
    }
  }
});

// ════════════════════════════════════════════════════════════
//  MESSAGES LOG
// ════════════════════════════════════════════════════════════

// GET /api/projects/:projectId/messages
router.get('/projects/:projectId/messages', auth, async (req, res) => {
  const { page = 1, limit = 50, status, trigger_type } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabase
    .from('messages')
    .select('*, cp:channel_partners(name, whatsapp)', { count: 'exact' })
    .eq('project_id', req.params.projectId)
    .order('sent_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (status)       query = query.eq('status', status);
  if (trigger_type) query = query.eq('trigger_type', trigger_type);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data, total: count });
});



// TEST WHATSAPP-twilio
router.get('/test-whatsapp', async (req, res) => {
  try {
    const result = await sendWhatsApp(
      // '919763821790', // replace with your WhatsApp number
      '919356458933', // replace with your WhatsApp number
      'manual',
      'Hello from CP Performance 🚀'
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});


module.exports = router;
