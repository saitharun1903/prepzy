"""Transactional email (verification, password reset).

Backends: ``console`` (local profile: the message, including its link, is written to the API log —
nothing is delivered, and the UI must not claim delivery), ``smtp`` (any provider via SMTP with
STARTTLS) and ``brevo`` (Brevo's HTTPS API: for hosts that block outbound SMTP ports, such as
Render's free instances). Sending is best-effort and never reveals to the caller whether an
address exists.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import parseaddr

import httpx

from ..config import get_settings
from ..logs import log

logger = logging.getLogger("elevate.email")


def _send(to: str, subject: str, text_body: str) -> bool:
    s = get_settings()
    if s.email_backend == "console":
        log(logger, logging.WARNING, "email (console backend; NOT delivered)", to_domain=to.split("@")[-1],
            subject=subject, preview=text_body)
        return False
    if s.email_backend == "brevo":
        return _send_brevo(to, subject, text_body)
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.email_from, to, subject
    msg.set_content(text_body)
    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
            if s.smtp_starttls:
                smtp.starttls(context=ssl.create_default_context())
            if s.smtp_username:
                smtp.login(s.smtp_username, s.smtp_password)
            smtp.send_message(msg)
        log(logger, logging.INFO, "email accepted by SMTP server", subject=subject, to_domain=to.split("@")[-1])
        return True
    except (smtplib.SMTPException, OSError):
        logger.exception("email send failed")
        return False


def _send_brevo(to: str, subject: str, text_body: str) -> bool:
    s = get_settings()
    name, sender = parseaddr(s.email_from)
    body = {"sender": {"name": name or "Prepzy", "email": sender}, "to": [{"email": to}],
            "subject": subject, "textContent": text_body}
    try:
        r = httpx.post("https://api.brevo.com/v3/smtp/email", json=body, timeout=15,
                       headers={"api-key": s.brevo_api_key, "accept": "application/json"})
    except httpx.HTTPError:
        logger.exception("email send failed")
        return False
    if r.status_code >= 300:
        # Brevo's error body names the problem (e.g. unverified sender); it never contains the key.
        log(logger, logging.ERROR, "email rejected by Brevo", status=r.status_code, detail=r.text[:300])
        return False
    log(logger, logging.INFO, "email accepted by Brevo", subject=subject, to_domain=to.split("@")[-1])
    return True


def send_verification(to: str, token: str) -> bool:
    link = f"{get_settings().web_url.rstrip('/')}/verify-email?token={token}"
    return _send(to, "Confirm your Prepzy email", (
        "Welcome to Prepzy.\n\nConfirm your email address by opening this link (valid for 48 hours):\n\n"
        f"{link}\n\nIf you didn't create an account, you can ignore this email."))


def send_password_reset(to: str, token: str) -> bool:
    link = f"{get_settings().web_url.rstrip('/')}/reset-password?token={token}"
    return _send(to, "Reset your Prepzy password", (
        "Someone asked to reset the password for your Prepzy account.\n\n"
        f"Open this link within 30 minutes to choose a new password:\n\n{link}\n\n"
        "If this wasn't you, ignore this email; your password stays the same."))
