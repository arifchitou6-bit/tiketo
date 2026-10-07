// Configuration de l'API. Les variables SUPABASE_* sont injectées automatiquement par Supabase.

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

const supabaseUrl = required("SUPABASE_URL");

export const env = {
  supabaseUrl,
  // URL du projet vue depuis le navigateur (liens publics des images).
  // En local, SUPABASE_URL est l'adresse interne Docker (http://kong:8000) : il faut la surcharger.
  publicSupabaseUrl: (Deno.env.get("PUBLIC_SUPABASE_URL") ?? supabaseUrl).replace(/\/$/, ""),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  anonKey: required("SUPABASE_ANON_KEY"),
  // URL publique de l'API (liens vers les images QR des tickets)
  get apiPublicUrl() {
    return `${this.publicSupabaseUrl}/functions/v1/api`;
  },
  // Adresse du front : sert à construire les liens publics renvoyés par l'API (page événement…).
  publicAppUrl: (Deno.env.get("PUBLIC_APP_URL") ?? "http://localhost:3000").replace(/\/$/, ""),
  // Origines autorisées à appeler l'API (CORS). Vide = toutes (développement uniquement).
  allowedOrigins: list(Deno.env.get("ALLOWED_ORIGINS")),
};
