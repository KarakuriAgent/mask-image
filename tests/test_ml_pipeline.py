import unittest

from server.ml_pipeline import NullPipeline


class NullPipelineTest(unittest.TestCase):
    def test_detect_returns_no_instances_without_ml_backend(self):
        pipeline = NullPipeline()
        self.assertEqual(pipeline.detect(b"image", 10, 10, "person", 0.3), [])

    def test_segment_box_falls_back_to_rectangle_mask(self):
        pipeline = NullPipeline()
        detection = pipeline.segment_box(b"image", 10, 10, {"x": 2, "y": 3, "width": 4, "height": 2})
        payload = detection.to_json("manual", 10, 10)
        self.assertEqual(payload["bbox"], {"x": 2, "y": 3, "width": 4, "height": 2})
        self.assertEqual(sum(detection.mask), 8)


if __name__ == "__main__":
    unittest.main()
