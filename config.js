// ════════════════════════════════════════════════════════════════════════════
// config.js — Central configuration & contact-identity rotator
// Configured for DigiForge Consulting SG (Singapore B2B Outreach)
// ════════════════════════════════════════════════════════════════════════════
'use strict';

// ── Spintax Resolver ─────────────────────────────────────────────────────────
// Resolves patterns like "{Hi|Hello|Hey}" into a randomly chosen variation.
function resolveSpintax(text) {
  if (!text) return '';
  let match;
  while ((match = /\{([^{}]+)\}/.exec(text)) !== null) {
    const choices = match[1].split('|');
    const randomChoice = choices[Math.floor(Math.random() * choices.length)];
    text = text.replace(match[0], randomChoice);
  }
  return text;
}

// ── Rotating Sender Identities ───────────────────────────────────────────────
// Primary verified domain inbox is info@digiforgeconsulting.com.
// Environment variables can override or expand the identity pool.
const _CONTACTS = [
  {
    first_name: process.env.DIGIFORGE_FIRST_NAME || 'Partnership',
    last_name: process.env.DIGIFORGE_LAST_NAME || 'Team',
    email: process.env.DIGIFORGE_EMAIL || 'info@digiforgeconsulting.com',
  },
  {
    first_name: 'Commercial',
    last_name: 'Director',
    email: process.env.DIGIFORGE_EMAIL || 'info@digiforgeconsulting.com',
  },
  {
    first_name: 'Client',
    last_name: 'Solutions',
    email: process.env.DIGIFORGE_EMAIL || 'info@digiforgeconsulting.com',
  },
];

let _contactIndex = 0;
let _angleRotationIndex = 0;

// ── 3 Core Singapore B2B Outreach Angles ─────────────────────────────────────
// Angle 1: Agency & MSP Channel Partner (White-label technical backend)
function getAngle1Agency(full_name) {
  const subject = resolveSpintax('{White-label tech & integration backend for your agency|Custom API & workflow integration partner for agencies|White-label technical delivery partner}');
  const message = resolveSpintax(`{Hi Team|Hello|Hi there},

Having worked with tech {partner channels|networks} across Singapore, we know how often local agency and MSP teams receive client requests for custom workflow automations, CRM pipelines, or portal integrations that distract from your core retainers.

At DigiForge Consulting SG, we act as a dedicated white-label backend technical delivery team for Singapore agencies. We handle the custom integrations and automation sprints so you can say "yes" to client tech requests and retain {15–20%|15% to 20%} margin without {managing developers|writing a line of code}.

Would love to do a brief 10-minute catchup this week to see if we can take any technical backlog off your plate.

{Best regards|Warm regards|Kind regards},
${full_name}
DigiForge Consulting SG
https://digiforgeconsulting.com
info@digiforgeconsulting.com`);
  return { subject, message };
}

// Angle 2: High-Value B2B Lead Capture & Instant WhatsApp Bridge (Sprint 1)
function getAngle2LeadCapture(full_name) {
  const subject = resolveSpintax('{Quick observation regarding your website lead flow|Instant WhatsApp & lead routing for your inquiry form|Eliminating lead leakage on website inquiries}');
  const message = resolveSpintax(`{Hi Team|Hello|Hi there},

I was looking at your inquiry page while reviewing B2B service firms in Singapore.

When a prospective client submits a contact inquiry, there is {often no instant WhatsApp redirect or automated scheduling link|a delay before anyone can follow up by email}. For high-value Singapore B2B services, this delay causes {over 30%|30%+} of warm inquiries to drop off before the first conversation.

We help Singapore firms bridge this gap with automated lead routing—instantly capturing form inquiries directly into WhatsApp and your CRM in real time. We deploy the complete flow in a focused 14-day sprint.

If this is a priority for your team this quarter, happy to share how top local firms are setting this up.

{Best regards|Warm regards|Kind regards},
${full_name}
DigiForge Consulting SG
https://digiforgeconsulting.com
info@digiforgeconsulting.com`);
  return { subject, message };
}

// Angle 3: 14-Day Workflow & Order Automation Sprint (Sprint 2)
function getAngle3OrderAutomation(full_name) {
  const subject = resolveSpintax('{Automating order-to-invoice workflows in 14 days|Eliminating manual order entry from WhatsApp & email|Order-to-invoice automation sprint}');
  const message = resolveSpintax(`{Hi Team|Hello|Hi there},

Most growing trading and wholesale firms in Singapore lose {10–15 hours|15+ hours} every week manually processing incoming orders from WhatsApp/email into Xero or ERP invoices.

Waiting 3 to 4 months for PSG/EDG grant approvals delays real progress. DigiForge delivers bounded automation sprints in 14 days flat—connecting your order intake directly to automated invoice creation for less than a typical grant co-payment.

Would you be open to exploring how we can streamline your order operations this month?

{Best regards|Warm regards|Kind regards},
${full_name}
DigiForge Consulting SG
https://digiforgeconsulting.com
info@digiforgeconsulting.com`);
  return { subject, message };
}

// Selects the message angle dynamically based on URL keywords or round-robin
function selectAnglePayload(urlOrHint, full_name) {
  const lower = (urlOrHint || '').toLowerCase();

  // Pattern detection from URL/domain/hint
  const isAgency = /agency|marketing|digital|media|seo|web|design|creative|msp|tech\b|cloud|it-/.test(lower);
  const isB2B = /recruit|search|talent|headhunt|staffing|secretar|incorporat|account|audit|legal|law|consult/.test(lower);
  const isOperations = /wholesale|distribut|trading|import|export|freight|logistics|supply|warehouse|equipment/.test(lower);

  if (isAgency) return getAngle1Agency(full_name);
  if (isB2B) return getAngle2LeadCapture(full_name);
  if (isOperations) return getAngle3OrderAutomation(full_name);

  // Round-robin rotation if niche is ambiguous or unclassified
  const angleChoosers = [getAngle1Agency, getAngle2LeadCapture, getAngle3OrderAutomation];
  const chosenFn = angleChoosers[_angleRotationIndex % angleChoosers.length];
  _angleRotationIndex++;
  return chosenFn(full_name);
}

// Returns the next contact in round-robin order, fully expanded for fields.js
function getNextContact(urlOrHint = '') {
  const base = _CONTACTS[_contactIndex % _CONTACTS.length];
  _contactIndex++;

  const full = `${base.first_name} ${base.last_name}`.trim();
  const rawPhone = process.env.DIGIFORGE_PHONE;
  const cleanDigits = rawPhone.replace(/\D/g, '');
  const localDigits = cleanDigits.startsWith('65') ? cleanDigits.slice(2) : cleanDigits;

  const { subject, message } = selectAnglePayload(urlOrHint, full);

  return {
    first_name: base.first_name,
    last_name: base.last_name,
    full_name: full,
    job_title: 'Partnerships & Solutions',
    email: base.email,
    phone: rawPhone,
    phone_country_code: '+65',
    phone_local: localDigits,
    company: 'DigiForge Consulting SG',
    website: 'https://digiforgeconsulting.com',
    secondary_website: 'https://digiforge.sg',
    country: 'Singapore',
    address: 'Singapore',
    subject: subject,
    budget: 'Flexible',
    message: message,
  };
}

// Default contact for backward compat
const contact = getNextContact();
_contactIndex = 0;
_angleRotationIndex = 0;

// ── File paths & tuning constants ─────────────────────────────────────────────
const URL_FILE = 'retry_urls.txt';
const OUTPUT_DIR = 'form_results';
const CSV_PATH = `${OUTPUT_DIR}/contact_results.csv`;
const PROGRESS_FILE = `${OUTPUT_DIR}/progress.txt`;
const PAGE_LOAD_TIMEOUT = 20000;
const CAPTCHA_WAIT_TIMEOUT = 20000;
const CAPTCHA_POLICY = 'auto';
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY || null;
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || null;
const MAX_CAPTCHA_RETRIES = 1;

const CSV_FIELDS = [
  'url', 'status', 'details', 'load_status', 'load_time_s',
  'contact_page_status', 'form_status', 'fields_filled',
  'filled_fields', 'failed_fields',
  'validation_status', 'captcha_status', 'submit_status', 'success_status',
];

module.exports = {
  contact, getNextContact, resolveSpintax,
  URL_FILE, OUTPUT_DIR, CSV_PATH, PROGRESS_FILE,
  PAGE_LOAD_TIMEOUT, CAPTCHA_WAIT_TIMEOUT, CAPTCHA_POLICY,
  TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY, MAX_CAPTCHA_RETRIES, CSV_FIELDS,
};
