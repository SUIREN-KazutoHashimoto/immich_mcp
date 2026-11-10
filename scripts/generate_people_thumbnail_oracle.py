"""Frozen, independently JPEG-encoded images for the synthetic people HTTP model.

These prove decoder/frame and changed/stable-byte assertions only. They are
not evidence of Immich's crop pixels or ML inference. No production dependency.
"""
from pathlib import Path
from io import BytesIO
import base64, hashlib, json
import PIL
from PIL import Image

variants = {}
for index, name in enumerate(["people_a1", "people_a2", "people_b1"]):
    image = Image.new("RGB", (22, 22))
    image.putdata([((x * 7 + index * 83) % 256,
                    (y * 11 + index * 37) % 256,
                    (x * 3 + y * 5 + index * 61) % 256)
                   for y in range(22) for x in range(22)])
    out = BytesIO()
    image.save(out, format="JPEG", quality=85, subsampling=0, progressive=False)
    raw = out.getvalue()
    variants[name] = {"mime": "image/jpeg", "width": 22, "height": 22,
                      "sha256": hashlib.sha256(raw).hexdigest(),
                      "base64": base64.b64encode(raw).decode("ascii")}
target = Path(__file__).resolve().parent.parent / "tests" / "people-thumbnail-oracle.json"
target.write_text(json.dumps({"format": "immich-mcp-people-thumbnail-test-oracle",
    "version": 1, "encoder": "Pillow " + PIL.__version__,
    "scope": "synthetic_harness_frame_and_byte_changes_not_upstream_crop_or_inference",
    "variants": variants}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"images": len(variants), "encoder": PIL.__version__}))
