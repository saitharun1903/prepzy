"""Transactional email (verification, password reset).

Backends: ``console`` (local profile: the message, including its link, is written to the API log —
nothing is delivered, and the UI must not claim delivery) and ``smtp`` (any provider: Resend,
Brevo, SES, Postmark ... via SMTP with STARTTLS). Sending is best-effort and never reveals to the
caller whether an address exists.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage

from ..config import get_settings
from ..logs import log

logger = logging.getLogger("elevate.email")


def _send(to: str, subject: str, text_body: str) -> bool:
    s = get_settings()
    if s.email_backend == "console":
        log(logger, logging.WARNING, "email (console backend; NOT delivered)", to_domain=to.split("@")[-1],
            subject=subject, preview=text_body)
        return False
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


def send_verification(to: str, token: str) -> bool:
    link = f"{get_settings().web_url.rstrip('/')}/verify-email?token={token}"
    return _send(to, "Confirm your Elevate email", (
        "Welcome to Elevate.\n\nConfirm your email address by opening this link (valid for 48 hours):\n\n"
        f"{link}\n\nIf you didn't create an account, you can ignore this email."))


def send_password_reset(to: str, token: str) -> bool:
    link = f"{get_settings().web_url.rstrip('/')}/reset-password?token={token}"
    return _send(to, "Reset your Elevate password", (
        "Someone asked to reset the password for your Elevate account.\n\n"
        f"Open this link within 30 minutes to choose a new password:\n\n{link}\n\n"
        "If this wasn't you, ignore this email; your password stays the same."))
