"""
UIU student credential checking.

A UIU student email looks like:

    frabbi2530028@bsds.uiu.ac.bd
    └─┬──┘└┬┘└┬─┘ └─┬┘
     name  │  roll  department
        trimester

and the matching student ID looks like:

    0152530028
    └┬┘└┬┘└┬─┘
     │   │  roll
     │  trimester
    department code

A pair is accepted when the trimester and roll encoded in the email are the
same as the ones in the student ID — i.e. the last 7 digits of the email's
local part equal the last 7 digits of the student ID.

⚠️  This is a format/consistency check, NOT authentication. It proves the two
values agree, not that the person submitting them owns that email. Anyone who
knows (or guesses) a valid pair can pass it, and a matching pair is easy to
construct by hand. Verifying identity needs something only the mailbox owner
can see — a one-time code emailed to the address. See README.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

# Local part: a name (letters, dots, hyphens) followed by exactly 7 digits,
# which are trimester (3) + roll (4).
_LOCAL_RE = re.compile(r"^([a-z][a-z.\-]*)(\d{7})$")

# Department subdomain, e.g. "bsds" in bsds.uiu.ac.bd
_DOMAIN_RE = re.compile(r"^([a-z]+)\.uiu\.ac\.bd$")

# Student ID: department code (3) + trimester (3) + roll (4)
_STUDENT_ID_RE = re.compile(r"^(\d{3})(\d{3})(\d{4})$")


@dataclass(frozen=True)
class Student:
    """A validated student identity. Deliberately carries no name."""

    email: str
    student_id: str
    department: str       # from the email domain, e.g. "bsds"
    department_code: str  # from the student ID, e.g. "015"
    trimester: str        # e.g. "253"
    roll: str             # e.g. "0028"

    def public(self) -> dict:
        """The subset safe to hand back to the browser."""
        return {
            "email": self.email,
            "student_id": self.student_id,
            "department": self.department,
            "trimester": self.trimester,
            "roll": self.roll,
            "role": "student",
        }


def validate_student(email: str, student_id: str) -> Tuple[Optional[Student], Optional[str]]:
    """
    Check an (email, student_id) pair.

    Returns (Student, None) when the pair is consistent, otherwise
    (None, human-readable reason).
    """
    email = (email or "").strip().lower()
    student_id = (student_id or "").strip()

    if not email or not student_id:
        return None, "Enter both your UIU email and your student ID."

    if "@" not in email:
        return None, "That doesn't look like an email address."

    local, _, domain = email.partition("@")

    domain_match = _DOMAIN_RE.match(domain)
    if not domain_match:
        return None, "Use your UIU email address (…@<department>.uiu.ac.bd)."

    local_match = _LOCAL_RE.match(local)
    if not local_match:
        return None, (
            "That UIU email doesn't have the expected form — it should be your "
            "name followed by 7 digits, e.g. frabbi2530028@bsds.uiu.ac.bd."
        )

    id_match = _STUDENT_ID_RE.match(student_id)
    if not id_match:
        return None, "A student ID is 10 digits, e.g. 0152530028."

    email_digits = local_match.group(2)          # trimester + roll, 7 digits
    department_code, trimester, roll = id_match.groups()

    if email_digits != trimester + roll:
        return None, (
            "Your email and student ID don't match — the trimester and roll "
            "number in each should be the same."
        )

    return (
        Student(
            email=email,
            student_id=student_id,
            department=domain_match.group(1),
            department_code=department_code,
            trimester=trimester,
            roll=roll,
        ),
        None,
    )


# ---------------------------------------------------------------------------
# Session tokens
# ---------------------------------------------------------------------------
#
# Held in memory, so every restart signs everyone out. That is fine for a
# single-instance deployment and keeps the door shut on the WebSocket without
# pulling in a database or a JWT library.

_sessions: Dict[str, Student] = {}


def issue_token(student: Student) -> str:
    token = secrets.token_urlsafe(24)
    _sessions[token] = student
    return token


def resolve_token(token: Optional[str]) -> Optional[Student]:
    if not token:
        return None
    return _sessions.get(token)


def revoke_token(token: Optional[str]) -> None:
    if token:
        _sessions.pop(token, None)


def active_session_count() -> int:
    return len(_sessions)
