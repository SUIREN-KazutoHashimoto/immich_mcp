"""Regenerate independent encoded-image test data; requires Pillow only here."""
from pathlib import Path
from io import BytesIO
import base64, hashlib, json
from PIL import Image, __version__ as pillow_version

entries = []
colors = [(220, 35, 50), (30, 90, 220), (25, 180, 65)]
for index, color in enumerate(colors):
    image = Image.new("RGB", (64, 32), color)
    for format, mime, options in [
        ("JPEG", "image/jpeg", {"quality": 85, "progressive": True}),
        ("WEBP", "image/webp", {"quality": 85}),
    ]:
        sink = BytesIO()
        image.save(sink, format=format, **options)
        data = sink.getvalue()
        entries.append({"id": f"color_{index}_{format.lower()}", "mime": mime,
                        "width": 64, "height": 32, "center_rgb": color,
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "base64": base64.b64encode(data).decode("ascii")})
target = Path(__file__).resolve().parents[1] / "tests" / "profile-image-oracle.json"
target.write_text(json.dumps({"format": "immich-mcp-profile-image-oracle", "version": 1,
                             "producer": f"Python Pillow {pillow_version}",
                             "evidence_scope": "Independent encoder data, not actual Immich output",
                             "entries": entries}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"target": str(target), "entries": len(entries), "producer": pillow_version}))
