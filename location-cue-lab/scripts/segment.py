"""Segment Anything: one mask per box. The boxes come from the detector; no text is involved here.

NOT part of the paper, and nothing here checks that a mask shows what a clue describes: SAM cuts out
whatever stands out inside the box it is given.

payload: {image: base64 JPEG, boxes: [{id, bbox: [x0,y0,x1,y1] normalized}], maskSide?}
answer:  {engine, model, revision, imageSha256, coordinateSpace, masks: [{id, score, size: [h, w], counts}], timing}
  counts: run lengths over the mask read row by row, starting with a run of 0s (which may be empty).
  The mask is reduced so that its longer side is maskSide (default 256); it covers the whole photo.
"""
import base64, contextlib, hashlib, io, json, os, sys, time

MODEL_ID=os.environ.get('KKOK_SAM_MODEL','facebook/sam-vit-base')
_LOADED=None

def load():
    global _LOADED
    if _LOADED is None:
        import torch
        from transformers import SamModel,SamProcessor
        torch.set_num_threads(min(4,os.cpu_count() or 1))
        processor=SamProcessor.from_pretrained(MODEL_ID)
        model=SamModel.from_pretrained(MODEL_ID)
        device='cuda' if torch.cuda.is_available() else 'cpu'
        model.to(device).eval()
        _LOADED=(processor,model,device)
    return _LOADED

def run_lengths(mask):
    import numpy as np
    flat=mask.reshape(-1).astype(np.uint8)
    changes=np.flatnonzero(flat[1:]!=flat[:-1])+1
    runs=np.diff(np.concatenate(([0],changes,[flat.size]))).tolist()
    return ([0]+runs) if flat[0] else runs

def segment(payload):
    boxes=payload['boxes']
    if not 0<len(boxes)<=200 or any(len(b['bbox'])!=4 or not (0<=b['bbox'][0]<b['bbox'][2]<=1 and 0<=b['bbox'][1]<b['bbox'][3]<=1) for b in boxes):
        raise ValueError('Invalid boxes')
    side=int(payload.get('maskSide',256))
    if not 32<=side<=1024: raise ValueError('Invalid maskSide')
    raw=base64.b64decode(payload['image'],validate=True)
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from PIL import Image
        started=time.perf_counter()
        processor,model,device=load()
        loaded=time.perf_counter()
        image=Image.open(io.BytesIO(raw)).convert('RGB')
        width,height=image.size
        pixel_boxes=[[b['bbox'][0]*width,b['bbox'][1]*height,b['bbox'][2]*width,b['bbox'][3]*height] for b in boxes]
        inputs=processor(image,input_boxes=[pixel_boxes],return_tensors='pt').to(device)
        with torch.inference_mode():
            embeddings=model.get_image_embeddings(inputs['pixel_values'])
            encoded=time.perf_counter()
            out=model(image_embeddings=embeddings,input_boxes=inputs['input_boxes'],multimask_output=False)
        masks=processor.image_processor.post_process_masks(out.pred_masks.cpu(),inputs['original_sizes'].cpu(),inputs['reshaped_input_sizes'].cpu())[0]
        scores=out.iou_scores.cpu()[0]
        scale=side/max(width,height)
        size=(max(1,round(height*scale)),max(1,round(width*scale)))
        small=torch.nn.functional.interpolate(masks.float(),size=size,mode='bilinear',align_corners=False)[:,0]>0.5
        result=[dict(id=b['id'],score=max(0.0,min(1.0,float(scores[i,0]))),size=list(size),counts=run_lengths(small[i].numpy())) for i,b in enumerate(boxes)]
        done=time.perf_counter()
    ms=lambda a,b:round((b-a)*1000)
    return dict(engine='Segment Anything',model=MODEL_ID,revision=getattr(model.config,'_commit_hash',None),imageSha256=hashlib.sha256(raw).hexdigest(),coordinateSpace='analysis-normalized',
        masks=result,timing=dict(loadMs=ms(started,loaded),encodeMs=ms(loaded,encoded),maskMs=ms(encoded,done),imageSize=[width,height],boxes=len(boxes),device=device))

def main():
    print(json.dumps(segment(json.loads(sys.stdin.buffer.read(16*1024*1024))),allow_nan=False))

if __name__=='__main__':
    try: main()
    except Exception:
        sys.stderr.write('Segmenter execution failed.\n');sys.exit(1)
