#!/usr/bin/env python3
"""
Bubble CNN Classifier - uses a tiny ONNX MLP model to classify
bubble regions as filled or empty.

This is a drop-in replacement / complement for the threshold-based
bubble fill detection in layout_worker.py.

Usage:
    from bubble_cnn_classifier import BubbleCNNClassifier

    classifier = BubbleCNNClassifier()
    prob = classifier.predict(bubble_roi_28x28)  # returns 0.0-1.0
    is_filled, confidence = classifier.classify(roi_gray, cx, cy, radius)
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np

try:
    import onnxruntime as ort
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False


MODEL_DIR = Path(__file__).resolve().parent.parent / 'models' / 'bubble_cnn'
DEFAULT_MODEL_PATH = MODEL_DIR / 'bubble_cnn.onnx'
METADATA_PATH = MODEL_DIR / 'metadata.json'

# Cache for the ONNX session (lazy loaded, reused across calls)
_session = None
_session_input_size = 28


def _load_session(model_path=None):
    """Load the ONNX model and return a session."""
    global _session

    if _session is not None:
        return _session

    path = Path(model_path or DEFAULT_MODEL_PATH)
    if not path.exists():
        return None

    if not HAS_ONNX:
        return None

    try:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = 1
        _session = ort.InferenceSession(str(path), opts)
        return _session
    except Exception as exc:
        print(f"[bubble_cnn] Failed to load ONNX model: {exc}")
        return None


def _extract_roi(gray, cx, cy, radius, target_size=28):
    """Extract a normalized bubble ROI from the grayscale image.

    Returns a 28x28 float32 array (values 0.0-1.0), or None if the
    ROI falls outside the image.
    """
    h, w = gray.shape[:2]
    margin = int(round(radius * 1.8)) + 2
    margin = max(margin, target_size // 2 + 2)

    x1 = max(0, int(round(cx)) - margin)
    y1 = max(0, int(round(cy)) - margin)
    x2 = min(w, int(round(cx)) + margin + 1)
    y2 = min(h, int(round(cy)) + margin + 1)

    if x2 - x1 < 4 or y2 - y1 < 4:
        return None

    roi = gray[y1:y2, x1:x2].astype(np.float32)

    # Resize to target_size x target_size
    roi = cv2.resize(roi, (target_size, target_size), interpolation=cv2.INTER_AREA)

    # Normalize to [0, 1]
    roi = roi / 255.0

    return roi


def predict(gray, cx, cy, radius, model_path=None):
    """Predict probability that a bubble is filled.

    Args:
        gray: Full grayscale image (numpy array)
        cx, cy: Bubble center coordinates in image space
        radius: Bubble radius in pixels

    Returns:
        float: Probability (0.0 = definitely empty, 1.0 = definitely filled)
               Returns None if the model couldn't be loaded or ROI is invalid.
    """
    session = _load_session(model_path)
    if session is None:
        return None

    roi = _extract_roi(gray, cx, cy, radius)
    if roi is None:
        return None

    # ONNX input: (1, 1, 28, 28)
    input_tensor = roi[np.newaxis, np.newaxis, :, :].astype(np.float32)

    try:
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        result = session.run([output_name], {input_name: input_tensor})
        prob = float(result[0][0, 0])
        return prob
    except Exception as exc:
        print(f"[bubble_cnn] Inference error: {exc}")
        return None


def classify(gray, cx, cy, radius, threshold=0.5, model_path=None):
    """Classify a bubble as filled or empty.

    Args:
        gray: Full grayscale image
        cx, cy: Bubble center
        radius: Bubble radius
        threshold: Probability threshold (default 0.5)
        model_path: Optional path to ONNX model

    Returns:
        dict with keys:
            filled: bool
            probability: float (0-1)
            model_available: bool
    """
    prob = predict(gray, cx, cy, radius, model_path)

    if prob is None:
        return {
            'filled': None,
            'probability': None,
            'model_available': False,
        }

    return {
        'filled': prob >= threshold,
        'probability': prob,
        'model_available': True,
    }


def classify_contour_darkness_fused(gray, cx, cy, radius, contour_darkness,
                                     model_weight=0.4, threshold=0.5, model_path=None):
    """Fuse the CNN prediction with the traditional contour-based darkness score.

    Args:
        gray: Full grayscale image
        cx, cy: Bubble center
        radius: Bubble radius
        contour_darkness: Traditional darkness score (0-1)
        model_weight: How much weight to give the model (0 = only traditional)
        threshold: Decision threshold

    Returns:
        dict with keys: filled, fused_score, model_prob, contour_darkness
    """
    model_prob = predict(gray, cx, cy, radius, model_path)

    if model_prob is None:
        # Fall back to contour darkness only
        return {
            'filled': contour_darkness >= threshold,
            'fused_score': contour_darkness,
            'model_prob': None,
            'contour_darkness': contour_darkness,
            'model_available': False,
        }

    # Fuse: weighted average
    fused = model_weight * model_prob + (1.0 - model_weight) * contour_darkness

    return {
        'filled': fused >= threshold,
        'fused_score': round(fused, 4),
        'model_prob': round(model_prob, 4),
        'contour_darkness': round(contour_darkness, 4),
        'model_available': True,
    }


def is_model_available(model_path=None):
    """Check if the ONNX model is available and loadable."""
    session = _load_session(model_path)
    return session is not None


def get_model_info():
    """Return model metadata."""
    path = METADATA_PATH
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {'error': 'metadata not found'}


# ---------------------------------------------------------------------------
# Integration helper for use inside layout_worker.py
# ---------------------------------------------------------------------------

def apply_cnn_to_detected_bubbles(detected_bubbles, gray, threshold=0.5, model_path=None):
    """Run CNN classification on all detected bubbles and return updated list.

    Each bubble dict gets additional keys:
        cnnProbability: float or None
        cnnFilled: bool or None
        cnnAvailable: bool
    """
    if not detected_bubbles or not isinstance(detected_bubbles, list):
        return detected_bubbles

    updated = []
    for bubble in detected_bubbles:
        cx = float(bubble.get('x', 0))
        cy = float(bubble.get('y', 0))
        radius = float(bubble.get('radius', 8))

        result = classify(gray, cx, cy, radius, threshold=threshold, model_path=model_path)

        updated_bubble = dict(bubble)
        updated_bubble['cnnProbability'] = result.get('probability')
        updated_bubble['cnnFilled'] = result.get('filled')
        updated_bubble['cnnAvailable'] = result.get('model_available', False)
        updated.append(updated_bubble)

    return updated


def get_cnn_fused_darkness(gray, cx, cy, radius, contour_darkness, model_path=None):
    """Get a fused darkness score combining CNN and contour methods."""
    result = classify_contour_darkness_fused(
        gray, cx, cy, radius, contour_darkness,
        model_weight=0.4, model_path=model_path
    )
    return result.get('fused_score', contour_darkness)


if __name__ == '__main__':
    # Quick self-test
    print(f"Model directory: {MODEL_DIR}")
    print(f"Model available: {is_model_available()}")
    if is_model_available():
        info = get_model_info()
        print(f"Model info: {info}")

        # Generate a test bubble
        print("\nTesting with synthetic bubbles...")
        from train_bubble_cnn import generate_bubble_sample

        for i in range(5):
            img, label = generate_bubble_sample(28)
            # Convert to "gray" image with the bubble in the center
            full_gray = np.ones((100, 100), dtype=np.float32) * 0.95
            y_off = (100 - 28) // 2
            x_off = (100 - 28) // 2
            full_gray[y_off:y_off+28, x_off:x_off+28] = img
            full_gray = (full_gray * 255).astype(np.uint8)

            cx, cy = 50, 50
            radius = 10
            prob = predict(full_gray, cx, cy, radius)
            print(f"  Sample {i+1}: label={'filled' if label else 'empty':8s} "
                  f"pred_prob={prob:.4f} {'✅' if (prob >= 0.5) == bool(label) else '❌'}")
