export interface AuthUser {
  id: string;
  email: string;
  // Jeton d'accès brut, conservé pour la déconnexion
  accessToken: string;
}

export interface StaffSession {
  sessionId: string;
  eventId: string;
  staffCode: string;
}

// Variables de contexte Hono partagées par toutes les routes
export interface AppEnv {
  Variables: {
    user: AuthUser;
    staff: StaffSession;
  };
}
