"""The staging snapshot event names only a commit whose archive was verified for that commit."""
from pathlib import Path
import re
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/release.yml"


def job(text, name):
    match = re.search(rf"^  {name}:\n((?:    .*\n|\n)+?)(?=^  \S|\Z)", text, re.M)
    if not match:
        raise AssertionError(f"job {name} missing")
    return match.group(1)


class StagingSnapshotEvent(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_announced_only_after_the_archive_is_retained(self):
        snapshot = job(self.text, "staging-snapshot")
        self.assertIn("needs: [validated-archive]", snapshot)
        self.assertIn("needs: [build, validate]", job(self.text, "validated-archive"))
        self.assertIn("github.event_name == 'push'", snapshot)

    def test_archive_revision_is_checked_against_the_commit(self):
        self.assertIn('RELEASE_REVISION: ${{ inputs.revision || github.sha }}', self.text)
        build = job(self.text, "build")
        self.assertRegex(build, r"verify-release-tools\.py --bundle release/ptn-linux-x86_64 --revision \"\$RELEASE_REVISION\"")

    def test_event_carries_the_commit_and_no_deployment_details(self):
        snapshot = job(self.text, "staging-snapshot")
        self.assertIn("event_type=ptn_snapshot_published", snapshot)
        self.assertIn('client_payload[sourceSha]=$RELEASE_REVISION', snapshot)
        self.assertIn("vars.STAGING_DISPATCH_REPOSITORY", snapshot)
        self.assertNotRegex(snapshot, r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/dispatches")
        self.assertNotRegex(snapshot, r"\b\d{1,3}(\.\d{1,3}){3}\b")


if __name__ == "__main__":
    unittest.main()
