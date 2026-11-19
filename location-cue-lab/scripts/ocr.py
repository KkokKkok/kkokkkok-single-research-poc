"""Read a normalized analysis JPEG from stdin; emit only bounded JSON on stdout."""
import contextlib
import io
import json
import os
import sys
from importlib.metadata import version

# Settings, each from an environment variable so a measurement can vary them without editing this file.
# Unset means the value used until 2026-11-16 (PaddleOCR's own default where None).
#   KKOK_OCR_LANGS                  recognition models to run, comma separated; lines of all are merged
#   KKOK_OCR_TEXTLINE_ORIENTATION   1 turns each text line upright before reading it
#   KKOK_OCR_DET_THRESH             pixel threshold of the text detector (PaddleOCR default 0.3)
#   KKOK_OCR_DET_BOX_THRESH         box threshold of the text detector (PaddleOCR default 0.6)
#   KKOK_OCR_DET_LIMIT_SIDE / KKOK_OCR_DET_LIMIT_TYPE
#                                   with type "min", the image is enlarged until its shorter side is
#                                   at least this many pixels before detection
#   KKOK_OCR_TILES                  "all" also reads the photo in overlapping 1,024 px tiles, as until
#                                   2026-11-19. Unset, the photo is read once, whole: a tile takes as
#                                   long as it does with or without text in it (about 10 s on CPU, 12
#                                   tiles for a 2,304 x 3,072 photo), and on the photo
#                                   measured the tiles linked no clue the whole-photo pass had missed.
# A resident worker (worker-server.py) passes the same names per request in `overrides`; those win over
# the environment, so one running worker can serve measurements with different settings.
def settings(overrides=None):
    def read(name, default=""):
        value = (overrides or {}).get(name)
        return str(value) if value is not None else os.environ.get(name, default)
    def number(name, cast):
        value = read(name).strip()
        return cast(value) if value else None
    langs = [lang.strip() for lang in read("KKOK_OCR_LANGS", "korean").split(",") if lang.strip()] or ["korean"]
    options = {"use_textline_orientation": read("KKOK_OCR_TEXTLINE_ORIENTATION") == "1"}
    for key, name, cast in [("text_det_thresh", "KKOK_OCR_DET_THRESH", float), ("text_det_box_thresh", "KKOK_OCR_DET_BOX_THRESH", float),
                            ("text_det_limit_side_len", "KKOK_OCR_DET_LIMIT_SIDE", int)]:
        value = number(name, cast)
        if value is not None: options[key] = value
    limit_type = read("KKOK_OCR_DET_LIMIT_TYPE").strip()
    if limit_type in ("min", "max"): options["text_det_limit_type"] = limit_type
    return langs, options, read("KKOK_OCR_TILES").strip().lower() == "all"

# Loaded models, kept for the life of the process. A one-shot run loads each once, as before; a resident
# worker reuses them across requests.
_MODELS = {}

def extract(content, overrides=None):
    langs, options, tiled = settings(overrides)
    # Paddle logs can contain recognition output: discard instead of forwarding.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        import numpy as np
        from PIL import Image
        from paddleocr import PaddleOCR
        image = Image.open(io.BytesIO(content)).convert("RGB")
        width, height = image.size
        def load(lang):
            key = (lang, json.dumps(options, sort_keys=True))
            if key not in _MODELS:
                _MODELS[key] = PaddleOCR(lang=lang, ocr_version="PP-OCRv5", device="cpu",
                    use_doc_orientation_classify=False, use_doc_unwarping=False, **options)
            return _MODELS[key]
        models = [(lang, load(lang)) for lang in langs]
        areas = [("full", 0, 0, image)]
        size, stride = 1024, 819
        def starts(length):
            return sorted(set(list(range(0, max(1, length-size+1), stride)) + [max(0, length-size)]))
        if tiled and (width > size or height > size):
            for y in starts(height):
                for x in starts(width):
                    areas.append((f"tile-{x}-{y}", x, y, image.crop((x,y,min(width,x+size),min(height,y+size)))))
        # One pass per area and recognition model. With one model the pass ids are the area names, as before.
        passes = [(name if len(models)==1 else f"{name}@{lang}", x, y, crop, model) for name,x,y,crop in areas for lang,model in models]
        lines, raw, unread, pass_info = [], [], [], []
        def polygon(points, x, y):
            return [[max(0,min(1,(float(px)+x)/width)),max(0,min(1,(float(py)+y)/height))] for px,py in points]
        def overlap(a,b):
            ax=[p[0] for p in a]; ay=[p[1] for p in a]; bx=[p[0] for p in b]; by=[p[1] for p in b]
            inter=max(0,min(max(ax),max(bx))-max(min(ax),min(bx)))*max(0,min(max(ay),max(by))-max(min(ay),min(by)))
            union=(max(ax)-min(ax))*(max(ay)-min(ay))+(max(bx)-min(bx))*(max(by)-min(by))-inter
            return inter/union if union else 0
        for name,x,y,crop,model in passes:
            results=list(model.predict(np.array(crop)[:,:,::-1]))
            if len(results)!=1: raise ValueError("Expected one result")
            data=results[0].json["res"]
            texts,scores,polys=data["rec_texts"],data["rec_scores"],data["rec_polys"]
            if not len(texts)==len(scores)==len(polys): raise ValueError("Invalid results")
            pass_info.append({"id":name,"x":x,"y":y,"width":crop.width,"height":crop.height,"count":len(texts)})
            recognized=[]
            for text,score,points in zip(texts,scores,polys):
                poly=polygon(points,x,y)
                entry={"text":str(text),"score":float(score),"polygon":poly,"passId":name}
                raw.append(entry)
                if not str(text).strip():
                    unread.append({"polygon":poly,"passId":name}); continue
                recognized.append(poly)
                duplicate=next((line for line in lines if line["text"].replace(" ","")==str(text).replace(" ","") and overlap(line["polygon"],poly)>.6),None)
                if duplicate:
                    if score>duplicate["score"]: duplicate.update(entry)
                else: lines.append(entry)
            for points in data.get("dt_polys",[]):
                poly=polygon(points,x,y)
                if not any(overlap(poly,r)>.5 for r in recognized): unread.append({"polygon":poly,"passId":name})
        conflicts=[]
        for i,line in enumerate(lines):
            for j in range(i):
                if line["text"].replace(" ","")!=lines[j]["text"].replace(" ","") and overlap(line["polygon"],lines[j]["polygon"])>.6:
                    conflicts.append([f"ocr-{j}",f"ocr-{i}"])
        if len(lines)>500 or len(raw)>4000 or len(unread)>4000: raise ValueError("OCR result limit exceeded")
    return {"engine":"PaddleOCR","version":version("paddleocr"),"coordinateSpace":"analysis-normalized",
        "lines":[{"id":f"ocr-{i}",**line} for i,line in enumerate(lines)],
        "diagnostics":{"version":"tiled-v1","settings":{"langs":langs,**options,"tiles":tiled},"inputWidth":width,"inputHeight":height,"passes":pass_info,"rawReadings":raw,"unreadRegions":unread,"conflicts":conflicts}}

if __name__ == "__main__":
    try:
        content = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise ValueError("Too large")
        result = extract(content)
        sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False))
    except Exception as error:
        sys.stderr.write("OCR execution failed; check local runtime and model installation.\n")
        # Read by adapters.mjs for the server's error log. An exception here comes from loading a model,
        # decoding the image, the inference engine or a limit above; none of them carries text read
        # from the photo (that only ever goes to stdout).
        sys.stderr.write("KKOK_ERROR " + " ".join(f"{type(error).__name__}: {error}".split())[:300] + "\n")
        sys.exit(1)
