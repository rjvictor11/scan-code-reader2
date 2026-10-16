// Fill these in from your Supabase project: Settings -> API -> Project URL / anon public key.
// The anon key is safe to expose client-side -- Row Level Security is what actually gates access.
// This is its own dedicated Supabase project (separate from harness-toolkit's).
const SUPABASE_URL = "https://sdqkrvtohnkdffzcyrcj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mKzCPwmgFxAGI2PVD3ETJA_Aq_HMfLD";

const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
