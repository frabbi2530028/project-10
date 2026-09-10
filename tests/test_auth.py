"""
Credential checking and session tokens.

Every fixture value here is invented. The format rules are what is under test,
so the pairs only need to be internally consistent, never real.
"""

from datetime import date

import pytest

import auth

# An internally consistent pair: the email's last 7 digits (trimester 251 +
# roll 0001) match the student ID's, and 251 is safely in the past.
VALID_EMAIL = "someone2510001@cse.uiu.ac.bd"
VALID_ID = "0102510001"


@pytest.fixture(autouse=True)
def clear_sessions():
    auth._sessions.clear()
    yield
    auth._sessions.clear()


class TestCurrentTrimester:
    @pytest.mark.parametrize(
        "today, expected",
        [
            (date(2026, 2, 1), "261"),   # Spring starts in February
            (date(2026, 6, 30), "261"),  # …and runs to the end of June
            (date(2026, 7, 1), "262"),   # Summer
            (date(2026, 10, 31), "262"),
            (date(2026, 11, 1), "263"),  # Winter
            (date(2026, 12, 31), "263"),
            # January belongs to the Winter that began the previous November,
            # so the year in the code is still the year it started.
            (date(2027, 1, 15), "263"),
        ],
    )
    def test_seasons_map_to_the_right_code(self, today, expected):
        assert auth.current_trimester(today) == expected

    def test_environment_override_wins(self, monkeypatch):
        monkeypatch.setenv("CURRENT_TRIMESTER", "999")
        assert auth.current_trimester(date(2026, 3, 1)) == "999"


class TestValidateStudent:
    def test_accepts_a_consistent_pair(self):
        student, error = auth.validate_student(VALID_EMAIL, VALID_ID)
        assert error is None
        assert student.department == "cse"
        assert student.department_code == "010"
        assert student.trimester == "251"
        assert student.roll == "0001"

    def test_normalises_case_and_surrounding_space(self):
        student, error = auth.validate_student(f"  {VALID_EMAIL.upper()} ", f" {VALID_ID} ")
        assert error is None
        assert student.email == VALID_EMAIL

    @pytest.mark.parametrize(
        "email, student_id",
        [
            ("", VALID_ID),                              # nothing entered
            (VALID_EMAIL, ""),
            ("not-an-email", VALID_ID),                  # no @
            ("someone2510001@gmail.com", VALID_ID),      # not a UIU domain
            ("someone2510001@uiu.ac.bd", VALID_ID),      # no department subdomain
            ("someone251001@cse.uiu.ac.bd", VALID_ID),   # 6 digits, not 7
            ("2510001@cse.uiu.ac.bd", VALID_ID),         # no name part
            (VALID_EMAIL, "010251000"),                  # 9-digit ID
            (VALID_EMAIL, "01025100011"),                # 11-digit ID
            (VALID_EMAIL, "010251000x"),                 # not all digits
            (VALID_EMAIL, "0102510002"),                 # roll disagrees
            (VALID_EMAIL, "0102520001"),                 # trimester disagrees
        ],
    )
    def test_rejects_inconsistent_or_malformed_input(self, email, student_id):
        student, error = auth.validate_student(email, student_id)
        assert student is None
        assert error  # a human-readable reason, never an empty string

    def test_rejects_an_impossible_season(self):
        # Season 4 does not exist — only 1 (Spring), 2 (Summer), 3 (Winter).
        student, error = auth.validate_student("someone2540001@cse.uiu.ac.bd", "0102540001")
        assert student is None
        assert "trimester" in error.lower()

    def test_rejects_a_trimester_that_has_not_started(self, monkeypatch):
        monkeypatch.setenv("CURRENT_TRIMESTER", "251")
        student, error = auth.validate_student("someone2520001@cse.uiu.ac.bd", "0102520001")
        assert student is None
        assert "hasn't started" in error

    def test_public_payload_carries_no_name(self):
        student, _ = auth.validate_student(VALID_EMAIL, VALID_ID)
        payload = student.public()
        assert payload["role"] == "student"
        assert "name" not in payload
        # department_code is an internal detail, not something the UI needs.
        assert "department_code" not in payload


class TestSessions:
    def test_issue_then_resolve(self):
        student, _ = auth.validate_student(VALID_EMAIL, VALID_ID)
        token = auth.issue_token(student)
        assert auth.resolve_token(token) is student

    @pytest.mark.parametrize("token", [None, "", "not-a-real-token"])
    def test_unknown_tokens_resolve_to_nothing(self, token):
        assert auth.resolve_token(token) is None

    def test_revoke(self):
        student, _ = auth.validate_student(VALID_EMAIL, VALID_ID)
        token = auth.issue_token(student)
        auth.revoke_token(token)
        assert auth.resolve_token(token) is None
        auth.revoke_token(token)  # revoking twice is harmless

    def test_tokens_are_unique_per_login(self):
        student, _ = auth.validate_student(VALID_EMAIL, VALID_ID)
        assert auth.issue_token(student) != auth.issue_token(student)

    def test_expired_tokens_stop_working_and_are_collected(self, monkeypatch):
        student, _ = auth.validate_student(VALID_EMAIL, VALID_ID)
        clock = [1000.0]
        monkeypatch.setattr(auth, "_now", lambda: clock[0])

        token = auth.issue_token(student)
        clock[0] += auth.SESSION_TTL_SECONDS + 1

        assert auth.resolve_token(token) is None
        assert auth.active_session_count() == 0  # not merely rejected — dropped
