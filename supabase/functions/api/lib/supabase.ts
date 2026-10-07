import { createClient } from "@supabase/supabase-js";
import { env } from "./env.ts";

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// Client service_role : contourne la RLS, les contrôles de propriété sont faits dans l'API.
export const admin = createClient(env.supabaseUrl, env.serviceRoleKey, options);

// Client anon éphémère pour les opérations de session (login / refresh) : aucun état partagé entre requêtes.
export function anonClient() {
  return createClient(env.supabaseUrl, env.anonKey, options);
}
