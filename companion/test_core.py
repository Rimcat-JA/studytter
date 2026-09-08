from __future__ import annotations

import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock

from core import BuildSession, CancelledError, Chunk, ClientConfig, LlmClient, ValidationError, export_package, normalize_base_url, read_material, validate_model_chunk, validate_package, validate_quiz

SOURCE = "Water freezes at zero degrees Celsius under standard pressure."
RESULT = {"atoms": [{"topicLabel": "Water", "kind": "fact", "difficulty": 0, "core": SOURCE, "sourceExcerpt": SOURCE,
                     "posts": [{"format": "explainer", "text": SOURCE}, {"format": "quiz", "text": "When does water freeze?",
                                "quiz": {"question": "At standard pressure, water freezes at?", "choices": ["0 °C", "20 °C"], "answerIndex": 0, "answerText": "0 °C", "explanation": SOURCE}}]}]}


class FixtureHandler(BaseHTTPRequestHandler):
    requests = []
    status = 200
    response = RESULT

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.requests.append((self.path, dict(self.headers), None))
        self.send({"data": [{"id": "fixture-model"}]})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append((self.path, dict(self.headers), payload))
        self.send({"choices": [{"message": {"content": json.dumps(self.response)}, "finish_reason": "stop"}]})

    def send(self, body):
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


class CompanionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def setUp(self):
        FixtureHandler.requests = []
        FixtureHandler.status = 200
        FixtureHandler.response = RESULT
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "source.txt"
        self.path.write_text(SOURCE, encoding="utf-8")
        self.cancel = threading.Event()

    def session(self):
        return BuildSession([self.path], "Water study", "en", self.cancel)

    def client(self):
        return LlmClient(ClientConfig(self.base_url, "fixture-model", "fixture-private-key"))

    def test_http_to_validated_android_export(self):
        client = self.client()
        self.assertEqual(client.models(), ["fixture-model"])
        session = self.session()
        package = session.run(client, self.cancel, lambda *_: None)
        output = Path(self.temp.name) / "learning.json"
        export_package(package, output)
        validate_package(json.loads(output.read_text(encoding="utf-8")))
        self.assertEqual(len(package["posts"]), 2)
        self.assertEqual(package["atoms"][0]["sourceExcerpt"], SOURCE)
        self.assertEqual(FixtureHandler.requests[-1][0], "/v1/chat/completions")
        self.assertEqual(FixtureHandler.requests[-1][1]["Authorization"], "Bearer fixture-private-key")
        self.assertNotIn("fixture-private-key", output.read_text(encoding="utf-8"))
        self.assertNotIn(self.base_url, output.read_text(encoding="utf-8"))

    def test_invalid_or_hallucinated_model_output_never_mutates_package(self):
        invalid = copy.deepcopy(RESULT)
        invalid["atoms"][0]["posts"][1]["quiz"]["answerIndex"] = 2
        client = Mock()
        client.generate.return_value = invalid
        session = self.session()
        with self.assertRaisesRegex(ValidationError, "answerIndex"):
            session.run(client, self.cancel, lambda *_: None)
        self.assertEqual(session.next_chunk, 0)
        self.assertEqual(session.package["posts"], [])
        self.assertEqual(client.generate.call_count, 2)
        invented = copy.deepcopy(RESULT)
        invented["atoms"][0]["sourceExcerpt"] = "The source never says this."
        with self.assertRaisesRegex(ValidationError, "exact passage"):
            validate_model_chunk(invented, SOURCE)

    def test_resume_retains_completed_chunks_and_package_identity(self):
        session = self.session()
        session.chunks.append(Chunk(session.chunks[0].material_id, "second", SOURCE))
        client = Mock()
        client.generate.side_effect = [copy.deepcopy(RESULT), RuntimeError("server unavailable")]
        with self.assertRaises(RuntimeError):
            session.run(client, self.cancel, lambda *_: None)
        package_id = session.package["packageId"]
        first_post_id = session.package["posts"][0]["id"]
        self.assertEqual(session.next_chunk, 1)
        client.generate.side_effect = None
        client.generate.return_value = copy.deepcopy(RESULT)
        session.run(client, self.cancel, lambda *_: None)
        self.assertTrue(session.complete)
        self.assertEqual(session.package["packageId"], package_id)
        self.assertEqual(session.package["posts"][0]["id"], first_post_id)
        self.assertEqual(len(session.package["atoms"]), 1)  # repeated source facts deduplicated

    def test_cancellation_does_not_accept_inflight_result(self):
        session = self.session()
        client = Mock()
        def response(*_):
            self.cancel.set()
            return RESULT
        client.generate.side_effect = response
        with self.assertRaises(CancelledError):
            session.run(client, self.cancel, lambda *_: None)
        self.assertEqual(session.next_chunk, 0)
        self.assertEqual(session.package["atoms"], [])

    def test_invalid_export_preserves_existing_file(self):
        package = self.session().run(self.client(), self.cancel, lambda *_: None)
        package["posts"][0]["atomId"] = "missing"
        output = Path(self.temp.name) / "existing.json"
        output.write_text("preserve", encoding="utf-8")
        with self.assertRaises(ValidationError):
            export_package(package, output)
        self.assertEqual(output.read_text(), "preserve")
        self.assertEqual(list(Path(self.temp.name).glob("*.tmp")), [])

    def test_real_cli_fixture_smoke(self):
        output = Path(self.temp.name) / "cli.json"
        result = subprocess.run([sys.executable, "app.py", "--headless", "--input", str(self.path), "--subject", "Water", "--language", "en", "--base-url", self.base_url, "--model", "fixture-model", "--output", str(output)], cwd=Path(__file__).parent, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        validate_package(json.loads(output.read_text(encoding="utf-8")))

    def test_scanned_or_blank_pdf_needs_ocr(self):
        from pypdf import PdfWriter
        path = Path(self.temp.name) / "blank.pdf"
        writer = PdfWriter()
        writer.add_blank_page(600, 800)
        writer.write(path)
        with self.assertRaisesRegex(ValueError, "OCR"):
            read_material(path, self.cancel)

    def test_auth_error_is_actionable_without_response_leak(self):
        FixtureHandler.status = 401
        with self.assertRaisesRegex(RuntimeError, "API key") as context:
            self.client().models()
        self.assertNotIn("fixture-private-key", str(context.exception))

    def test_quiz_and_endpoint_boundaries(self):
        quiz = copy.deepcopy(RESULT["atoms"][0]["posts"][1]["quiz"])
        quiz["choices"] = ["same", " same "]
        with self.assertRaises(ValidationError):
            validate_quiz(quiz)
        for value in ("https://user:key@example.com/v1", "https://example.com/v1?key=secret", "file:///etc/passwd", "http://localhost/v1/chat/completions"):
            with self.assertRaises(ValueError):
                normalize_base_url(value)


if __name__ == "__main__":
    unittest.main()
