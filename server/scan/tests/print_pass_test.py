import sys
import threading
import time
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
import app


class FakeStrip:
    def __init__(self, result=None, exc=None, delay=0.0):
        self.result = result
        self.exc = exc
        self.delay = delay
        self.calls = []

    def read(self, card_rgb, game='pokemon'):
        self.calls.append((card_rgb, game))
        if self.delay:
            time.sleep(self.delay)
        if self.exc is not None:
            raise self.exc
        out = dict(self.result or {})
        out.setdefault('ms', 12.0)
        return out


def fresh_store():
    app._print_results.clear()
    app._print_store_prune_locked(time.time())
    return app._print_results


class PrintPassTest(unittest.TestCase):
    def setUp(self):
        self.store = fresh_store()
        self._old_strip = app._print_strip
        self._old_failed = app._print_strip_failed
        self.strip = FakeStrip(result={'collector': {'num': '63', 'den': '102'}, 'set_code': 'BS', 'language': {'code': 'en'}})
        app._print_strip = self.strip
        app._print_strip_failed = False
        self.addCleanup(self._teardown)

    def _teardown(self):
        app._print_strip = self._old_strip
        app._print_strip_failed = self._old_failed
        self.store.clear()

    def test_job_completes_and_wait_returns_print(self):
        app._enqueue_print('a' * 16, None, 'pokemon')
        out = app._print_store_wait(['a' * 16], 1000)
        self.assertEqual(out['pending'], [])
        self.assertEqual(out['unknown'], [])
        self.assertEqual(out['prints']['a' * 16]['collector']['num'], '63')

    def test_wait_returns_pending_before_deadline_passes(self):
        slow = FakeStrip(delay=0.3)
        app._print_strip = slow
        app._enqueue_print('b' * 16, None, 'pokemon')
        out = app._print_store_wait(['b' * 16], 50)
        self.assertEqual(out['pending'], ['b' * 16])
        self.assertEqual(out['prints']['b' * 16], None)
        done = app._print_store_wait(['b' * 16], 2000)
        self.assertEqual(done['pending'], [])
        self.assertIsNotNone(done['prints']['b' * 16])

    def test_unknown_ids_are_reported(self):
        out = app._print_store_wait(['f' * 16], 10)
        self.assertEqual(out['unknown'], ['f' * 16])
        self.assertEqual(out['prints'], {})

    def test_error_marks_entry_error_not_done(self):
        app._print_strip = FakeStrip(exc=RuntimeError('ocr exploded'))
        app._enqueue_print('c' * 16, None, 'pokemon')
        out = app._print_store_wait(['c' * 16], 2000)
        self.assertEqual(out['pending'], [])
        self.assertIsNone(out['prints']['c' * 16])
        entry = self.store.get('c' * 16)
        self.assertEqual(entry['state'], 'error')

    def test_store_bounded_and_fifo(self):
        app.PRINT_STORE_MAX = 4
        self.addCleanup(lambda: setattr(app, 'PRINT_STORE_MAX', 2048))
        for i, ch in enumerate('abcdefgh'):
            app._print_store_put(ch * 16, now=float(i))
        self.assertEqual(len(self.store), 4)
        self.assertNotIn('a' * 16, self.store)
        self.assertIn('h' * 16, self.store)

    def test_ttl_prune(self):
        app._print_store_put('d' * 16, now=time.time() - app.PRINT_STORE_TTL_S - 5)
        app._print_store_put('e' * 16, now=time.time())
        app._print_store_prune_locked(time.time())
        self.assertNotIn('d' * 16, self.store)
        self.assertIn('e' * 16, self.store)

    def test_wait_releases_threadpool_not_identify_lock(self):
        # The job runs on the print executor thread, not the caller's.
        app._enqueue_print('1' * 16, None, 'pokemon')
        out = app._print_store_wait(['1' * 16], 2000)
        self.assertEqual(out['pending'], [])
        self.assertEqual(len(self.strip.calls), 1)


if __name__ == '__main__':
    unittest.main()
