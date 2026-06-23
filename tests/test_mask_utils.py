import base64
import unittest

from server.mask_utils import (
    bbox_from_mask,
    data_url_to_bytes,
    decode_rle,
    encode_rle,
    normalize_box,
    rect_mask,
)


class MaskUtilsTest(unittest.TestCase):
    def test_rle_round_trip(self):
        mask = [0, 1, 1, 0, 0, 1]
        self.assertEqual(decode_rle(encode_rle(mask), 3, 2), mask)

    def test_rect_mask_and_bbox(self):
        box = normalize_box({"x": 1.2, "y": 1.1, "width": 2.2, "height": 1.8}, 5, 5)
        mask = rect_mask(5, 5, box)
        self.assertEqual(sum(mask), 6)
        self.assertEqual(bbox_from_mask(mask, 5, 5), box)

    def test_data_url_to_bytes(self):
        raw = b"hello"
        data_url = "data:text/plain;base64," + base64.b64encode(raw).decode("ascii")
        self.assertEqual(data_url_to_bytes(data_url), raw)

    def test_data_url_rejects_non_data_url(self):
        with self.assertRaises(ValueError):
            data_url_to_bytes("hello")


if __name__ == "__main__":
    unittest.main()
