// Envoi des e-mails transactionnels (code de connexion acheteur) via l'API Brevo.
// Sans BREVO_API_KEY (développement local), l'envoi est ignoré et signalé dans le journal.

import { ApiError } from "./errors.ts";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

// Domaines réservés (RFC 2606/6761) : jamais d'envoi réel. Les tests automatiques utilisent
// example.com : pas de crédit consommé, pas de rebond qui dégraderait la réputation de l'expéditeur.
const RESERVED = /@(?:[^@]+\.)?(?:example\.(?:com|org|net)|[^@]+\.(?:test|invalid|localhost|example))$/i;

function otpHtml(code: string, minutes: number) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1a1a2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px">
<tr><td style="padding:28px 32px 8px;font-size:22px;font-weight:bold;letter-spacing:1px">TICKETO</td></tr>
<tr><td style="padding:8px 32px;font-size:16px;line-height:24px">Voici votre code de connexion :</td></tr>
<tr><td align="center" style="padding:16px 32px"><div style="font-size:36px;font-weight:bold;letter-spacing:10px;background:#f4f4f7;border-radius:8px;padding:16px 8px">${code}</div></td></tr>
<tr><td style="padding:8px 32px 28px;font-size:14px;line-height:22px;color:#555">Ce code est valable <b>${minutes} minutes</b>. Ne le communiquez à personne : l&#39;équipe TICKETO ne vous le demandera jamais.<br><br>Vous n&#39;avez pas demandé ce code ? Ignorez simplement cet e-mail.</td></tr>
</table><p style="font-size:12px;color:#888;margin-top:16px">TICKETO · Billetterie au Bénin</p></td></tr></table></body></html>`;
}

export async function sendOtpEmail(to: string, code: string, minutes: number): Promise<void> {
  if (RESERVED.test(to)) return;

  const apiKey = Deno.env.get("BREVO_API_KEY");
  const sender = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!apiKey || !sender) {
    console.warn("[email] BREVO_API_KEY ou BREVO_SENDER_EMAIL absent : code non envoyé (développement)");
    return;
  }

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "TICKETO", email: sender },
      to: [{ email: to }],
      subject: `${code} est votre code TICKETO`,
      htmlContent: otpHtml(code, minutes),
      textContent: `TICKETO\n\nVotre code de connexion : ${code}\nValable ${minutes} minutes. Ne le communiquez à personne.\n\n` +
        "Vous n'avez pas demandé ce code ? Ignorez cet e-mail.",
      tags: ["ticketo-otp"],
    }),
  });
  if (!res.ok) {
    // Jamais l'adresse ni le code dans le journal
    console.error("[email] échec d'envoi Brevo", { status: res.status });
    throw new ApiError(502, "EMAIL_FAILED", "Le code n'a pas pu être envoyé, réessayez dans un instant");
  }
}
