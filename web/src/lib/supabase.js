import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// This client only ever runs in the browser with the anon key, which — per the
// SQL policy set up in schema.sql / README — has read-only SELECT access to
// `checks`. Writes go through the ingest worker with the service-role key,
// which never reaches the browser.
export const supabase = createClient(url, anonKey);

export const API_URL = import.meta.env.VITE_API_URL;
