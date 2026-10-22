from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import patch

from core import ClientConfig, LlmClient, ValidationError, validate_model_chunk
from test_core import RESULT


def chunk_with(**atom_fields):
    value = copy.deepcopy(RESULT)
    value["atoms"][0].update(atom_fields)
    return value


class RegressionTests(unittest.TestCase):
    def test_cjk_quote_across_pdf_line_break_and_compatibility_forms(self):
        source = "⽔は標準気圧のもとで\n0度で凍る。"  # Kangxi radical for 水, wrapped line
        excerpt = "水は標準気圧のもとで0度で凍る。"
        validate_model_chunk(chunk_with(core=excerpt, sourceExcerpt=excerpt), source)

    def test_paraphrase_is_still_rejected_and_named(self):
        with self.assertRaisesRegex(ValidationError, "not found"):
            validate_model_chunk(chunk_with(sourceExcerpt="Ice melts at zero."), RESULT["atoms"][0]["core"])

    def test_limits_count_utf16_units_like_android(self):
        with self.assertRaises(ValidationError):
            validate_model_chunk(chunk_with(core="😀" * 260), "x")

    def test_huge_integer_difficulty_is_a_validation_error(self):
        with self.assertRaises(ValidationError):
            validate_model_chunk(chunk_with(difficulty=10 ** 400), RESULT["atoms"][0]["core"])

    def test_reads_json_wrapped_in_reasoning_prose_and_fences(self):
        client = LlmClient(ClientConfig("http://127.0.0.1:9/v1", "m", "").validate())
        body = json.dumps(RESULT)
        for content in (f"<think>plan {{draft}}</think>\n{body}", f"Here is the JSON:\n```json\n{body}\n```\nLet me know.", body):
            reply = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
            with patch.object(client, "request", return_value=reply):
                self.assertEqual(client.generate("source", "ja"), RESULT)


if __name__ == "__main__":
    unittest.main()
