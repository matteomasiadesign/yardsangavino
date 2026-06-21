// lib/supabaseAdmin.js
// Client Supabase lato server, usato SOLO dalle serverless function in /api.
// Usa la Service Role Key (bypassa RLS) — non va MAI importato in codice
// che finisce nel browser (index.html / admin.html).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://germswzsfsxxlawqxsgt.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  // Non lanciamo subito un'eccezione qui per non rompere il build,
  // ma ogni funzione che importa questo modulo controlla la presenza
  // della env var prima di usarla (vedi api/*.js).
  console.warn('[supabaseAdmin] SUPABASE_SERVICE_ROLE_KEY non impostata.');
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

module.exports = { supabaseAdmin, SUPABASE_URL };
