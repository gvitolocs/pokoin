"""Only local command fakes; never calls systemctl or production publishers."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'cutover-newsroom-rust.sh'

class CutoverTest(unittest.TestCase):
    def run_cutover(self, gate=True, health=True, stop=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'env').write_text('LOCAL_ONLY=test\n')
            (root / 'env').chmod(0o600)
            binary = root / 'newsroom'
            binary.write_text('''#!/bin/bash
printf 'binary %s\\n' "$1" >> "$TRACE"
case "$1" in
preflight) [[ "$GATE" = yes ]];;
snapshot) exit 0;;
ready) [[ "$HEALTH" = yes ]];;
esac
''')
            binary.chmod(0o755)
            systemctl = root / 'systemctl'
            systemctl.write_text('''#!/bin/bash
shift
printf 'systemctl %s\\n' "$*" >> "$TRACE"
case "$1" in
is-active) unit=${@: -1}; [[ -f "$FAKE_ROOT/$unit" ]];;
start) touch "$FAKE_ROOT/$2";;
stop) if [[ "$2" = pokoin-newsroom-rust.service && "$STOP" = no ]]; then exit 1; fi; rm -f "$FAKE_ROOT/$2";;
esac
''')
            systemctl.chmod(0o755)
            # Keep the readiness-failure test fast without sleeping.
            (root / 'sleep').write_text('#!/bin/sh\nexit 0\n')
            (root / 'sleep').chmod(0o755)
            (root / 'pokoin-newsroom.service').touch()
            env = {**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'],
                   'NEWSROOM_RUST_BINARY': str(binary), 'NEWSROOM_DATA_DIR': str(root / 'data'),
                   'NEWSROOM_ENV_FILE': str(root / 'env'), 'NEWSROOM_BACKUP_DIR': str(root / 'backups'),
                   'TRACE': str(root / 'trace'), 'FAKE_ROOT': str(root),
                   'GATE': 'yes' if gate else 'no', 'HEALTH': 'yes' if health else 'no', 'STOP': 'yes' if stop else 'no'}
            result = subprocess.run(['bash', str(SCRIPT), '--execute'], env=env, text=True, capture_output=True)
            return result.returncode, (root / 'trace').read_text(), (root / 'pokoin-newsroom.service').exists(), (root / 'pokoin-newsroom-rust.service').exists()

    def test_incomplete_parity_never_touches_services(self):
        code, trace, old, new = self.run_cutover(gate=False)
        self.assertNotEqual(code, 0)
        self.assertNotIn('systemctl', trace)
        self.assertTrue(old)
        self.assertFalse(new)

    def test_success_stops_node_snapshots_then_starts_rust(self):
        code, trace, old, new = self.run_cutover()
        self.assertEqual(code, 0)
        self.assertFalse(old)
        self.assertTrue(new)
        self.assertLess(trace.index('stop pokoin-newsroom.service'), trace.index('binary snapshot'))
        self.assertLess(trace.index('binary snapshot'), trace.index('start pokoin-newsroom-rust.service'))

    def test_failed_health_restores_node(self):
        code, trace, old, new = self.run_cutover(health=False)
        self.assertNotEqual(code, 0)
        self.assertTrue(old)
        self.assertFalse(new)
        self.assertLess(trace.index('stop pokoin-newsroom-rust.service'), trace.index('start pokoin-newsroom.service'))

    def test_failed_rust_stop_does_not_start_second_publisher(self):
        code, trace, old, new = self.run_cutover(health=False, stop=False)
        self.assertNotEqual(code, 0)
        self.assertFalse(old)
        self.assertTrue(new)
        self.assertNotIn('start pokoin-newsroom.service\n', trace)

if __name__ == '__main__':
    unittest.main()
