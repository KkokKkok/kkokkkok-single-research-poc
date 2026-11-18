"""Load Grounding DINO once; one referring phrase per cue keeps provenance exact."""
import base64, contextlib, hashlib, io, json, os, sys

MODEL_ID='IDEA-Research/grounding-dino-tiny'
REVISION='a2bb814dd30d776dcf7e30523b00659f4f141c71'
# Loaded model, kept for the life of the process: a one-shot run loads it once, a resident worker
# (worker-server.py) reuses it across requests.
_LOADED=None

def load():
    global _LOADED
    if _LOADED is None:
        import torch
        from transformers import AutoProcessor,AutoModelForZeroShotObjectDetection
        torch.set_num_threads(min(4,os.cpu_count() or 1))
        processor=AutoProcessor.from_pretrained(MODEL_ID,revision=REVISION)
        model=AutoModelForZeroShotObjectDetection.from_pretrained(MODEL_ID,revision=REVISION,use_safetensors=True)
        model.config.disable_custom_kernels=True
        device='cuda' if torch.cuda.is_available() else 'cpu'
        model.to(device).eval()
        _LOADED=(processor,model,device)
    return _LOADED

# payload: {image: base64 JPEG, queries: [{cueId, query}], threshold?, textThreshold?}
# The two thresholds default to the values used until now (0.3 and 0.25).
def detect(payload):
    queries=payload['queries']
    if len(queries)>80 or any(not 3<=len(q['query'])<=160 for q in queries):
        raise ValueError('Invalid queries')
    threshold=float(payload.get('threshold',0.3)); text_threshold=float(payload.get('textThreshold',0.25))
    if not (0<threshold<1 and 0<text_threshold<1): raise ValueError('Invalid thresholds')
    raw=base64.b64decode(payload['image'],validate=True)
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from PIL import Image
        processor,model,device=load()
        image=Image.open(io.BytesIO(raw)).convert('RGB')
        requests=[]
        for i,q in enumerate(queries):
            inputs=processor(images=image,text=q['query'].strip().rstrip('.')+'.',return_tensors='pt').to(device)
            with torch.inference_mode(): out=model(**inputs)
            result=processor.post_process_grounded_object_detection(out,inputs.input_ids,threshold=threshold,text_threshold=text_threshold,target_sizes=[image.size[::-1]])[0]
            detections=[]
            for j,(box,score,label) in enumerate(zip(result['boxes'],result['scores'],result.get('text_labels',result.get('labels')))):
                b=[max(0,min(1,float(v)/s)) for v,s in zip(box.tolist(),image.size*2)]
                if b[2]>b[0] and b[3]>b[1]:
                    detections.append(dict(id=f'dino-{q["cueId"]}-{j}',bbox=b,score=float(score),label=str(label)))
            requests.append(dict(cueId=q['cueId'],query=q['query'],detections=detections))
    return dict(engine='Grounding DINO',model=MODEL_ID,revision=REVISION,imageSha256=hashlib.sha256(raw).hexdigest(),coordinateSpace='analysis-normalized',requests=requests)

def main():
    print(json.dumps(detect(json.loads(sys.stdin.buffer.read(16*1024*1024))),allow_nan=False))

if __name__=='__main__':
    try: main()
    except Exception:
        sys.stderr.write('Detector execution failed.\n');sys.exit(1)
