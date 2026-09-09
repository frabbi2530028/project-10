"""
UIU student credential checking.

A UIU student email looks like:

    name2510001@dept.uiu.ac.bd
    └─┬┘└┬┘└┬─┘ └─┬┘
    name │  roll  department
        trimester

and the matching student ID looks like:

    0102510001
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

import os
import re
import secrets
from datetime import date
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

# ---------------------------------------------------------------------------
# UIU trimester calendar
# ---------------------------------------------------------------------------
#
# A trimester code is YYS — two year digits then the season:
#
#   1 = Spring   February – June
#   2 = Summer   July – October
#   3 = Winter   November – January
#
# So Summer 2026 is 262, and Winter 2026 is 263 — which runs on into January
# 2027 while still being 263, because the year in the code is the year the
# trimester *started*.
#
# Nobody can hold a trimester that hasn't begun yet: while 262 is running, a
# 263 ID doesn't exist, so it's rejected until November rolls around.

SPRING, SUMMER, WINTER = "1", "2", "3"
VALID_SEASONS = {SPRING, SUMMER, WINTER}


def current_trimester(today: Optional[date] = None) -> str:
    """The trimester code in effect on *today*, e.g. '262'."""
    override = os.environ.get("CURRENT_TRIMESTER", "").strip()
    if override:
        return override

    today = today or date.today()
    month, year = today.month, today.year

    if 2 <= month <= 6:
        season = SPRING
    elif 7 <= month <= 10:
        season = SUMMER
    else:
        season = WINTER
        # January still belongs to the Winter that began the previous November.
        if month == 1:
            year -= 1

    return f"{year % 100:02d}{season}"

# Local part: a name (letters, dots, hyphens) followed by exactly 7 digits,
# which are trimester (3) + roll (4).
_LOCAL_RE = re.compile(r"^([a-z][a-z.\-]*)(\d{7})$")

# Department subdomain, e.g. "dept" in dept.uiu.ac.bd
_DOMAIN_RE = re.compile(r"^([a-z]+)\.uiu\.ac\.bd$")

# Student ID: department code (3) + trimester (3) + roll (4)
_STUDENT_ID_RE = re.compile(r"^(\d{3})(\d{3})(\d{4})$")


@dataclass(frozen=True)
class Student:
    """A validated student identity. Deliberately carries no name."""

    email: str
    student_id: str
    department: str       # from the email domain, e.g. "dept"
    department_code: str  # from the student ID, e.g. "010"
    trimester: str        # e.g. "251"
    roll: str             # e.g. "0001"

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
            "name followed by 7 digits, e.g. name2510001@dept.uiu.ac.bd."
        )

    id_match = _STUDENT_ID_RE.match(student_id)
    if not id_match:
        return None, "A student ID is 10 digits, e.g. 0102510001."

    email_digits = local_match.group(2)          # trimester + roll, 7 digits
    department_code, trimester, roll = id_match.groups()

    if email_digits != trimester + roll:
        return None, (
            "Your email and student ID don't match — the trimester and roll "
            "number in each should be the same."
        )

    # The trimester has to be a real one. Season is 1 (Spring), 2 (Summer) or
    # 3 (Winter); anything else can't exist.
    season = trimester[2]
    if season not in VALID_SEASONS:
        return None, (
            "That trimester doesn't exist — the last digit should be "
            "1 (Spring), 2 (Summer) or 3 (Winter)."
        )

    # …and it can't be one that hasn't started yet.
    now = current_trimester()
    if int(trimester) > int(now):
        return None, (
            f"Trimester {trimester} hasn't started yet — the current one is {now}."
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
