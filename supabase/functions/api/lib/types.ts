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

export interface BuyerSession {
  sessionId: string;
  buyerId: string;
  phone: string;
}

// Variables de contexte Hono partagées par toutes les routes
export interface AppEnv {
  Variables: {
    user: AuthUser;
    staff: StaffSession;
    // Acheteur connecté (absent si la route accepte les visiteurs non connectés)
    buyer?: BuyerSession;
  };
}
